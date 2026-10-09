# DEVELOPMENT_PLAN.md

**EstatePilot AI — 房产 AI 成交助手 · 开发计划与进度**

> 产品核心价值（一切决策围绕这一句话）：
> **「通过客户真实行为 + 房源变化 + AI，让经纪人每天知道最应该联系谁、推荐什么房、下一步怎么推进。」**

| 项目 | 值 |
|---|---|
| 项目名 | EstatePilot AI |
| 中文名 | 房产 AI 成交助手 |
| 目标用户 | 5～100 人房地产中介门店（经纪人 / 店长 / 公司负责人 / 连锁机构） |
| 技术栈 | Next.js 16 · React 19 · TypeScript 5.9 · Tailwind 4 · NestJS 12 · PostgreSQL 18 + pgvector · Prisma 7 · Redis 8 · BullMQ · Docker |
| 项目根 | `D:\Projects\EstatePilot-AI` |
| 开始日期 | 2026-10-08（Phase 0 环境验证） |
| 当前阶段 | Phase 1 |

---

## 0. 本机环境事实（实测，非假设）

Phase 0 已产出 `DEVELOPMENT_ENVIRONMENT.md` / `ENVIRONMENT_SETUP_REPORT.md`。以下是本轮开发再次实测确认、
且**直接影响代码写法**的事实，务必遵守：

| # | 事实 | 对开发的影响 |
|---|---|---|
| E1 | `pnpm@12.10.1`（corepack 提供） | 配置写在 `pnpm-workspace.yaml`，**不读 `.npmrc`** |
| E2 | `pnpm-workspace.yaml` 的键**必须是 camelCase** | `https-proxy` 会被静默忽略，必须写 `httpsProxy` |
| E3 | `pnpm-workspace.yaml` **不能有 BOM** | 否则报 `a BOM must not appear inside a document` |
| E4 | pnpm 12 默认**拒绝所有依赖构建脚本** | 必须用 `allowBuilds`（YAML 映射，非列表）放行 prisma / esbuild / sharp |
| E5 | pnpm 的存储操作锁在 `%LOCALAPPDATA%\pnpm-store-operation-locks` | 该路径在工作区外，DSH 文件沙箱会拒绝 → `pnpm install` 需升级权限执行（一次一条命令） |
| E6 | 本机经 VPN 代理 `127.0.0.1:17891` 访问外网 | 代理配置写在 `pnpm-workspace.yaml`；Node 下载器需 `HTTPS_PROXY` 环境变量 |
| E7 | Docker 引擎 **29.8.2**，走具名管道 | 受限沙箱无法打开具名管道 → docker 命令需升级权限执行 |
| E8 | PostgreSQL 18 镜像数据目录改为 `/var/lib/postgresql` | volume 必须挂这一层，**不能**挂 `/var/lib/postgresql/data` |
| E9 | Nginx healthcheck 必须用 `127.0.0.1` 并显式监听 `[::]:80` | 否则容器 unhealthy 但实际服务正常 |
| E10 | Prisma **7.10.0** 稳定版（`latest` 会解析到 8.0.0-rc） | 锁死 7.10.0；Prisma 7 布局与 6 不同（见 E11） |
| E11 | Prisma 7：配置在 `prisma.config.ts`；生成 **TypeScript 源码**；**必须用驱动适配器** | `import { PrismaClient } from './generated/prisma/client.ts'` + `new PrismaPg({connectionString})` |
| E12 | TypeScript **5.9.3** 稳定版（`latest` 是 7.0.2） | 锁死 5.9.3 |
| E13 | Windows 上 `$pid` 是只读变量 | PowerShell 脚本里改用 `$procId` |
| E14 | Prisma 引擎下载到 `%APPDATA%\Prisma` | 该路径在工作区外 → prisma 命令需升级权限执行 |
| E15 | `pnpm exec` 会自动触发依赖安装检查 | 沙箱下该检查失败但不影响执行结果；需要干净输出时改用 `node_modules\.bin\xxx.cmd` 直调 |
| E16 | `tsc` 的 `incremental: true` 配合手动删 `dist` 会**跳过输出** | 清 `dist` 时必须同时删 `tsconfig.tsbuildinfo`，否则产物残缺且退出码为 0（静默失败） |
| E17 | NestJS 内置 `ValidationPipe` 强制依赖 `class-validator` | 本项目统一用 Zod 校验，因此**不能注册** `ValidationPipe` |
| E18 | 用 `import type` 导入被注入的配置类会让 Nest DI 失败 | Symbol 令牌（如 `APP_CONFIG`）必须配合显式 `@Inject(APP_CONFIG)` |
| E19 | pnpm 的 `.bin` 脚本与 `tsx` 在受限沙箱下都会 `spawn EPERM` | 运行测试/脚本需升级权限执行 |
| E20 | **PowerShell 的 `Invoke-RestMethod` 会把请求体里的中文转成 `??` 再发送** | 这是本项目最耗时的一个陷阱：API 侧一切正常，但用 PowerShell 测试时服务端收到损坏的 `city=??`，贝壳返回 `unsupported city_name: ??`，表现为「接口返回 0 条」。**结论：所有含中文的 API 验证必须用 Node 脚本（UTF-8 严格），例如 `apps/api/scripts/verify-beike-utf8.ts`** |
| E21 | Windows PowerShell 5.1 按系统 ANSI 代码页读取 `.ps1` 文件 | 脚本内含中文会导致解析错误（`Unexpected token`）。**`.ps1` 一律只用 ASCII**，中文放注释里也要转写 |
| E22 | PowerShell 的 `Get-Content`/`Set-Content` 往返会破坏 UTF-8 中文与换行 | 这是显示层面的假象（文件本身完好）与真实损坏混合出现。**结论：改文件用编辑工具，不用 PowerShell 文本管道；校验用 Node 读码点** |

