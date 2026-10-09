/**
 * 贝壳 MCP 客户端。
 *
 * 职责：安全地以子进程方式调用官方 `beike` CLI，并返回解析后的结果。
 *
 * 架构说明（为什么走 CLI 而不是直接 HTTP）：
 *   贝壳 AI 开放平台的接口是 MCP（Model Context Protocol）形态。
 *   官方提供的接入方式是 CLI 工具 —— 它负责 MCP 握手、认证、
 *   单行 JSON 输出等细节。本项目把 CLI 当作本地 MCP 客户端使用，
 *   这样既符合官方接入方式，又不需要自己实现 MCP 协议栈。
 *
 * 安全设计（重要）：
 *   1. API Key 通过**子进程环境变量**注入，不经过命令行参数 ——
 *      命令行参数在 Windows 上会出现在进程列表里，任何本机进程都能看到。
 *   2. 所有错误信息与日志都经过 sanitize()，确保 Key 不会泄漏。
 *   3. 超时强制杀进程，避免 CLI 挂起导致请求堆积。
 *   4. 并发限制：CLI 启动有开销（约 200ms），限制并发避免拖垮机器。
 */

import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BeikeResponseParser, type ParsedBeikeResponse } from './beike-response-parser.js';
import { BeikeDirectClient } from './beike-direct-client.js';
import { BeikeRateLimiter } from './beike-rate-limiter.service.js';
import type { BeikeUsageStats } from './beike-usage-stats.service.js';
import type { BeikeQuotaGuard } from './beike-quota-guard.service.js';
import type { AppConfig } from '../../../../config/configuration.js';

/** CLI 调用失败 */
export class BeikeCliError extends Error {
  readonly code = 'BEIKE_CLI_FAILED';

  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'BeikeCliError';
  }

  /**
   * 判断是否为「服务端不可达」类错误。
   *
   * 这类错误必须与业务错误区分对待：
   *   - 服务端不可达 → 属于**临时性外部依赖故障**，应返回 503 + BEIKE_UNAVAILABLE，
   *     前端提示「贝壳房源暂时无法查询」并提供「重新查询房源」按钮，
   *     而不是把 500 内部错误暴露给用户、也不该让用户重新走一遍 AI 解析。
   *   - 业务错误（参数错、无权限）→ 重试无意义。
   */
  get isUnavailable(): boolean {
    const text = `${this.message} ${this.stderr}`;
    return (
      text.includes('请求贝壳 MCP 失败') ||
      text.includes('tcp connect error') ||
      text.includes('os error 10060') ||
      text.includes('error sending request') ||
      text.includes('temporarily unavailable') ||
      text.includes('service unavailable') ||
      text.includes('ETIMEDOUT') ||
      text.includes('ECONNRESET') ||
      text.includes('ENOTFOUND')
    );
  }

  /**
   * 服务端繁忙/临时故障 —— 可重试。
   *
   * 与"参数错误"的区别：参数错误重试一万次也没用，
   * 而 service temporarily unavailable 等一两秒往往就好了。
   */
  get isServiceBusy(): boolean {
    const text = `${this.message} ${this.stderr}`;
    return /temporarily unavailable|service unavailable|busy|too many requests|rate limit/i.test(
      text,
    );
  }
}

/** 凭证未配置 */
export class BeikeNotConfiguredError extends Error {
  readonly code = 'BEIKE_NOT_CONFIGURED';

  constructor(message: string) {
    super(message);
    this.name = 'BeikeNotConfiguredError';
  }
}

/** CLI 二进制缺失 */
export class BeikeCliMissingError extends Error {
  readonly code = 'BEIKE_CLI_MISSING';

  constructor(readonly expectedPath: string) {
    super(
      `未找到贝壳 CLI（期望路径：${expectedPath}）。` +
        `请运行 infrastructure/beike/install-cli.ps1 安装，或用 BEIKE_CLI_PATH 指定路径。`,
    );
    this.name = 'BeikeCliMissingError';
  }
}

