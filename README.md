# EstatePilot AI · 房产 AI 成交助手

> **通过客户真实行为 + 房源变化 + AI，让经纪人每天知道最应该联系谁、推荐什么房、下一步怎么推进。**

面向 **5–100 人房产中介团队**的多租户 SaaS。不是"另一个贝壳"，不是房源信息网站，也不是普通 CRM ——
核心是把「客户说了什么 → 该推哪套房 → 微信该怎么说」这条链路自动化。

---

## 核心闭环

```
经纪人粘贴客户微信消息
        ↓
AI 理解需求（城市/区域/预算/户型/面积/学区/地铁…）
        ↓
合并进客户画像（识别"改口"，自动清理跨城市脏数据）
        ↓
检索真实房源（贝壳官方接口）→ 硬性条件过滤 → 九维打分排序
        ↓
生成 Top 3–5 推荐 + 可直接发送的微信文案
        ↓
经纪人一键复制 → 微信发送 → 记录推荐历史
```

**设计原则**

| 原则 | 说明 |
|---|---|
| **不编造** | 拿不到的数据显示"暂无数据"，绝不猜测填充 |
| **可信度可见** | 每条房源标注来源与核验时间；缓存数据明确标注"非实时" |
| **优雅降级** | 贝壳不可用时自动改用本地已入库的真实房源，功能不中断 |
| **合规优先** | 不使用爬虫抓取第三方平台数据 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16 · React 19 · Tailwind CSS 4 · Radix UI · TanStack Query 5 · Zustand 5 |
| 后端 | NestJS 12 · TypeScript 5.9 · Zod 4 |
| 数据库 | PostgreSQL 18 + pgvector · Prisma 7 |
| 缓存/队列 | Redis 8 |
| 测试 | Vitest 4（单元）· Playwright 1.63（E2E） |
| 外部数据 | 贝壳 MCP（JSON-RPC 2.0 over SSE） |

**运行环境要求**

- Node.js **>= 22.0.0**
- pnpm **>= 10.0.0**（本项目用 pnpm@12.10.1）
- Docker（用于跑 PostgreSQL 与 Redis）

---

## 目录结构

```
EstatePilot-AI/
├── apps/
│   ├── api/                  NestJS 后端（业务逻辑主体）
│   │   ├── src/modules/
│   │   │   ├── requirement/  核心：需求解析 → 检索 → 评分 → 推荐
│   │   │   ├── property/     房源与数据源（含贝壳 MCP 客户端）
│   │   │   ├── customer/     客户管理
│   │   │   ├── auth/         认证与多租户
│   │   │   └── ...
│   │   └── scripts/          验证与诊断脚本（见下方"验证"）
│   └── web/                  Next.js 前端
├── packages/
│   ├── types/                共享类型定义
│   ├── utils/                共享工具
│   ├── database/             Prisma schema 与迁移
│   └── ai/                   AI Provider 抽象（可换模型）
├── infrastructure/
│   ├── docker-compose.yml    PostgreSQL + Redis
│   ├── postgres/init/        数据库扩展初始化（pgvector / pg_trgm）
│   └── beike/                贝壳 CLI 安装脚本（二进制不提交）
└── docs/                     设计与诊断文档
```

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

**关于 `node_modules`**：本仓库**不提交** `node_modules`，而是通过 `pnpm-lock.yaml` 锁定
**1373 个依赖**的精确版本。`pnpm install` 会完整重建，结果与开发环境一致。
（提交 node_modules 会产生 10 万+ 文件，且跨平台不可用。）

### 2. 配置环境变量

```bash
cp .env.example .env
```

**必须修改的项**（默认值仅供本地开发）：

| 变量 | 说明 |
|---|---|
| `JWT_SECRET` | 改成随机长字符串（≥32 字符） |
| `JWT_REFRESH_SECRET` | 同上 |
| `IP_HASH_SALT` | 用于行为日志的 IP 脱敏，改成随机值 |

**可选**：`BEIKE_MCP_API_KEY` —— 不填则贝壳数据源不可用，
系统会只用本地已入库的房源（`PROPERTY_PROVIDER=MOCK` 时为纯演示数据）。

### 3. 启动依赖服务