**已修复的本机故障（本轮）**

| 故障 | 根因 | 处理 |
|---|---|---|
| 工作区无法写入，DSH 报 `SetNamedSecurityInfoW failed (Win32 5)` | `D:\Projects\EstatePilot-AI` 缺少当前用户的 `WRITE_OWNER`/完全控制权限 | 用 ACL 诊断脚本补上完全控制 ACE 并复验通过（文件内容与所有者未改动，撤销命令已记录在 `D:\Projects\dsh-acl-recovery`） |

---

## 1. 目录结构（Monorepo）

```
EstatePilot-AI/
├── apps/
│   ├── api/                      # NestJS 后端
│   └── web/                      # Next.js 前端（含客户专属页面 /c/[token]）
├── packages/
│   ├── types/                    # 跨端共享类型与枚举（单一事实来源）
│   ├── utils/                    # 通用工具（无副作用）
│   ├── database/                 # Prisma schema + client + seed
│   ├── ai/                       # AI Provider Adapter + Prompt Registry
│   └── config/                   # 共享 tsconfig / eslint / tailwind 预设
├── infrastructure/
│   ├── docker-compose.yml        # 基础设施：PostgreSQL + Redis（+ Nginx 生产）
│   ├── docker-compose.full.yml   # 全栈：+ api + web
│   ├── nginx/
│   └── postgres/init/            # 首次启动 SQL（启用 pgvector）
├── docs/                         # 全部交付文档
├── e2e/                          # Playwright 端到端测试
├── .env.example
└── DEVELOPMENT_PLAN.md
```

---

## 2. 开发阶段与进度

图例：`[x]` 已完成并实测通过 · `[~]` 进行中 · `[ ]` 未开始

### Phase 11 — 微信复制 → AI 需求 → 贝壳 → 推荐闭环（当前阶段）

**业务目标（一句话）**：客户说一句话，经纪人复制进系统，几十秒后得到真实房源和可以直接发送给客户的微信回复。

**严格的产品边界**：使用**普通个人微信**，没有聊天 API。因此只做「人工复制 → 系统粘贴 → 系统生成 → 人工发送」。
严禁：微信 Hook / DLL 注入 / PC 微信逆向 / 模拟个人微信协议 / 读取微信数据库 / 自动控制微信客户端。

#### 11.A 数据层（增量，不重建）

- [x] 11.A.1 `customer_message_imports` —— 粘贴的原始微信文本（**AI 解析失败也必须保留原文**）
- [x] 11.A.2 `customer_requirement_profiles` —— 三级预算模型（target / normalMax / stretchMax）+ 各维度偏好
- [x] 11.A.3 `customer_requirement_snapshots` —— 需求版本历史（version、changedFields、previousValues、newValues、confidence）
- [x] 11.A.4 `customer_property_feedback` —— 客户对具体房源的反馈（sentiment、interestLevel、priceReaction、locationReaction…）
- [x] 11.A.5 `recommendation_batches` —— 推荐批次（candidateCount、recommendedPropertyIds、status）
- [x] 11.A.6 `generated_customer_replies` —— 生成的微信文案（content、style、copiedAt、sentConfirmedAt）
- [x] 11.A.7 复用现有 `customer_property_matches`（字段名与领域模型不同，做了显式映射）
- [x] 11.A.8 复用现有 `@@unique([organizationId, externalProvider, externalId])` 做房源去重（**未改动**）