/** 调用参数 */
export interface BeikeCliInvokeOptions {
  /** 子命令参数数组，如 ['buy', 'search', '-c', '上海', '-q', '浦东三房', '--json'] */
  args: string[];
  /** 超时（毫秒） */
  timeoutMs?: number;
  /**
   * 最大尝试次数。默认 5。
   *
   * 为什么默认这么高：贝壳的数据服务会出现"整体不可用"（实测所有查询工具
   * 同时返回 service temporarily unavailable），但**多数情况下几次重试内会恢复**。
   * 对经纪人来说，多等几秒拿到真实房源，远好过立刻看到"查不到房源"。
   *
   * 注意：不同调用会覆盖这个值（搜索 4 次、详情 2 次），
   * 因为详情要逐套调用，累积等待成本远高于搜索。
   */
  maxAttempts?: number;
  /**
   * 退避基数（毫秒）。默认 1200。
   *
   * 退避公式：min(12000, base × 2^(n-1)) + 抖动。
   * 搜索场景传较小的值（500）以控制总耗时。
   */
  retryBaseDelayMs?: number;
}

/** 调用结果 */
export interface BeikeCliResult {
  /** 解析后的结构化结果 */
  parsed: ParsedBeikeResponse;
  /** 原始 stdout */
  stdout: string;
  /** 耗时 */
  durationMs: number;
}

@Injectable()
export class BeikeMcpClient {
  private readonly logger = new Logger(BeikeMcpClient.name);
  private readonly parser = new BeikeResponseParser();
  private readonly cliPath: string;
  private readonly apiKey: string | undefined;

  /**
   * 直连 HTTP MCP 客户端（Phase 13）。
   *
   * 为什么加它：诊断确认 CLI 路径有三个硬问题 ——
   *   1. 不发送 `X-Beike-Cli-Version` 头（服务端会因此拒绝请求）
   *   2. 把服务端的所有错误统一压成 "service temporarily unavailable"，
   *      看不到真实原因（版本？鉴权？限流？）
   *   3. 依赖 Rust 二进制 + 子进程，有 spawn 开销与平台差异
   *
   * 直连后这三点都解决：请求头完全可控、错误原样透出、无子进程。
   * CLI 路径**保留**作为兜底（`BEIKE_TRANSPORT=cli` 可强制走它）。
   */
  private readonly directClient: BeikeDirectClient | null;

  /**
   * 传输模式。
   *   'http' → 只用直连 HTTP
   *   'cli'  → 只用 CLI 子进程
   *   'auto' → 优先 HTTP；HTTP 不可用时自动回退 CLI（默认）
   */
  private readonly transport: 'http' | 'cli' | 'auto';

  /**
   * 调用节流器。
   *
   * 为什么直连与 CLI 共用同一个节流器：贝壳的限流是按**账号/Key**计的，
   * 两条传输路径打的是同一个服务、同一个配额，
   * 因此必须共用限流状态，否则分别限流等于没限。
   */
  private readonly rateLimiter = new BeikeRateLimiter();

  /** 当前进行中的调用数，用于并发限制 */
  private activeCalls = 0;
  /** 最大并发：CLI 是独立进程，过多会拖垮机器 */
  private readonly maxConcurrent = 4;
  /** 默认超时：房源查询通常 3～10 秒，给足余量 */
  private readonly defaultTimeoutMs = 45_000;

  /**
   * 默认最大尝试次数。
   *
   * 实测：贝壳服务端整体不可用时，单次调用约 1～2 秒就返回失败。
   * 5 次尝试的退避总时长约 1.2 + 2.4 + 4.8 + 9.6 ≈ 18 秒，
   * 加上网络耗时约 25 秒 —— 与需求文档要求的"全流程 10～30 秒"基本吻合。
   * 多数服务抖动会在这段时间内恢复。
   */
  private readonly defaultMaxAttempts = 5;

  /**
   * 熔断状态（Phase 12 性能修复）。
   *
   * 为什么需要：贝壳服务"整体不可用"时，每个请求都要经历
   * `maxAttempts` 次尝试 + 指数退避，实测单次搜索耗 12 秒、
   * 详情补全更是能拖到 45 秒。
   *
   * 而**一旦确认不可用，再试也是白试** —— 真正有价值的重试只有第一次。
   *
   * 策略：
   *   - 判定不可用后，在冷却窗口内**直接快速失败**（不 spawn CLI 进程）
   *   - 冷却结束后允许下一次真实尝试（这样服务恢复能自动被感知）
   *
   * 为什么不用固定长时间熔断（如 5 分钟）：贝壳的抖动可能是秒级的，
   * 冷却太长会让"已经恢复"的场景白白等很久。60 秒是权衡值。
   */
  private unavailableUntil: number | null = null;