```bash
pnpm infra:up        # 启动 PostgreSQL 18 + pgvector 与 Redis 8
pnpm infra:ps        # 查看状态
```

> ⚠️ **已知陷阱**：PostgreSQL 18 官方镜像的数据目录改为 `/var/lib/postgresql`，
> 不要挂载 `/var/lib/postgresql/data`（详见 `DEVELOPMENT_ENVIRONMENT.md`）。
> 本项目的 compose 文件已正确处理。

### 4. 初始化数据库

```bash
pnpm db:generate     # 生成 Prisma Client
pnpm db:deploy       # 应用迁移（5 个迁移文件）
```

**迁移文件清单**（`packages/database/prisma/migrations/`）：

| 迁移 | 内容 |
|---|---|
| `20261008072102_init_estatepilot_core` | 核心表：组织/门店/用户/客户/房源/推荐 |
| `20261008080000_vector_and_trgm_indexes` | pgvector 与 pg_trgm 全文检索索引 |
| `20261008092211_wechat_requirement_recommendation` | 需求画像、快照、推荐批次 |
| `20261009150000_phase12_property_verification` | 数据可信度与核验字段 |
| `20261009223135_phase15_property_full_detail` | 房源完整详情持久化（`fullDetail`） |

### 5. 启动开发服务

```bash
pnpm dev             # 同时启动 API（:3001）与 Web（:3000）
```

或分别启动：

```bash
pnpm dev:api
pnpm dev:web
```

打开 http://localhost:3000

---

## 常用命令

```bash
# 开发
pnpm dev                 # 并行启动 apps/*
pnpm dev:api             # 只启动后端
pnpm dev:web             # 只启动前端

# 构建
pnpm build               # 按依赖顺序构建全部包
pnpm typecheck           # 全仓类型检查（6 个包）

# 测试
pnpm test:unit           # 后端单元测试
pnpm test:e2e            # 后端 E2E
pnpm e2e                 # Playwright 浏览器测试
pnpm test:all            # typecheck + lint + test

# 数据库
pnpm db:generate         # 生成 Prisma Client
pnpm db:migrate          # 创建新迁移（开发）
pnpm db:deploy           # 应用已有迁移（部署）
pnpm db:studio           # Prisma Studio 可视化

# 基础设施
pnpm infra:up / infra:down / infra:logs / infra:ps
```

> **修改 Prisma schema 后必须执行**：`pnpm db:generate` **并重建 database 包**
> （`pnpm --filter @estatepilot/database build`），否则下游包引用不到新类型。

---

## 多租户

所有数据库访问都经过 `TenantScope`（`packages/database/src/tenant-scope.ts`）：

- 通过 `TENANT_SCOPED_MODELS` 白名单强制注入 `organizationId`
- 未在白名单的模型**会直接报错**，而不是静默返回全量数据
- 需要原生 SQL 时用 `unsafeRaw()`，**必须**显式带 `organizationId` 条件

设计意图：让"忘记加租户过滤"在开发期就暴露，而不是在生产期变成数据泄露。

---

## 贝壳数据源

项目通过**官方 MCP 接口**（`building.ke.com/mcp`）获取真实房源，
支持两条传输通道：

| 通道 | 说明 |
|---|---|
| `http` | 直连 HTTP MCP（默认优先） |
| `cli` | 本地贝壳 CLI 子进程（HTTP 不可用时回退） |
| `auto` | 自动选择（默认） |

用 `BEIKE_TRANSPORT` 环境变量控制（`http` / `cli` / `auto`）。

### ⚠️ 调用配额限制（重要）

贝壳**不公开配额**，也**不返回限流信号**（限流时返回 `HTTP 200` + 正文
`service temporarily unavailable`，无 `Retry-After` 头）。实测被限流后
**可能持续 1 小时以上**。

因此本项目内置了多层保护：

| 机制 | 作用 |
|---|---|
| **按需加载详情** | 列表只用搜索摘要，点开某套才取完整详情 → 一次搜索从 11 次调用降到 1 次 |
| **详情缓存 + 落库** | 同一房源 30 分钟内不重复请求；已获取的详情存库，限流期间仍可展示 |
| **节流器** | 全局最小调用间隔 400ms，失败自动退避到 2s |
| **预算护栏** | 每小时/每日调用上限，**打满前主动停手**并降级到缓存 |
| **限流冷却** | 检测到限流即暂停 10 分钟实时调用 |
| **运维开关** | 可一键切到"纯缓存模式"，功能不中断 |