#### 11.B AI 层（复用现有 Prompt Registry 与 Provider Factory）

- [x] 11.B.1 新增 `WECHAT_REQUIREMENT_EXTRACTION` Prompt（JSON Schema 约束）—— Prompt 注册表从 10 个增至 14 个
- [x] 11.B.2 新增 `CUSTOMER_REQUIREMENT_MERGE` Prompt（增量合并，不覆盖历史）
- [x] 11.B.3 新增 `PROPERTY_FEEDBACK_EXTRACTION` Prompt（识别"第一套贵、第二套位置不好"）
- [x] 11.B.4 新增 `WECHAT_RECOMMENDATION_REPLY` Prompt（生成普通微信可发文案）
- [x] 11.B.5 复用现有 `PROPERTY_MATCH_EXPLANATION` 生成推荐理由（打分维度自带 detail 文本）
- [x] 11.B.6 所有输出经 Zod/JSON Schema 校验；AI 不可用时规则降级（**Mock 领域钩子机制**）

#### 11.C 业务服务层（每个服务独立可测）

- [x] 11.C.1 `MessageImportService` —— 保存原始消息（永不失数据）
- [x] 11.C.2 `RequirementExtractorService` —— 自然语言 → 结构化需求（AI 优先 + 规则兜底）
- [x] 11.C.3 `RequirementMergeService` —— **增量合并**：三级预算累加，代码算数值、AI 判语义
- [x] 11.C.4 `RequirementSnapshotService` —— 版本快照与 Diff（有变化才建版本）
- [x] 11.C.5 `PropertySearchQueryBuilder` —— 需求 → 结构化条件 + 贝壳自然语言 query
- [x] 11.C.6 `HardFilterService` —— 确定性硬筛 + 零结果归因与放宽建议
- [x] 11.C.7 `MatchScoringService` —— 9 维加权打分（预算25/区域15/户型15/面积10/房龄10/交通10/小区5/装修5/历史5）
- [x] 11.C.8 `PropertyDetailEnrichmentService` —— 只对 Top N 补详情，分批并发 4（实现在编排器内）
- [x] 11.C.9 `PropertyUpsertService` —— 按 (provider, externalId) 去重入库 + 价格历史
- [x] 11.C.10 `RecommendationService` —— 推荐批次 + 避免重复推荐（降价重新进入）
- [x] 11.C.11 `WeChatReplyGenerator` —— 微信文案（含编造检测 + 规则降级）
- [x] 11.C.12 `WeChatPropertyAssistantOrchestrator` —— 只做协调，各步骤独立可测
- [x] 11.C.13 `PropertyFeedbackService` —— 客户反馈抽取与归因
- [x] 11.C.14 `chinese-expression-parser.ts` —— 中文房产口语规则解析器（AI 兜底 + 可确定性测试）

#### 11.D API 层（**未破坏现有 `/beike/*`**）

- [x] 11.D.1 `POST /customers/:id/messages/import`
- [x] 11.D.2 `POST /customers/:id/requirements/analyze`
- [x] 11.D.3 `POST /customers/:id/property-search`（支持 relax 放宽）
- [x] 11.D.4 `POST /customers/:id/recommendations/generate`
- [x] 11.D.5 `POST /customers/:id/wechat-assistant`（编排入口）
- [x] 11.D.6 `POST /recommendations/:id/copy`、`/confirm-sent`、`/discard`、`/feedback`、`/regenerate`
- [x] 11.D.7 `GET /customers/:id/messages`、`/requirement`、`/requirement-history`、`/recommendations`、`/assistant-capabilities`
- [x] 11.D.8 `GET /beike/status` 复用（前端据此显示数据源健康状态）


#### 11.E 前端（客户页核心模块）