  /** 熔断冷却时长（毫秒） */
  private readonly circuitCooldownMs = 60_000;

  constructor(private readonly config: AppConfig) {
    // CLI 路径解析优先级：环境变量 > 项目基础设施目录
    const configuredPath = process.env.BEIKE_CLI_PATH?.trim();
    const projectPath = path.resolve(
      process.cwd(),
      '..',
      '..',
      'infrastructure',
      'beike',
      'bin',
      process.platform === 'win32' ? 'beike.exe' : 'beike',
    );

    this.cliPath = configuredPath && configuredPath.length > 0 ? configuredPath : projectPath;

    // 凭证优先取环境变量 —— 这样密钥不需要落盘
    this.apiKey = process.env.BEIKE_MCP_API_KEY?.trim() || undefined;

    // ---- 传输模式（Phase 13）----
    const configuredTransport = (process.env.BEIKE_TRANSPORT ?? 'auto').trim().toLowerCase();
    this.transport =
      configuredTransport === 'http' || configuredTransport === 'cli'
        ? configuredTransport
        : 'auto';

    // 直连客户端：仅在需要且凭证就绪时构造
    const useDirect =
      (this.transport === 'http' || this.transport === 'auto') && Boolean(this.apiKey);

    this.directClient = useDirect
      ? new BeikeDirectClient(
          {
            apiKey: this.apiKey!,
            baseUrl: process.env.BEIKE_MCP_BASE_URL?.trim() || undefined,
            // 版本头必须与本地 CLI 版本一致（服务端会校验）
            cliVersion: process.env.BEIKE_CLI_VERSION?.trim() || undefined,
            /**
             * 节流器 —— **必须传**，否则会触发贝壳限流。
             *
             * 实测：一次用户操作产生 12-15 次调用，密集发出会被限流，
             * 所有工具返回 `service temporarily unavailable`，
             * 连原本正常的搜索也被熔断挡住。
             */
            rateLimiter: this.rateLimiter,
          },
          this.parser,
        )
      : null;

    if (this.apiKey) {
      this.logger.log(
        `贝壳客户端已就绪（传输=${this.transport}` +
          `${this.directClient ? '，直连 HTTP 已启用' : ''}` +
          `，CLI: ${this.cliPath}，凭证已配置）`,
      );
    } else {
      this.logger.warn(
        '贝壳 MCP 凭证未配置（BEIKE_MCP_API_KEY 为空），贝壳数据源将不可用。' +
          '系统会自动降级到其他数据源。',
      );
    }
  }

  /** CLI 是否可用（二进制存在 + 凭证已配置） */
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * 注入用量统计到内部节流器。
   *
   * 为什么需要这个方法：`BeikeMcpClient` 是手动 new 出来的，
   * 节流器在字段初始化时就自建了。若不在构造后注入，
   * 诊断端点会读到一个**没人用的空统计实例**。
   */
  attachUsageStats(stats: BeikeUsageStats): void {
    this.rateLimiter.attachUsageStats(stats);
  }

  /** 取用量统计（供诊断端点读取） */
  getUsageStats(): BeikeUsageStats {
    return this.rateLimiter.getUsageStats();
  }

  /**
   * 注入调用预算护栏。
   *
   * 与用量统计同理：客户端是手动 new 的，
   * 护栏必须显式注入才能作用于真实的节流器实例。
   */
  attachQuotaGuard(guard: BeikeQuotaGuard): void {
    this.rateLimiter.attachQuotaGuard(guard);
  }

  /** 取预算护栏（供诊断端点读取与控制） */
  getQuotaGuard(): BeikeQuotaGuard {
    return this.rateLimiter.getQuotaGuard();
  }

  /** CLI 二进制是否存在 */
  isCliInstalled(): boolean {
    return existsSync(this.cliPath);
  }

  /**
   * 取直连 HTTP 客户端（供 AI 工具桥使用）。
   *
   * 为什么单独暴露它，而不复用那些语义化方法：
   * AI 助手需要**动态发现并调用任意工具**（18 个），
   * 而语义化方法只覆盖了业务用到的那几个，参数形状也是固定的。
   *
   * 返回 null 表示直连未启用（`BEIKE_TRANSPORT=cli` 或 Key 未配置）。
   */
  getDirectClient(): BeikeDirectClient | null {
    return this.directClient;
  }

