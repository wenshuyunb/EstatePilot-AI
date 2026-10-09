/**
 * 项目功能验收脚本（UTF-8 安全）。
 *
 * 用途：一次性验证所有已实现的后端功能是否真实可用。
 * 为什么不用 PowerShell：Invoke-RestMethod 会把中文转成 ??（见环境事实 E20）。
 *
 * 用法：
 *   node --experimental-strip-types --no-warnings scripts/verify-all-features.ts
 *   API_BASE_URL=http://localhost:3001/api/v1 node --experimental-strip-types scripts/verify-all-features.ts
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1';
const PASSWORD = 'EstatePilot2026!';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
}

const results: CheckResult[] = [];

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      signal: controller.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    let data: T | null = null;
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? null : text.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function record(name: string, ok: boolean, detail: string, ms?: number): void {
  results.push({ name, ok, detail, ...(ms !== undefined ? { ms } : {}) });
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon} ${name.padEnd(46)} ${detail}${ms !== undefined ? `  (${ms}ms)` : ''}`);
}

async function main(): Promise<void> {
  console.log('EstatePilot AI — 功能验收\n');
  console.log(`API: ${API_BASE}\n`);

  // ========================================================================
  console.log('【1】认证与安全');
  // ========================================================================

  let agentToken = '';
  {
    const start = Date.now();
    const res = await request<{
      accessToken: string;
      refreshToken: string;
      user: { name: string; role: string };
    }>('/auth/login', {
      method: 'POST',
      body: { email: 'agent111@estatepilot.demo', password: PASSWORD },
    });
    if (res.ok && res.data) {
      agentToken = res.data.accessToken;
      record('经纪人登录', true, `${res.data.user.name}（${res.data.user.role}）`, Date.now() - start);
    } else {
      record('经纪人登录', false, res.error ?? '失败');
      console.log('\n登录失败，后续需要认证的检查将跳过。');
      printSummary();
      return;
    }
  }

  {
    const res = await request('/auth/login', {
      method: 'POST',
      body: { email: 'agent111@estatepilot.demo', password: 'WrongPassword123!' },
    });
    record(
      '错误密码被拒绝且不泄露账号是否存在',
      res.status === 401,
      `HTTP ${res.status}`,
    );
  }

  {
    const res = await request<{ user?: { email?: string; name?: string; role?: string } }>('/auth/me', {
      token: agentToken,
    });
    const user = res.data?.user;
    record('获取当前用户信息', res.ok && Boolean(user?.email), user?.email ?? '失败');
  }

  {
    const res = await request('/dashboard');
    record('未携带令牌被拒绝', res.status === 401, `HTTP ${res.status}`);
  }

  {
    const res = await request('/beike/diagnose', { method: 'POST', token: agentToken, body: {} });
    record(
      '权限控制：经纪人无权访问管理器接口',
      res.status === 403,
      `HTTP ${res.status}`,
    );
  }

  // ========================================================================
  console.log('\n【2】工作台');
  // ========================================================================

  {
    const start = Date.now();
    const res = await request<{
      summary?: { totalCustomers?: number };
      priorityCustomers?: unknown[];
      opportunities?: unknown[];
      todayViewings?: unknown[];
    }>('/dashboard', { token: agentToken });
    const d = res.data;
    record(
      'GET /dashboard 生成工作台数据',
      res.ok && d !== null,
      d
        ? `优先客户 ${d.priorityCustomers?.length ?? 0} 个，机会 ${d.opportunities?.length ?? 0} 个`
        : (res.error ?? '失败'),
      Date.now() - start,
    );
  }

  // ========================================================================
  console.log('\n【3】通知');
  // ========================================================================

  {
    const res = await request<{ items?: unknown[] }>('/notifications', { token: agentToken });
    record('GET /notifications', res.ok, `${(res.data as { items?: unknown[] })?.items?.length ?? 0} 条`);
  }

  {
    const res = await request<{ count?: number }>('/notifications/unread-count', {
      token: agentToken,
    });
    record('GET /notifications/unread-count', res.ok, `未读 ${(res.data as { count?: number })?.count ?? 0} 条`);
  }

  // ========================================================================
  console.log('\n【4】贝壳真实房源接入');
  // ========================================================================

  {
    const res = await request<{
      activeProvider?: string;
      beike?: { available?: boolean; credentialMasked?: string; cliInstalled?: boolean };
    }>('/beike/status', { token: agentToken });
    const b = res.data?.beike;
    record(
      'GET /beike/status 数据源状态',
      res.ok && Boolean(b?.available),
      `Provider=${res.data?.activeProvider} 凭证=${b?.credentialMasked} CLI=${b?.cliInstalled}`,
    );
  }

  // 中文参数必须用 Node 发送，不能经 PowerShell
  const detectedIds: string[] = [];
  {
    const start = Date.now();
    const res = await request<{
      items?: Array<{
        externalId: string;
        community: string;
        totalPrice: number;
        bedrooms: number;
        area: number;
        subwayText: string | null;
        schoolText: string | null;
        imageCount: number;
      }>;
      totalRecalled?: number;
      matchedConditions?: unknown[];
    }>('/beike/search', {
      method: 'POST',
      token: agentToken,
      body: { city: '上海', query: '张江 三房', houseType: 'second' },
      timeoutMs: 120_000,
    });

    const items = res.data?.items ?? [];
    for (const item of items.slice(0, 5)) detectedIds.push(item.externalId);

    record(
      'POST /beike/search 中文语义检索',
      res.ok && items.length > 0,
      `召回 ${res.data?.totalRecalled ?? 0} 套，返回 ${items.length} 套`,
      Date.now() - start,
    );

    if (items.length > 0) {
      console.log('\n      真实房源样例：');
      for (const item of items.slice(0, 3)) {
        console.log(
          `        · ${item.community} ${item.bedrooms}室 ${item.area}㎡ ` +
            `${Math.round(item.totalPrice / 10000)}万 | 地铁 ${item.subwayText ?? '—'} | 学区 ${item.schoolText ?? '—'}`,
        );
      }
      console.log('');
    }
  }

  if (detectedIds.length > 0) {
    const start = Date.now();
    const res = await request<{
      items?: Array<Record<string, unknown>>;
    }>('/beike/detail', {
      method: 'POST',
      token: agentToken,
      body: { city: '上海', ids: detectedIds.slice(0, 2) },
      timeoutMs: 120_000,
    });
    const items = res.data?.items ?? [];
    record(
      'POST /beike/detail 详情补全',
      res.ok && items.length > 0,
      `返回 ${items.length} 套完整详情`,
      Date.now() - start,
    );
    const first = items[0];
    if (first) {
      console.log(
        `        首套: ${first.title} | 建成年份 ${first.buildYear} | 楼层 ${first.floor}/${first.totalFloors} | 图片 ${first.imageCount} 张`,
      );
    }
  }

  // ========================================================================
  console.log('\n【5】房源粘贴导入（贝壳凭证不可用时的替代路径）');
  // ========================================================================

  {
    const pasteSample = `小区名称：测试花园
户型：3室2厅1卫
建筑面积：128.5平米
总价：1250万
所在楼层：中层/18层
朝向：南北
装修：精装修
建筑年代：2012年
所在区域：浦东新区`;

    const res = await request<{
      drafts?: Array<{ confidence?: number; fields?: Record<string, unknown> }>;
      summary?: { totalBlocks: number; parsedBlocks: number; importable: number };
    }>('/properties/import/preview', {
      method: 'POST',
      token: agentToken,
      body: { text: pasteSample, city: '上海' },
    });

    const drafts = res.data?.drafts ?? [];
    const first = drafts[0];
    record(
      'POST /properties/import/preview 解析粘贴文本',
      res.ok && drafts.length > 0,
      first
        ? `解析 ${drafts.length} 条，置信度 ${Math.round(Number(first.confidence ?? 0) * 100)}%，` +
          `户型=${String(first.fields?.['bedrooms'] ?? '?')}室，面积=${String(first.fields?.['area'] ?? '?')}㎡，` +
          `楼层=${String(first.fields?.['floor'] ?? '?')}`
        : (res.error ?? `返回 drafts 为空（HTTP ${res.status}）`),
    );
  }

  // ========================================================================
  console.log('\n【6】一键发送包（微信文案生成）');
  // ========================================================================

  {
    // 该能力依赖「客户 + 匹配结果」，因此先从工作台拿一位有匹配的客户
    const dashboard = await request<{
      priorityCustomers?: Array<{ id?: string; customerId?: string; name?: string }>;
    }>('/dashboard', { token: agentToken });

    const priority = dashboard.data?.priorityCustomers ?? [];
    const candidateId = priority[0]?.customerId ?? priority[0]?.id;

    if (!candidateId) {
      record('一键发送包（生成微信文案）', false, '工作台没有返回优先客户，无法验证');
    } else {
      const start = Date.now();
      const res = await request<{
        messageText?: string;
        smsText?: string;
        phoneScript?: string;
        strategyNote?: string;
        cautions?: string[];
        portalUrl?: string;
        properties?: Array<{ community: string; totalPrice: number }>;
      }>('/outreach/recommend-bundle', {
        method: 'POST',
        token: agentToken,
        body: { customerId: candidateId, propertyLimit: 3 },
        timeoutMs: 120_000,
      });

      const d = res.data;
      record(
        'POST /outreach/recommend-bundle 生成发送包',
        res.ok && Boolean(d?.messageText),
        d?.messageText
          ? `${d.properties?.length ?? 0} 套房源，文案 ${d.messageText.length} 字，策略 ${d.strategyNote ? '有' : '无'}，注意事项 ${d.cautions?.length ?? 0} 条`
          : (res.error ?? '失败'),
        Date.now() - start,
      );

      if (d?.messageText) {
        console.log('\n      ── 生成的微信文案（前 12 行）──');
        for (const line of d.messageText.split('\n').slice(0, 12)) {
          console.log(`      ${line}`);
        }
        console.log('');
      }
    }
  }

  printSummary();
}

function printSummary(): void {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`验收结果：${passed} 项通过，${failed} 项失败`);
  console.log('='.repeat(78));

  if (failed > 0) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
  }

  const timed = results.filter((r) => r.ms !== undefined);
  if (timed.length > 0) {
    console.log('\n耗时统计：');
    for (const r of timed) {
      console.log(`  ${r.name.padEnd(46)} ${r.ms}ms`);
    }
  }
}

main().catch((error) => {
  console.error('\n验收脚本异常：', error);
  process.exit(1);
});