- [x] 11.E.1 客户详情页（客户 360）
- [x] 11.E.2 「微信消息智能处理」模块 —— 页面最显眼入口
- [x] 11.E.3 粘贴框 + `Ctrl+Enter` 触发
- [x] 11.E.4 **真实进度反馈**（明确标注预期步骤，不伪造实时状态）
- [x] 11.E.5 需求变化 Diff 展示（之前 → 现在）
- [x] 11.E.6 推荐房源卡片（真实图片、匹配度明细、推荐理由、注意事项、来源标注）
- [x] 11.E.7 人工控制：移除 / 置顶 / 上移 / 按当前列表重新生成
- [x] 11.E.8 一键复制（Clipboard API）+ Toast「已复制，可直接粘贴到微信」
- [x] 11.E.9 「我已发送」确认（普通微信无发送 API，必须人工确认）
- [x] 11.E.10 推荐历史（刷新后仍在）
- [x] 11.E.11 零结果时的放宽建议（持久错误面板，列出可放宽条件）
- [x] 11.E.12 贝壳不可用时的明确提示 + 「重新查询房源」（不重新调 AI）
- [x] 11.E.13 客户列表页（搜索、排序、分页、意向分、需求速览）
- [x] 11.E.14 **三级预算可视化**（理想/最高/极限三段条）
- [x] 11.E.15 需求版本历史 Tab（v1 → v2 → v3 与每次变化）
- [x] 11.E.16 消息记录 Tab（原文、解析状态、失败原因）

#### 11.F 测试

- [x] 11.F.1 中文房产表达验证（`scripts/debug-bedrooms.ts`：13 类户型表达全通过）
- [x] 11.F.2 需求合并与冲突处理验证（`scripts/verify-budget-merge.ts`：5 轮演进 + 改口 + 取消，全通过）
- [x] 11.F.3 快照与 Diff（集成在闭环 E2E 中断言）
- [x] 11.F.4 Hard Filter 与 Match Score（闭环实测中间接覆盖）
- [x] 11.F.5 重复推荐去重（`previouslyRecommended` 标记在卡片上可见）
- [x] 11.F.6 微信文案生成（E2E 断言：非空、无 Markdown、无字段名）
- [x] 11.F.7 异常路径（空消息 400、贝壳不可用 503、零结果 422、无令牌 401、不存在客户 404）
- [x] 11.F.8 集成测试（`scripts/verify-wechat-flow.ts`，27 项断言，区分外部依赖失败）
- [x] 11.F.9 **Playwright E2E（17/17 通过）**：含完整闭环（缓存降级模式约 31 秒）+ Console 零错误
- [x] 11.F.10 标签解析回归（`scripts/debug-tags.ts`：真实数据 4/4 通过，无单字碎片）

#### 11.G 已知问题与修复记录

- [x] 11.G.1 **贝壳服务整体不可用**：实测所有数据查询工具（搜索/小区/榜单/板块/详情/政策）
  同时返回 `service temporarily unavailable`，而 `beike doctor` 显示
  "API 可达 / Key 有效 / 发现 18 个工具"。换城市、换查询词、连续探测 5 次均失败
  → **对方服务端故障**，已实现降级（见 11.G.3）与故障类型区分（`GET /beike/status?probe=1`）
- [x] 11.G.2 **「标签」字段解析错误**（导致 React key 冲突）
  该字段实为「小区基础信息 + 房源标签」的合并文本，
  **顶层分隔符是中文逗号 `，`**，`/` 只是块内分隔符。
  旧实现按 `/` 无脑切分，把 `物业费0.45元/平米/月` 切成 `["物业费0.45元","平米","月"]`，
  把 `车位配比1:0.5(租车位车位600元/年)` 切成 `[…"600元","年)"]`。
  多个房源都有「月」这个碎片 → 前端以标签为 key → **React 报重复 key**。
  已重写解析器（信息块整块保留、按块类型分流、合并被切断的括号、单字碎片过滤），
  并编写 `scripts/debug-tags.ts` 用真实数据回归（4/4 通过）
- [x] 11.G.3 **本地缓存降级检索**：贝壳不可用时自动改用本地已入库的真实房源，
  界面明确标注「本地缓存房源 · N 小时前同步」+「非实时，发送前请确认在售」
- [x] 11.G.4 房源标签历史数据修复（`scripts/reparse-tags.ts` 从 rawData 重解析
  + `scripts/fix-legacy-tags.ts` 修复原文已丢失的记录），碎片归零
- [x] 11.G.5 「两房」无法识别：正则字符类漏了「两」这个最常用口语数量词
- [x] 11.G.6 三级预算退化（最高=极限）：上限"只升不降"导致早期误判无法回落


#### 11.H 验证方式（重要，踩过坑）