  /** 返回配置状态，供后台展示（绝不返回 Key 本身，只返回掩码） */
  describeStatus(): {
    cliInstalled: boolean;
    cliPath: string;
    credentialConfigured: boolean;
    credentialMasked: string | null;
    apiBaseUrl: string;
  } {
    return {
      cliInstalled: this.isCliInstalled(),
      cliPath: this.cliPath,
      credentialConfigured: this.isConfigured(),
      credentialMasked: this.apiKey ? this.maskKey(this.apiKey) : null,
      apiBaseUrl: process.env.BEIKE_MCP_BASE_URL ?? 'https://building.ke.com/mcp',
    };
  }

  /**
   * 调用 CLI 并解析结果。
   *
   * 内置重试：贝壳的 MCP 服务会返回
   *   {"error": "service temporarily unavailable", "ok": false}
   * 这是**真实存在的故障**（实测：所有数据查询工具会同时不可用，
   * 而 beike doctor 仍显示"API 可达 / Key 有效 / 发现 18 个工具"，
   * 说明连接与凭证正常、只有数据服务挂了）。
   *
   * 重试策略：
   *   - 最多 5 次尝试，总等待上限约 30 秒
   *   - 指数退避 + 抖动，避免多个请求同时重试再次打爆对方
   *   - 一旦成功立即返回（多数抖动在 1～2 次重试内就能恢复）
   *
   * @throws BeikeNotConfiguredError 凭证未配置
   * @throws BeikeCliMissingError CLI 未安装
   * @throws BeikeCliError 调用失败、超时，或重试后仍不可用
   */
  async invoke(options: BeikeCliInvokeOptions): Promise<BeikeCliResult> {
    if (!this.apiKey) {
      throw new BeikeNotConfiguredError(
        '贝壳 MCP 凭证未配置。请在 .env 中设置 BEIKE_MCP_API_KEY，' +
          '或运行 infrastructure/beike/bin/beike.exe login 获取。',
      );
    }

    if (!this.isCliInstalled()) {
      throw new BeikeCliMissingError(this.cliPath);
    }

    const maxAttempts = options.maxAttempts ?? this.defaultMaxAttempts;
    const baseDelayMs = options.retryBaseDelayMs ?? 1200;
    let lastError: Error | null = null;

    // ---- 熔断快速失败 ----
    // 已确认不可用且仍在冷却窗口内 → 不再 spawn CLI 进程，直接失败。
    // 业务层的降级逻辑（本地缓存）会立刻接管，用户几乎无感。
    if (this.unavailableUntil !== null && Date.now() < this.unavailableUntil) {
      const remainSeconds = Math.ceil((this.unavailableUntil - Date.now()) / 1000);
      throw new BeikeCliError(
        `贝壳服务已确认不可用，${remainSeconds} 秒内不再重试（熔断中）`,
        null,
        'CIRCUIT_OPEN',
      );
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.invokeOnce(options, attempt, maxAttempts);
        // 成功 → 立即解除熔断（服务已恢复）
        if (this.unavailableUntil !== null) {
          this.logger.log('贝壳服务已恢复，解除熔断');
          this.unavailableUntil = null;
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 只对"服务端临时不可用"类错误重试；
        // 参数错误、权限不足这类重试是浪费时间。
        const isRetryable =
          error instanceof BeikeCliError &&
          (error.isUnavailable || error.isServiceBusy);

        if (!isRetryable || attempt >= maxAttempts) {
          // 重试耗尽且仍是"不可用" → 打开熔断
          if (isRetryable && attempt >= maxAttempts) {
            this.unavailableUntil = Date.now() + this.circuitCooldownMs;
            this.logger.warn(
              `贝壳服务连续 ${maxAttempts} 次不可用，熔断 ${this.circuitCooldownMs / 1000} 秒` +
                `（期间直接降级，不再发起请求）`,
            );
          }
          break;
        }

        // 指数退避 + 抖动
        const baseDelay = baseDelayMs * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * (baseDelayMs * 0.6));
        const delay = Math.min(8000, baseDelay + jitter);

        this.logger.warn(
          `贝壳服务临时不可用（第 ${attempt}/${maxAttempts} 次尝试），` +
            `${delay}ms 后重试：${this.sanitize(lastError.message).slice(0, 120)}`,
        );

        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
    }

    throw lastError ?? new BeikeCliError('贝壳调用失败', null, '');
  }