**调整护栏阈值**（环境变量）：

```bash
BEIKE_HOURLY_LIMIT=20    # 每小时上限
BEIKE_DAILY_LIMIT=100    # 每日上限
```

> **规模提示**：限流按**账号**计，多个经纪人共用同一份额度。
> 免费接口适合 1–3 人团队；5 人以上建议使用多数据源分摊，
> 30 人以上需要与贝壳建立正式合作。

---

## 验证与诊断

项目在 `apps/api/scripts/` 下提供可执行验证脚本（不依赖测试框架）：

```bash
cd apps/api

# 逻辑验证（不需要网络）
node --experimental-strip-types scripts/verify-xiamen.ts           # 厦门地区映射（86 项）
node --experimental-strip-types scripts/verify-phase12.ts          # 可信度与 Demo 隔离（36 项）
node --experimental-strip-types scripts/verify-provider-layer.ts   # 数据源层（33 项）
node --experimental-strip-types scripts/verify-dedup.ts            # 多源去重（27 项）
node --experimental-strip-types scripts/verify-aggregator.ts       # 聚合层（34 项）
node --experimental-strip-types scripts/verify-rate-limit.ts       # 节流与缓存（16 项）
node --experimental-strip-types scripts/verify-quota-guard.ts      # 预算护栏（23 项）

# 数据库相关（需 DATABASE_URL）
node --experimental-strip-types scripts/verify-detail-persistence.ts

# 贝壳接口诊断（需 BEIKE_MCP_API_KEY，会消耗配额）
node --experimental-strip-types scripts/test-beike-connection.ts    # 连接与握手
node --experimental-strip-types scripts/verify-beike-detail.ts      # 完整详情解析
node --experimental-strip-types scripts/probe-beike-quota.ts        # 探测是否有配额查询接口
```

**已通过的验证规模**：278 项逻辑断言 + 17 项 Playwright E2E。

---

## 文档

| 文件 | 内容 |
|---|---|
| `PROJECT_REPORT.md` | 项目总体报告 |
| `PHASE12_REAL_SALES_MVP_REPORT.md` | 真实销售 MVP 验收报告 |
| `MULTI_PROVIDER_IMPLEMENTATION_REPORT.md` | 多数据源架构 |
| `DEVELOPMENT_PLAN.md` | 开发计划与已知陷阱 |
| `DEVELOPMENT_ENVIRONMENT.md` | 环境搭建细节 |
| `docs/MULTI_PROVIDER_ARCHITECTURE.md` | 数据源抽象设计 |
| `docs/BEIKE_FIX_REPORT.md` | 贝壳接入问题排查记录 |
| `docs/REGION_FILTER_AND_BEIKE_DIAGNOSIS.md` | 区域过滤与限流诊断 |
| `docs/china-property-platform-data-access-compliance-report.md` | 数据获取合规分析 |

---

## 数据合规说明

本项目**不包含也不计划包含**以下能力：

- 爬虫抓取贝壳/安居客/58 等平台的房源数据
- 微信 Hook、DLL 注入、PC 微信逆向、模拟个人微信协议
- 读取微信数据库或自动抓取聊天记录
- 自动控制微信客户端或代客户群发消息

**数据来源仅限**：

1. 贝壳**官方** MCP 接口（需自行申请 Key）
2. 经纪人**手工录入**的房源（`UserProvidedPropertyProvider`）

**背景**：链家/天津小屋 诉 推推99 案（北京海淀法院）判决
**550 万元**连带赔偿，二审撤回上诉、**判决已生效**，并含行为禁令。
法院明确认定：*"涉案数据虽是二原告向公众无差别的予以提供和展示的公开数据，
但这并不意味着其他经营者可以不受任何限制的获取和使用。"*

侵权模式为「抓取 → 存自家服务器 → **去除水印** → 展示/下载/转发」，
**下游使用同样承担责任**。故本项目不采用该模式。

---

## 许可

私有项目，未经授权请勿分发。