- [x] 11.H.1 **所有含中文的 API 验证一律用 Node 脚本**，禁止用 PowerShell `Invoke-RestMethod`
  （PowerShell 会把 `上海` 转成 `??` 再发送，导致误判为"接口坏了"，已浪费大量时间 —— 见环境事实 E20）
- [x] 11.H.2 贝壳可用性验证脚本：`apps/api/scripts/verify-beike-utf8.ts`
- [x] 11.H.3 不依赖贝壳的纯逻辑验证：
  `scripts/debug-tags.ts`（标签解析）、`scripts/debug-bedrooms.ts`（户型解析）、
  `scripts/verify-budget-merge.ts`（三级预算演进）

**Phase 11 前置验证结果（已完成）**

| 接口 | 状态 | 实测结果 |
|---|---|---|
| `GET /beike/status` | ✅ | 生效 Provider = BEIKE，凭证 `qKnb****7xaM`（脱敏正确） |
| `POST /beike/detail` | ✅ | 返回真实房源：华高苑北区 122㎡ 510万，地铁杨高北路 1008 米，学区上海立信会计金融学院附属高行中学 |
| `POST /beike/search` | ✅ | 「张江 三房」召回 **267** 套；「浦东三房 500万以内」召回 **2794** 套，各返回 10 套 |

**Phase 11 端到端实测结果（后端闭环已打通）**

四个真实轮次的完整测试：`apps/api/scripts/verify-wechat-flow.ts`（27 项断言）

| 轮次 | 客户输入 | 实测结果 |
|---|---|---|
| 1 | 想看浦东三房，500左右 | 召回 2795 套 → 硬筛 10 套 → 推荐 5 套（488~499万，均在设计预算内）｜ 10.2 秒 |
| 2 | 张江更好，550也可以 | **理想预算保持 500 万未被覆盖**，常规上限升至 550 万；识别张江板块 |
| 3 | 特别好的600也能考虑，不过不要老小区，我老婆比较在意小区环境，离地铁最好也别太远 | 极限上限 600 万；排除老小区；重视地铁；重视小区环境；配偶参与决策 |
| 4 | 第一套不错，就是有点贵，第二套位置不喜欢，最好还是靠张江近点 | 拆分为 2 条独立反馈；第 1 套 POSITIVE + 价格异议；第 2 套 NEGATIVE + 位置原因；识别"张江优先级提高" |

三级预算演进（需求 §8 的核心要求）：
```
第 1 轮后： target=500万
第 2 轮后： target=500万，normalMax=550万      ← target 未被新消息覆盖
第 3 轮后： target=500万，normalMax=550万，stretchMax=600万
```

推荐状态流转：`GENERATED` → `COPIED` → `SENT_CONFIRMED`（人工确认）✓
需求版本历史：v1(5项变化) → v2(2项) → v3(6项) ✓

详见 `IMPLEMENTATION_REPORT.md`。



### Phase 1 — 项目架构 · Docker · 数据库 · 认证 · 多租户

- [x] 1.1 Monorepo 骨架、workspace 配置、共享 tsconfig、Prettier
- [x] 1.2 `packages/types`：领域枚举与共享类型（编译零错误）
- [x] 1.3 `packages/utils`：通用工具（脱敏 / 格式化 / 评分算法 / 地理）
- [x] 1.4 `infrastructure/docker-compose.yml`：PostgreSQL 18 + pgvector 0.8.7、Redis 8，均为 healthy
- [x] 1.5 Prisma schema：36 张表 / 162 索引 / 2 个 pgvector 列
- [x] 1.6 迁移脚本（Prisma 7 流程）+ pgvector HNSW 与 pg_trgm 索引迁移
- [x] 1.6b 多租户 TenantScope + 21 项真机隔离测试全部通过
- [x] 1.7 `apps/api` NestJS 骨架：配置校验、结构化日志（自动脱敏）、全局异常、Zod 校验、Helmet、CORS、限流
- [x] 1.8 Auth：JWT（HS256）+ Refresh Token 轮换 + 重放检测（整族吊销）+ argon2id 密码哈希
- [x] 1.9 多租户隔离：AsyncLocalStorage 请求上下文 + 强制 `organizationId` 作用域 + 守卫
- [x] 1.10 RBAC：SUPER_ADMIN / OWNER / STORE_MANAGER / AGENT / VIEWER（角色 + 等级双重约束）
- [x] 1.11 审计日志（登录/失败/跨租户访问尝试均留痕，且日志自动脱敏）
- [x] 1.12 单元测试 28 项（AI 包）+ API 集成测试 25 项，全部通过
- [x] 1.13 房源 Provider 抽象 + MockPropertyProvider（上海 5 区 19 小区 1045 套可复现数据）
- [x] 1.14 贝壳官方 API 适配器骨架（认证/限流/重试/字段映射框架，无凭证时明确降级）
- [x] 1.15 房源同步服务（新增/更新/价格变化/状态变化/下架五类变化识别）
- [x] 1.16 种子数据脚本 + 数据诊断脚本 + 数据库重置脚本