  /** 单次调用（不含重试） */
  private async invokeOnce(
    options: BeikeCliInvokeOptions,
    attempt: number,
    maxAttempts: number,
  ): Promise<BeikeCliResult> {
    // ---- 并发限制 ----
    // 简单自旋等待：CLI 调用是短任务，用信号量式等待足够
    const waitStart = Date.now();
    while (this.activeCalls >= this.maxConcurrent) {
      if (Date.now() - waitStart > 30_000) {
        throw new BeikeCliError('等待贝壳 CLI 可用槽位超时', null, '');
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    this.activeCalls += 1;
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    try {
      const result = await this.spawnCli(options.args, timeoutMs);
      const parsed = this.parser.parse(result.stdout);

      // ---- 检查贝壳的业务错误 ----
      // CLI 在服务端报错时仍以退出码 0 结束，错误藏在 JSON 的 error 字段里。
      // 不检查它就会把"服务不可用"当成"没有房源"，进而给出
      // "请调整搜索条件"这种完全错误的提示（实测踩过这个坑）。
      if (parsed.apiError) {
        throw new BeikeCliError(
          `贝壳服务返回错误：${parsed.apiError}`,
          null,
          parsed.apiError,
        );
      }

      this.logger.log(
        `贝壳 CLI 调用完成：${options.args.slice(0, 3).join(' ')} ` +
          `→ ${parsed.entities.length} 个实体，耗时 ${Date.now() - startedAt}ms` +
          `${attempt > 1 ? `（第 ${attempt}/${maxAttempts} 次尝试成功）` : ''}`,
      );

      return {
        parsed,
        stdout: result.stdout,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      this.activeCalls -= 1;
    }
  }

  /** 实际启动子进程 */
  private spawnCli(args: string[], timeoutMs: number): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      // 关键安全点：API Key 通过 env 传入，绝不出现在 args 里。
      // 命令行参数在 Windows 上对外可见（进程列表 / 审计日志）。
      const child = execFile(
        this.cliPath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 40 * 1024 * 1024, // 贝壳响应可能很大，给足缓冲
          windowsHide: true,
          env: {
            ...process.env,
            BEIKE_MCP_API_KEY: this.apiKey,
            // 避免 CLI 尝试读取/写入用户目录下的配置文件（沙箱或容器中不可写）
            BEIKE_NO_CONFIG_WRITE: '1',
          },
        },
        (error, stdout, stderr) => {
          const safeStderr = this.sanitize(stderr ?? '');

          if (error) {
            // 超时是 killed 标志
            const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
            const exitCode =
              typeof (error as { code?: unknown }).code === 'number'
                ? ((error as { code: number }).code as number)
                : null;

            if (killed) {
              reject(
                new BeikeCliError(
                  `贝壳 CLI 调用超时（${timeoutMs}ms）。可能是网络问题或查询条件过于宽泛。`,
                  null,
                  safeStderr,
                ),
              );
              return;
            }

            reject(
              new BeikeCliError(
                `贝壳 CLI 调用失败${exitCode !== null ? `（退出码 ${exitCode}）` : ''}：` +
                  `${this.sanitize(error.message)}`,
                exitCode,
                safeStderr,
              ),
            );
            return;
          }

          resolve({ stdout: stdout ?? '' });
        },
      );

      child.on('error', (error) => {
        reject(new BeikeCliError(`无法启动贝壳 CLI：${this.sanitize(error.message)}`, null, ''));
      });
    });
  }

  /**
   * 脱敏：从任意文本中移除 API Key。
   *
   * 这是防泄漏的最后一道防线 —— CLI 的 stderr 有可能回显环境变量或请求头。
   * 所有对外输出（日志、错误信息、API 响应）都必须经过这个方法。
   */
  private sanitize(text: string): string {
    if (!text) return '';
    let result = text;

    if (this.apiKey) {
      // 完整替换
      result = result.split(this.apiKey).join('***REDACTED***');
    }

    // 兜底：任何形如 "Bearer xxx" 的内容也脱敏
    result = result.replace(/(Bearer\s+)[A-Za-z0-9\-_.~+/]{10,}/gi, '$1***REDACTED***');

    return result;
  }

  /** Key 掩码，形如 abcd****wxyz */
  private maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
  }

  // -------------------------------------------------------------------------
  // 传输分发（Phase 13）
  // -------------------------------------------------------------------------

  /**
   * 统一的传输分发：优先直连 HTTP，按配置决定是否回退 CLI。
   *
   * 设计要点：
   *   - `transport === 'cli'`  → 永远走 CLI（便于排查与对比）
   *   - `transport === 'http'` → 只用直连，失败就失败（问题暴露，不掩盖）
   *   - `transport === 'auto'` → 直连失败时回退 CLI，并**记录降级原因**
   *
   * 为什么 auto 模式值得保留回退：CLI 是官方二进制，万一它内部有我们
   * 不知道的重试/适配逻辑，回退能提高可用性。但**必须记录日志** ——
   * 否则会像之前那样"静默走了另一条路"，排查时看不到真相。
   */
  private async dispatch(
    label: string,
    directCall: (client: BeikeDirectClient) => Promise<BeikeCliResult>,
    cliCall: () => Promise<BeikeCliResult>,
  ): Promise<BeikeCliResult> {
    // ---- 只用 CLI ----
    if (this.transport === 'cli' || !this.directClient) {
      return cliCall();
    }

    // ---- 直连 ----
    try {
      const result = await directCall(this.directClient);

      // 直连把工具错误归一化成了 parsed.apiError，这里统一抛错，
      // 与 CLI 路径的错误行为保持一致（上层 catch 逻辑不变）
      if (result.parsed.apiError) {
        throw new BeikeCliError(
          `贝壳服务返回错误：${result.parsed.apiError}`,
          null,
          result.parsed.apiError,
        );
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // 只用直连时，错误直接暴露（不掩盖问题）
      if (this.transport === 'http') {
        throw error instanceof BeikeCliError
          ? error
          : new BeikeCliError(`${label} 直连失败：${message}`, null, message);
      }

      // ---- 服务端已确认不可用 → 不回退 ----
      //
      // 直连已经拿到了明确答案（"service temporarily unavailable"），
      // 再让 CLI 重试一遍既浪费 2～5 秒，也不会有不同结果。
      // 直接抛错，让上层立刻走本地缓存降级。
      if (this.isServiceUnavailable(error)) {
        this.logger.warn(`${label} 直连判定服务不可用，跳过 CLI 回退（直接降级）`);
        throw error instanceof BeikeCliError
          ? error
          : new BeikeCliError(`${label} 失败：${message}`, null, message);
      }

      // auto：其它类型的失败才回退 CLI，并明确记录，避免"静默降级"
      this.logger.warn(`${label} 直连失败，回退 CLI：${message.slice(0, 160)}`);

      try {
        return await cliCall();
      } catch (cliError) {
        const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
        throw new BeikeCliError(
          `${label} 直连与 CLI 均失败。直连：${message.slice(0, 120)}；CLI：${cliMessage.slice(0, 120)}`,
          null,
          `${message} | ${cliMessage}`,
        );
      }
    }
  }

  /**
   * 判断错误是否为「服务端数据层不可用」。
   *
   * 识别依据（实测确认的形态）：
   *   - 错误文本含 `service temporarily unavailable`
   *   - 或直连熔断标记 `CIRCUIT_OPEN`
   *
   * 这类失败是**确定性**的（~220ms 就返回），因此不该触发跨传输的回退重试。
   */
  private isServiceUnavailable(error: unknown): boolean {
    if (!(error instanceof BeikeCliError)) return false;

    const text = `${error.message} ${error.stderr}`;
    return /temporarily unavailable/i.test(text) || error.stderr.includes('CIRCUIT_OPEN');
  }

  // -------------------------------------------------------------------------
  // 便捷方法：封装常用查询
  // -------------------------------------------------------------------------

  /** 搜索房源 */
  async searchHouses(params: {
    city: string;
    query: string;
    houseType?: 'second' | 'new' | 'all';
  }): Promise<BeikeCliResult> {
    const args = [
      'buy',
      'search',
      '-c',
      params.city,
      '-q',
      params.query,
      '--house-type',
      params.houseType ?? 'second',
      '--json',
    ];

    return this.dispatch(
      '搜索房源',
      (client) => client.searchHouses(params),
      // 搜索是核心数据来源，值得多试几次。
      // 但退避总时长必须可控：单次失败约 1～2 秒返回，
      // 4 次尝试 + 退避（0.5 + 1 + 2 秒）≈ 8～12 秒。
      //
      // Phase 13 调整：诊断确认服务故障时是**确定性失败**（~220ms 就返回），
      // 4 次重试纯属浪费。降到 2 次，把时间让给本地缓存降级。
      () => this.invoke({ args, maxAttempts: 2, retryBaseDelayMs: 400 }),
    );
  }

  /** 房源/小区详情 */
  async fetchDetails(params: {
    city: string;
    ids: string[];
    entityType?: 'house' | 'newhouse' | 'resblock';
  }): Promise<BeikeCliResult> {
    const args = ['buy', 'detail', '-c', params.city, '-t', params.entityType ?? 'house'];
    for (const id of params.ids.slice(0, 20)) {
      args.push('--id', id);
    }
    args.push('--json');
    // 详情是增强信息（学区/配套），对 Top N 逐套调用 —— 累积等待成本高。
    // 因此这里只试 2 次且退避很短：失败就跳过这套的详情，用摘要数据继续。
    return this.dispatch(
      '房源详情',
      (client) => client.fetchDetails(params),
      () => this.invoke({ args, maxAttempts: 2, retryBaseDelayMs: 400 }),
    );
  }

  /** 搜索小区 */
  async searchResblocks(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '搜索小区',
      (client) => client.searchResblocks(params),
      () => this.invoke({ args: ['buy', 'resblock', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 搜索板块/商圈 */
  async searchPlates(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '搜索板块',
      (client) => client.searchPlates(params),
      () => this.invoke({ args: ['buy', 'plate', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 市场行情 */
  async fetchMarket(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '市场行情',
      (client) => client.fetchMarket(params),
      () => this.invoke({ args: ['buy', 'market', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 成交记录 */
  async fetchSold(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '成交记录',
      (client) => client.fetchSold(params),
      () => this.invoke({ args: ['buy', 'sold', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 学校查询 */
  async searchSchools(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '学校查询',
      (client) => client.searchSchools(params),
      () => this.invoke({ args: ['buy', 'school', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 学区范围 */
  async fetchDistrict(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '学区范围',
      (client) => client.fetchDistrict(params),
      () => this.invoke({ args: ['buy', 'district', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 政策咨询 */
  async askPolicy(params: { city: string; query: string }): Promise<BeikeCliResult> {
    return this.dispatch(
      '政策咨询',
      (client) => client.askPolicy(params),
      () => this.invoke({ args: ['policy', '-c', params.city, '-q', params.query, '--json'] }),
    );
  }

  /** 环境诊断（供后台"测试连接"按钮使用） */
  async diagnose(): Promise<{ ok: boolean; message: string; raw: string }> {
    // ---- 直连诊断（优先）----
    // 直连能把真实错误原样透出（版本问题？鉴权？服务故障？），
    // 而 CLI 会把它们统一压成 "service temporarily unavailable"。
    if (this.directClient && this.transport !== 'cli') {
      const result = await this.directClient.diagnose();
      if (result.ok) return result;

      // auto 模式下直连失败时才回退 CLI 诊断（便于排查是传输问题还是凭证问题）
      if (this.transport === 'http') return result;

      this.logger.debug(`直连诊断失败，回退 CLI 诊断：${result.message}`);
    }

    try {
      const result = await this.invoke({ args: ['doctor'], timeoutMs: 30_000 });
      const text = this.sanitize(result.stdout);
      const ok = text.includes('[✓] Key 有效') || text.includes('工具');
      return {
        ok,
        message: ok ? '贝壳 MCP 连接正常（CLI）' : '连接成功但凭证可能无效',
        raw: text,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? this.sanitize(error.message) : '诊断失败',
        raw: '',
      };
    }
  }
}

/** 从配置读取贝壳 CLI 相关设置（供配置层使用） */
export function resolveBeikeCliPath(config: AppConfig): string {
  void config;
  const configured = process.env.BEIKE_CLI_PATH?.trim();
  if (configured) return configured;

  return path.resolve(
    process.cwd(),
    '..',
    '..',
    'infrastructure',
    'beike',
    'bin',
    process.platform === 'win32' ? 'beike.exe' : 'beike',
  );
}