**Phase 1 实测结果**

| 项目 | 结果 |
|---|---|
| 数据库表 | 36 张，162 个索引，2 个 pgvector 列 |
| 多租户隔离测试 | 21 / 21 通过 |
| AI 包单元测试 | 28 / 28 通过 |
| API 集成测试 | 25 / 25 通过 |
| 认证安全测试 | 8 / 8 通过（含重放检测与整族吊销） |
| **Playwright E2E** | **12 / 12 通过**（真实浏览器，Console 零报错） |
| 种子数据 | 2 组织 / 4 门店 / 28 用户 / 300 客户 / **2090 房源** / 8631 行为 / 2168 匹配 / 676 价格历史 / 128 机会 / 120 带看 |
| 成交概率评分 | 300 / 300 客户已评分，平均 51 分（HOT 26 / WARM 100 / COOL 167 / COLD 7） |
| 评分性能 | 150 位客户 772ms（批量聚合，无 N+1） |

### 开发中发现并修复的真实缺陷

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| D1 | `tsc` 构建静默失败：退出码 0 但只输出 12/24 个文件 | `incremental: true` 的 `tsconfig.tsbuildinfo` 与实际产物不一致 | 删 `dist` 时必须同时删 `.tsbuildinfo`；已写入环境事实 E16 |
| D2 | NestJS 依赖注入失败：`Nest can't resolve dependencies of TenantService` | `import type` 在运行时被擦除，Symbol 令牌无法从类型元数据推断 | 改用 `@Inject(APP_CONFIG)` |
| D3 | 应用启动崩溃：`class-validator package is missing` | NestJS 内置 `ValidationPipe` 强制依赖 class-validator | 移除该管道（本项目统一用 Zod）；已写入 E17 |
| D4 | 种子数据只入库 400 套房源（预期 2090） | Provider 的 `pageSize` 上限被截断到 200，只取了第一页 | 改为分页拉取；已修复并复验 |
| D5 | 客户 `behaviorEventCount` 全为 0，与行为记录数矛盾 | 种子脚本插入行为事件后未回填聚合字段 | 插入后统一回填 `behaviorEventCount` 与 `lastActiveAt` |
| D6 | 首页意向分全为 0 | 从未运行过评分引擎，种子数据未计算该字段 | 实现 7 维度评分引擎 + 重算脚本，300 位客户全部评分 |
| D7 | 低意向客户（35 分）排在**高意向客户（78 分）之前** | 排序只看机会优先级，两者同为 URGENT | 改为「价值分 ×0.6 + 意向分 ×0.4」的综合排序 |
| D8 | PowerShell 文本替换破坏中文注释编码 | `Set-Content -Encoding UTF8` 的编码往返问题 | 改用精确编辑工具；已建立全仓编码检查脚本 |

### Phase 2 — 客户 CRM · 客户画像 · 房源库 · Mock Provider

- [ ] 2.1 Customer 完整模型（含 30+ 需求字段）+ 客户状态机
- [ ] 2.2 CustomerProfile（显性需求）与 BehavioralProfile（隐性需求）双轨模型
- [ ] 2.3 Customer CRUD API + 分页 + 筛选 + 全局搜索
- [ ] 2.4 Property 完整模型（含图片、价格历史、Provider 记录）
- [ ] 2.5 PropertyProvider 抽象 + `NormalizedProperty` 统一模型
- [ ] 2.6 `MockPropertyProvider`：上海 5 区真实感模拟数据
- [ ] 2.7 `BeikePropertyProvider` 官方 API 适配器骨架（空实现 + 凭证就绪即接入）
- [ ] 2.8 `property-sync` 任务：新增 / 更新 / 价格变化 / 下架 / 重新挂牌
- [ ] 2.9 价格历史写入与查询
- [ ] 2.10 房源 API + 分页 + 筛选

### Phase 3 — 客户专属链接 · 客户端房源页 · 行为采集

- [ ] 3.1 `customer_share_links`：随机 token、过期、撤销、重新生成
- [ ] 3.2 客户端专属页面 `/c/[token]`（无需注册，不泄露真实客户 ID）
- [ ] 3.3 隐私说明与授权开关（关闭个性化推荐 / 拒绝行为分析 / 撤回授权 / 删除数据）
- [ ] 3.4 行为采集接口 `POST /behavior/event`（21 种事件类型）
- [ ] 3.5 `customer_behavior_events` 落库：sessionId、metadata JSONB、duration、device、ipHash
- [ ] 3.6 前端埋点 SDK（页面停留、图片、户型图、地图、小区、价格历史、收藏、对比、分享）
- [ ] 3.7 行为数据脱敏：仅存 ipHash，禁止通讯录/相册/第三方 App 历史

### Phase 4 — 行为画像 · 需求引擎 · 需求漂移

- [ ] 4.1 `behavior_scoring_rules` 表 + 管理员可调权重（禁止硬编码）
- [ ] 4.2 规则评分引擎（含负分：快速退出、多次跳过同类）
- [ ] 4.3 行为画像计算：价格 / 面积 / 区域 / 小区 / 房龄 / 装修 / 楼层 / 户型 / 地铁 / 通勤 / 学校 / 朝向
- [ ] 4.4 置信度计算与「客户说的 vs AI 观察到的」对比输出
- [ ] 4.5 需求漂移检测（30 天 vs 7 天对比）+ 漂移提醒与销售建议
- [ ] 4.6 `profile-recalculation` / `behavior-analysis` 任务

### Phase 5 — 智能匹配 · 反向匹配 · 可解释推荐

- [ ] 5.1 三阶段匹配：Hard Filter → Preference Score → AI Reranking
- [ ] 5.2 Match Score 0～100 与权重配置
- [ ] 5.3 可解释推荐（命中项 + AI 行为依据）
- [ ] 5.4 `customer_property_matches` 落库与增量更新
- [ ] 5.5 反向匹配 Property → Customer（降价后自动扫描客户）
- [ ] 5.6 `property-match` / `reverse-match` 任务
- [ ] 5.7 pgvector 语义相似度增强

### Phase 6 — 机会引擎 · 通知 · 每日 Dashboard

- [x] 6.4 Notification：类型 / 已读未读 / 优先级（列表 + 未读数 + 标记已读 + 删除）
- [x] 6.6 经纪人首页「今天 AI 帮你发现了什么」Dashboard（真实数据，非占位）
- [x] 6.7 今日重点客户 / 今日带看 / 待跟进 / 高意向
- [x] 6.7b 门店驾驶舱后端（漏斗诊断 + 经纪人横向对比 + 30 天预测）
- [x] 6.7c 客户成交概率评分引擎（7 维度加权 + 数据不足降权 + 状态修正）
- [ ] 6.1 Opportunity Engine：11 种机会类型（后台扫描逻辑）
- [ ] 6.2 机会价值评分与去重（已有种子数据，缺自动生成引擎）
- [ ] 6.3 `opportunities` 状态流转 API
- [ ] 6.5 `opportunity-detection` / `notification` 任务（BullMQ）

### Phase 10 — 前端（Next.js）

- [x] 10.1 设计系统：Tailwind 4 `@theme` 令牌、颜色克制、Linear/Stripe 风格
- [x] 10.2 UI 组件库（shadcn/ui 模式）：Button / Card / Badge / Input / Dialog / DropdownMenu / Table / Tabs / Tooltip / Progress / Skeleton / Avatar / Switch
- [x] 10.3 API 客户端：统一错误类型、自动刷新令牌、**刷新并发去重**（避免被误判为重放攻击）
- [x] 10.4 认证状态（Zustand）+ 会话过期自动登出
- [x] 10.5 应用外壳：桌面侧边栏 + 移动端底部导航 + 顶部栏
- [x] 10.6 登录页（产品价值说明 + 演示账号一键填充）
- [x] 10.7 工作台页面（AI 发现摘要为核心 + 重点客户卡片 + 带看/待跟进）
- [x] 10.8 Playwright E2E：**12/12 通过**（真实浏览器 + 真实登录 + Console 零报错）
- [x] 10.9 界面截图脚本（设计评审与回归对比）
- [ ] 10.10 客户列表 + 客户 360 详情页
- [ ] 10.11 房源库列表 + 房源详情页（图片/地图/价格历史/推荐理由）
- [ ] 10.12 销售机会页面（列表 + 处理动作）
- [ ] 10.13 通知中心页面
- [ ] 10.14 智能匹配页面（含「为什么推荐」可解释展示）
- [ ] 10.15 带看管理页面
- [ ] 10.16 门店驾驶舱页面（图表用 Recharts）
- [ ] 10.17 AI 助手页面（对话 + 流式输出）
- [ ] 10.18 客户专属页面 `/c/[token]`（含隐私说明与授权开关）
- [ ] 10.19 后台管理页面

### Phase 7 — 带看 · 沟通 · AI Sales Copilot

- [ ] 7.1 Viewing 完整流程（PLANNED…NO_SHOW）+ 带看反馈
- [ ] 7.2 语音记录服务抽象（文本优先，语音转写接口预留）
- [ ] 7.3 带看后 AI 分析：最喜欢哪套 / 反对点 / 价格接受度 / 下一步
- [ ] 7.4 Communications：渠道 / 方向 / 内容 / 情绪 / 意图
- [ ] 7.5 粘贴聊天记录 → AI 分析并更新画像
- [ ] 7.6 AI 跟进生成：微信 / 电话话术 / 短信 / 策略（11 种场景）
- [ ] 7.7 客户成交概率（AI 辅助判断，明确免责声明）
- [ ] 7.8 AI 聊天助手：RAG + Tool Calling（8 个工具）
- [ ] 7.9 SSE 流式输出

### Phase 8 — 店长驾驶舱 · 超管后台

- [ ] 8.1 店长驾驶舱：门店指标 + 经纪人表现对比
- [ ] 8.2 AI 诊断：转化漏斗瓶颈定位
- [ ] 8.3 30 天成交预测
- [ ] 8.4 超管后台：Organization / Store / Users / Plans / Subscription
- [ ] 8.5 AI 用量与 API 用量统计
- [ ] 8.6 Provider 管理 / 系统日志 / 任务监控 / 特性开关
- [ ] 8.7 行为评分规则配置界面 + AI Prompt 配置界面

### Phase 9 — 测试 · 安全 · 性能 · 生产部署 · 文档

- [ ] 9.1 单元测试（匹配算法、评分引擎、漂移检测、机会引擎、JWT）
- [ ] 9.2 集成/API 测试（Auth、租户隔离、客户 CRUD、行为、房源、匹配、带看、权限）
- [ ] 9.3 AI 接口 Mock 测试
- [ ] 9.4 Playwright E2E：登录 → Dashboard → 建客户 → 生成链接 → 客户端浏览 → 行为回流 → 画像 → 匹配 → 机会 → 跟进 → 带看
- [ ] 9.5 安全加固复检（Helmet / CORS / 限流 / 注入 / XSS / 越权 / 脱敏）
- [ ] 9.6 性能：索引复核、分页、消除 N+1
- [ ] 9.7 生产 Dockerfile（多阶段）+ Nginx + HTTPS + Compose
- [ ] 9.8 全部文档 + 测试报告

---

## 3. Seed 数据目标（Phase 2 / 6 完成后一次性生成）

| 实体 | 目标量 |
|---|---|
| Organization | 2 |
| Store | 4 |
| User（经纪人） | 20+ |
| Customer | 300 |
| Property | 1000 |
| BehaviorEvent | 5000+ |
| Opportunity | 100+ |
| Viewing | 50+ |
| 价格变化记录 | 数百条 |
| 客户需求漂移记录 | 数十条 |

Demo 城市：**上海**（浦东、徐汇、闵行、静安、杨浦）。
所有模拟房源必须在界面上明确标注 **Demo Data**，不得暗示数据来自真实贝壳。

---

## 4. 验收标准（最终必须真实跑通）

```
pnpm install → docker compose up → migration → seed → 打开浏览器 → 登录
→ Dashboard → 创建客户 → 生成客户专属链接 → 打开客户页面 → 浏览房源
→ 产生 Behavior Events → 回后台看到浏览历史 → 画像更新 → 匹配生成
→ 查看 Match Score 与推荐原因 → 模拟降价 → 产生 Opportunity
→ 收到 Notification → AI 生成跟进微信 → 创建带看 → 提交带看反馈
→ AI 生成下一步建议
```

全过程必须真实执行，并检查 Console / Network / 后端日志，修复所有报错后重测。

---

## 5. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-08 | 完成环境勘查：修复工作区权限故障；确认 pnpm 12 / Docker / 代理等 14 项环境事实（E1–E14）；建立 Monorepo 骨架 |
