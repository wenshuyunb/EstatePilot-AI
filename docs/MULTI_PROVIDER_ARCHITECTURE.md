# Multi Property Provider Architecture Design
# EstatePilot 多房源供应商聚合架构设计

> 版本 v1.0 · 设计文档（不含实现）
> 目标：把 EstatePilot 从「贝壳 AI 助手」升级为「中国房地产 AI 房源智能搜索与成交系统」

---

## 0. 执行摘要

### 0.0 ⚠️ 发布前必读：两个法律风险（合规调研结论）

> 完整调研报告见 [china-property-platform-data-access-compliance-report.md](./china-property-platform-data-access-compliance-report.md)（382 行，含来源 URL 与证据分级）

#### 风险 A：贝壳 AI 开放平台的授权范围可能不支持商用 🔴

| 事实 | 来源 |
|---|---|
| `building.ke.com` 是「贝壳 AI 开放平台」，`/mcp` 端点真实（GET 返回 405，符合 MCP 只收 POST） | [已实测] |
| GitHub `LianjiaTech/beike-ai-platform` 提供 7 个 Skill（含房源搜索、小区详情、价格行情） | [官方原文] |
| `beike login` 自助取 API Key，存于 `~/.beike/BEIKE_MCP_API_KEY` | [官方原文] |
| **Skill 许可写明「贝壳内部使用」/「商业软件，仅限授权用户使用」** | [官方原文] |
| **用户协议 ID：`beike_AI_open_Platform_private_protocol`**（协议名含 `private`） | [官方原文] |
| 未找到任何公开的商用授权条款 | [未能验证] |

**结论**：技术上可取 Key、可调用；**但法务上我们没有找到"允许第三方 SaaS 商用"的依据。**

**必须做的事**：
1. **立即**通过官方渠道（`jiaoxiadan001@ke.com`）**书面确认**：
   "我方是 B2B SaaS，为经纪公司提供 AI 匹配服务，通过我方系统调用 `building.ke.com` MCP 是否在授权范围内？"
2. **在获得书面确认前**，不要对外宣传"已对接贝壳官方 API"，不要在 BD/融资材料中这样写
3. 这也是**多源架构的另一重意义**：如果贝壳授权谈不下来，架构上可以不依赖它

#### 风险 B：已有生效判例，赔偿 550 万，且裁判规则对我们不利 🔴

**北京链家、天津小屋 诉 北京/成都神鹰城讯（"推推99"）**
北京市海淀区人民法院一审：**连带赔偿 500 万 + 50 万 = 550 万元**，
被告上诉后**撤回，判决已生效**，并发出**行为保全**（禁止以任何形式向其他主体提供涉案数据）。

来源：[辽宁省高级人民法院转载](https://ykgz.lncourt.gov.cn/article/detail/2023/01/id/7113312.shtml)

**被告的侵权形态 —— 几乎就是"房源数据 SaaS"的标准做法**：
抓取贝壳房源的**基本信息 / 交易信息 / 实勘图 / VR图 / 户型图**
→ 存自有服务器 → **去水印** → 向用户展示、供编辑下载、**转发第三方平台**
→ 且**伪装真实用户访问百万次**。

**核心裁判规则（判决原文）**：
> 「涉案数据虽是二原告**向公众无差别的予以提供和展示的公开数据**，
> 但这**并不意味着其他经营者可以不受任何限制的获取和使用**。」

> ⚠️ **这条规则直接否定了"公开数据就能抓"这个常见误解。**

**另一条对我们尤其重要的认定**：法院认为被告行为
"实为房产经纪公司或经纪人发布**虚假房源**提供了重要工具和便利条件" ——
**即：下游客户怎么用数据，会成为你的责任。**

**对本项目的直接约束**：
1. 绝不做抓取、绝不去水印、绝不伪装用户
2. 必须能证明**每一条房源的合法来源**（这正是本设计"来源标注 + 凭证类型"的合规价值）
3. 必须防止"房源被用于发布虚假房源"——本项目已有防线（房源必须来自 Provider、不可手编假数据）

#### 风险 C：政府开放数据不可转售

深圳市政府数据开放平台有**真实活跃 API**（二手房成交按日统计，7 日调用 5111 次），
支持机构注册 + 广东省统一认证 OAuth。

**但服务条款原文**：
> 「用户**不得有偿或无偿转让**在开放平台中获取的任何数据资源」

**结论**：可用于**内部分析与派生指标**（如行情判断、议价参考），
**不可原样转售给 SaaS 客户**。

---

### 0.1 一句话结论

**架构方向完全正确，但存在一个必须正视的现实约束：**

> 经完整调研：**中国主流商业房源平台（贝壳、安居客、58、房天下、幸福里）
> 没有任何一家向第三方 SaaS 开放"批量获取二手房列表 + 详情 + 图片"的公开 API。**
>
> 它们的开放平台方向是**反的** —— 帮经纪公司「**发房**」进平台（入向），
> 而非让第三方「**拉数据**」出来（出向）。

**证据**：房软、房在线、众趣等多家房产 ERP 做的**全是"推房源上平台"**，
无一家"从平台拉房源"。

这意味着多源架构的真正价值**不是**"立刻能同时搜 4 个平台"，而是：

| 价值 | 说明 | 能否立刻交付 |
|---|---|---|
| **消除单点依赖** | 接入经纪公司自有房源，贝壳挂了系统仍有真实房源 | ✅ 立刻可做 |
| **来源可扩展** | 官方授权就绪时，新数据源只需实现一个 Adapter | ✅ 立刻可做 |
| **来源透明** | 每条房源显示来自哪个平台，经纪人可判断可信度 | ✅ 立刻可做 |
| **跨源归并** | 同一套房在多个平台出现时合并，不重复推荐 | ✅ 立刻可做 |
| **合规可审计** | 每个数据源的合法性可追溯，避免法律风险 | ✅ 立刻可做 |

**本设计的核心判断**：先建成平台，再等商务。数据源会陆续到位，但架构必须先对。

### 0.2 对现状的诊断

现有代码**已经具备多源雏形**（这是好消息）：

- `PropertyProviderKind` 枚举已预留 `ANJUKE` / `INTERNAL`
- `NormalizedProperty` 统一模型已存在
- `PropertyProvider` 接口已定义
- `PropertyProviderRecord` 数据库表已存在（多源快照，但**尚未被使用**）
- `PropertyImportService` 已有文本粘贴导入 + 指纹去重

**但有 5 个必须修的结构性问题**（详见 §1.2）：

1. **业务层直接依赖贝壳** —— `wechat-assistant.orchestrator.ts` 直接 `catch` 贝壳错误、直接构造 `BeikePropertyProvider`
2. **指纹去重只覆盖导入路径** —— 贝壳入库时**不写 fingerprint**，跨源去重实际不生效
3. **存在三份不一致的归一化实现** —— 跨源匹配失败的根因（新增发现）
4. **`communityNormalized` 里有一行空操作代码** —— 正则写成 `match => match`，等于没做归一
5. **多源快照表在闭环路径上不写入** —— `PropertyProviderRecord` 只有 `property-sync.service.ts` 会写

---

## 1. 现状评估

### 1.1 已经做对的部分（保留，不重写）

| 能力 | 位置 | 评价 |
|---|---|---|
| 统一房源模型 | `packages/types/src/property.ts` → `NormalizedProperty` | ✅ 字段完整，含 `externalProvider` / `externalId` / `rawData` |
| Provider 接口 | 同上 → `PropertyProvider` | ✅ 有 `isConfigured` / `fetchProperties` / `fetchPropertyDetail` / `fetchStatusChanges` |
| Provider 注册表 | `providers/provider-registry.ts` | ✅ 有注册、状态列举、未配置时降级到 Mock |
| 文本粘贴导入 | `property-import.service.ts` | ✅ 已支持从任意平台复制文本导入 |
| 指纹去重 | `property-import.service.ts` → `buildFingerprint` | ⚠️ 算法可用，但覆盖面不足（见 1.2） |
| 多源快照表 | `property_provider_records` | ⚠️ 已建表，但**只在同步路径写入**（见 1.2 问题 5） |
| 跨源匹配字段 | `Property.communityNormalized` / `districtNormalized` | ⚠️ 有字段，**三份实现不一致**（见 1.2 问题 3） |

### 1.2 必须修的结构性问题

#### 问题 1：业务层直接依赖贝壳

**审计实测数据**（重构范围量化）：

| 指标 | 实测值 |
|---|---|
| 需求模块中直接 `import` 贝壳的文件 | **仅 2 个** |
| ├ `wechat-assistant.orchestrator.ts` | import + 17 处 `beike/Beike/BEIKE` 引用 |
| └ `wechat-assistant.controller.ts` | import 用于能力探测 |
| 编排器内贝壳专属错误类 | `BeikeTemporarilyUnavailableError`（L233） |
| 编排器内手写实例化 | **L503 / L969：`new BeikePropertyProvider(...)`** ⚠️ 绕过依赖注入 |
| 对外 DTO 字段名 | **`beikeStats`**（L170/L921）、`beikeTotalRecalled`（L884） |

**关键耦合点清单**：

| 行号 | 内容 | 耦合性质 | 重构动作 |
|---|---|---|---|
| L48-49 | `import { BeikePropertyProvider, BeikeCliError }` | 静态依赖 | 改为注入 `PropertyProviderRegistry` |
| L233 | `class BeikeTemporarilyUnavailableError` | 错误语义绑定 | 改为通用 `ProviderUnavailableError` |
| L288 | 构造函数注入 `BeikeMcpClient` | DI 绑定 | 改为注入抽象 Provider |
| **L503** | **`new BeikePropertyProvider(this.beikeClient)`** | **手写实例化（反模式）** | 从注册表获取 |
| L529 | `this.beikeClient.searchHouses(...)` | 直接调用具体客户端 | 改调 `provider.search()` |
| L642 | `describeBeikeError(error)` | 错误翻译绑定 | 改为 `ProviderError` 的通用翻译 |
| L921 | DTO 返回 `beikeStats` | **对外契约绑定** | 改为 `sourceStats`（需前端同步改） |
| L1066 | `describeBeikeError` 方法 | 逻辑绑定 | 上移到 Provider 层 |

**为什么是问题**：这是您指出的"错误架构"：
```
Customer → Beike API → Recommendation   ❌
```
**后果**：
- 新增数据源要改编排器（违反开闭原则）
- 错误处理与供应商强绑定，无法统一降级
- "贝壳不可用"这个语义泄漏到业务层，未来"安居客不可用"要再写一遍
- **对外 DTO 字段名叫 `beikeStats`** —— 连 API 契约都绑死了贝壳

**正确目标**：
```
Customer → Matching Engine → PropertyProvider 接口 → N 个供应商  ✅
```

#### 1.2.1 重构接缝（最重要的发现）

审计发现：**整个搜索路径只有一处直接接触贝壳** ——
`wechat-assistant.orchestrator.ts:525-543` 的 `attemptSearch`：

```js
const attemptSearch = async (searchQuery, options) => {
  const searchResult = await this.beikeClient.searchHouses({        // L529 ← 贝壳专属
    city: searchQuery.city, query: searchQuery.naturalQuery, houseType: 'second',
  });
  const entities = searchResult.parsed.entities.filter(             // L535 ← 贝壳数据结构
    (entity) => entity.kind === 'house',
  );
  const candidates = await provider.mapEntitiesForReuse(            // L536 ← 贝壳专属映射
    entities, searchQuery.city,
  );
  const filterResult = this.hardFilter.filter(candidates, searchQuery);  // L537 ← 已经是抽象的 ✅
  return { query, searchQuery, candidates,  totalRecalled, filterResult, relaxed };
};
```

**这个结构对重构极其有利**：

| 层 | 当前状态 | 重构动作 |
|---|---|---|
| L529 搜索调用 | 贝壳专属 | 换成 `registry.searchAll(query)` |
| L535 数据结构解析 | 贝壳的 `parsed.entities` | **下沉到贝壳适配器内部** |
| L536 实体映射 | `mapEntitiesForReuse`（贝壳专属公开方法） | **下沉到贝壳适配器内部** |
| L537 硬筛 | **已经是抽象的**（接收 `NormalizedProperty[]`） | **零改动** |

**结论**：`HardFilterService` 与 `MatchScoringService` **本来就是来源无关的** ——
它们只接收 `NormalizedProperty[]`。这意味着重构的实质是：

> **把 L529–L536 三行"贝壳专属操作"替换成一次抽象的 `searchAll()` 调用，
> 其余全部业务逻辑（硬筛、打分、去重、文案生成）完全不动。**

这是**低风险重构**，而不是推倒重来。审计结论支持从 P2 直接开始。

#### 1.2.2 三份归一化实现的分歧（跨源匹配失败的根因）

已并入 §1.2 问题 3。

> 💡 **重构可控性结论**：耦合集中在**单个文件的 17 处**，
> 且大部分是机械替换（import → 注入、`beikeStats` → `sourceStats`）。
> **不需要重写编排器的业务逻辑**，风险低于预期。
> 唯一需要小心的是 L503/L969 的手写实例化 —— 它绕过了 Nest 依赖注入，
> 改成注册表获取时要确保生命周期正确。

#### 问题 2：指纹去重不覆盖贝壳

**证据**：`buildFingerprint` 只在 `property-import.service.ts` 里调用；
`property-upsert.service.ts`（贝壳入库路径）只写 `communityNormalized`，**不写 fingerprint**。

**后果**：同套房如果先由贝壳入库、后由导入入库，**会产生两条记录**。

#### 问题 3：存在三份不一致的归一化实现（跨源匹配失败的根因）

**实测证据**（同一函数逻辑跑真实小区名）：

| 位置 | 实现细节 | `玉兰香苑(四期)` | `浦东XX花园` |
|---|---|---|---|
| `property-import.service.ts:buildFingerprint` | 去括号 + 去空格 + 小写 | `玉兰香苑` | `浦东xx花园` |
| `property-upsert.service.ts:normalizeCommunity` | 去空格 + 去括号 + **无效后缀正则** | `玉兰香苑` | `浦东XX花园` |
| `property-sync.service.ts:normalizeCommunity` | 去括号 + 去空格 + 小写 | `玉兰香苑` | `浦东xx花园` |

**三重危害**：
1. **大小写不一致**：`浦东XX花园` 与 `浦东xx花园` 是**不同字符串**，跨源匹配直接失败
2. **三份实现会各自漂移**：改一处忘另两处，行为越来越不一致
3. **都无法处理行政区前缀**：`浦东XX花园` 与 `XX花园` 归一化后不相等 ——
   这正是您在需求 §7 举的例子，**当前代码做不到**

**修法**：抽取**唯一**的 `CommunityNormalizerService`，三处统一调用，并补充
"同城市同行政区内去除行政区前缀"的能力（保守策略，见 §6.2）。

#### 问题 4：`communityNormalized` 里有一行空操作代码

**证据**：`property-upsert.service.ts:415`
```js
.replace(/(小区|花园|公寓|大厦|苑|城|湾|府|园)$/u, (match) => match)
```
匹配到后缀却原样返回 —— 这是一行**无效代码**（作者本意可能是"保留后缀"，
但 `match => match` 等于什么都没做）。

#### 问题 5：多源快照表与多源配置表都是「建了但零使用」

**`PropertyProviderRecord`（`schema.prisma:1075-1099`）**

字段完整：`provider` / `externalId` / `payload Json` / `changeType` / `syncBatchId` / `success` / `errorMessage`。

**但业务路径上从未被写入。** 唯一写入点 `property-sync.service.ts:488` 位于
`logProviderRecord()` ← `applyUpdate()` ← `sync()` 调用链上，而 **`sync()` 没有任何调用者**。

> 即：写入这条链的入口是死代码。`PropertySyncService` 整个类
> 除 `property.module.ts` 的注册外无消费者，`syncDistrict` 也无调用者。

**`PropertyProviderConfig`（`schema.prisma:1103-1138`）**

**整个业务代码零引用。** 但它已具备多源配置所需的**全部字段**：

| 现有字段 | 用途 |
|---|---|
| `provider` + `@@unique([organizationId, provider])` | 按租户按源配置 |
| `enabled` + `@@index([provider, enabled])` | 管理员开关 |
| `usePlatformCredentials` | 平台凭证 vs 租户自备凭证 |
| `appId` / `appKey` / `appSecretEncrypted` / `baseUrl` / `cityCode` | 凭证与端点 |
| `rateLimitPerMinute` | 限流 |
| `syncCron` | 同步调度 |
| `lastSyncAt` / `lastSyncStatus` / `lastSyncError` / `lastSyncCount` | 健康度 |

> 💡 **这是本设计最大的意外收获**：需求 §12 的"数据源管理"**不需要新建配置表**，
> 只需启用这张已有表 + 补一个 `provider_health`（或把健康字段并入本表）。

**修法**：
1. `PropertyUpsertService`（闭环主路径）入库时同步写 `PropertyProviderRecord`，
   并补 `isPrimary`（主来源）、`sourceUrl`（原始链接）
2. 启用 `PropertyProviderConfig` 作为数据源管理的数据层
3. `PropertySyncService` 要么删除，要么重写为多源同步器（当前是死代码）

---

## 2. 目标架构

### 2.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│  接入层  API / Web                                          │
│  POST /customers/:id/wechat-assistant                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  编排层  WeChatPropertyAssistantOrchestrator                 │
│  只做流程编排，**不认识任何具体供应商**                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  匹配引擎  Matching Engine                                   │
│  ├─ SearchQueryBuilder   需求 → 标准查询条件                  │
│  ├─ MultiSourceAggregator 并发调多源 + 合并                   │
│  ├─ DeduplicationEngine  跨源归并同一房源                     │
│  ├─ HardFilterService    确定性硬筛                          │
│  └─ MatchScoringService  9 维打分（**不看来源**）              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Provider 抽象层  PropertyProvider 接口                      │
│  + ProviderHealthMonitor（健康度与熔断）                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
    ┌──────────┬───────────┼───────────┬──────────┬──────────┐
    ▼          ▼           ▼           ▼          ▼          ▼
 Beike     Anjuke       58         Fang      Internal    Local
 Provider  Provider   Provider   Provider   Provider   Provider
 (已实现)   (待授权)   (待授权)    (待授权)   (可立即)   (按城市)
```

### 2.2 关键设计原则

| 原则 | 含义 | 验证方式 |
|---|---|---|
| **业务层零供应商感知** | 编排器不 import 任何 Provider 实现 | 代码检查：`orchestrator` 无 `beike` 字样 |
| **统一错误语义** | 供应商错误统一为 `ProviderError`，带 `kind` 与 `retryable` | 单一错误类型 |
| **AI 打分不看来源** | 打分函数签名不含 `provider` 字段 | 代码检查 |
| **来源必须可见** | 每条房源带来源标签，界面强制展示 | E2E 断言 |
| **失败必须可降级** | 任一源失败不影响其它源结果 | 故障注入测试 |
| **合规可追溯** | 每个源的授权依据记录在案 | 配置 + 文档 |

---

## 3. Provider 抽象层设计

### 3.1 接口设计（在现有基础上扩展）

现有接口已覆盖大部分需求，需要**补充 3 个方法**与**统一错误类型**：

```
interface PropertyProvider {
  readonly kind: PropertyProviderKind;
  readonly capability: ProviderCapability;   // 新增：能力声明

  isConfigured(): boolean;
  healthCheck(): Promise<ProviderHealth>;    // 新增：健康探测

  search(query: PropertySearchQuery): Promise<ProviderSearchResult>;
  getDetail(id: string): Promise<NormalizedProperty | null>;
  getImages(id: string): Promise<PropertyImage[]>;      // 新增（从 getDetail 拆出）
  getCommunity(id: string): Promise<CommunityProfile | null>;  // 新增
  checkAvailability(id: string): Promise<AvailabilityResult>;  // 新增
}
```

**为什么这样拆**：您要求的方法（`search` / `getDetail` / `getImages` / `getCommunity` /
`checkAvailability`）比现有接口更贴合真实使用场景。特别说明两点：

- `getImages` 独立出来：图片往往需要**单独一次调用**（贝壳就是 `buy material` 接口），
  且并非所有源都提供
- `checkAvailability` 独立出来：**这是房源的"真相"来源**。列表数据可能过期，
  发送给客户前必须能核验"是否仍在售"。贝壳的 `已过户/已签约` 状态就是通过它发现的

### 3.2 能力声明（ProviderCapability）

不同源能力不同，业务层必须能查询"这个源支不支持图片/学区/成交价"：

```
interface ProviderCapability {
  supportsImages: boolean;
  supportsFloorPlan: boolean;
  supportsCommunity: boolean;      // 小区详情（容积率/物业费）
  supportsSchool: boolean;
  supportsSubway: boolean;
  supportsSoldHistory: boolean;    // 成交记录
  supportsRealtimeAvailability: boolean;  // 能否核验实时在售状态
  maxResultsPerQuery: number;      // 单次返回上限（贝壳约 10）
  cities: string[] | 'ALL';
  rateLimit: { requestsPerMinute: number; dailyQuota: number | null };
}
```

**为什么必须**：贝壳单次只返回约 10 条（实测），这个限制必须显式声明，
否则上层无法做正确的搜索策略（如分页补偿）。

### 3.3 统一错误模型

```
class ProviderError extends Error {
  provider: PropertyProviderKind;
  code: ProviderErrorCode;   // NOT_CONFIGURED | UNAVAILABLE | RATE_LIMITED
                             // | AUTH_FAILED | INVALID_QUERY | EMPTY_RESULT | UNKNOWN
  retryable: boolean;
  retryAfterMs: number | null;
  originalError?: Error;
}
```

**收益**：编排器只需处理 `ProviderError`，`retryable` 决定是否重试，
`provider` 用于展示"哪个源出问题了"。新增供应商**零改动**。

### 3.4 Provider 清单（含调研结论）

> 调研结论摘要：**五家主流平台均不向第三方 SaaS 提供"房源列表+详情+图片"的公开 API。**
> 它们的开放方向是"帮经纪公司发房"（入向），不是"让第三方拉数据"（出向）。
> 详见 [合规调研报告](./china-property-platform-data-access-compliance-report.md)。

| Provider | 官方 API | 真实接入条件 | **能否拿到房源明细** | 状态 | 优先级 |
|---|---|---|---|---|---|
| `BEIKE` | ✅ `building.ke.com` | 自助取 Key，**但许可写"内部使用"、协议 `private_protocol`** | ⚠️ **能拿到，但商用授权待确认**（风险 A） | **已实现** | P0 |
| `INTERNAL` | — | 自有数据，无第三方权利 | ✅ **完全可控** | **待实现（可立即）** | **P0** |
| `ANJUKE` | ⚠️ 与 58 共用 | **必须是已开通付费"网络门店"的认证经纪公司** + 管理员发授权码 | ❌ 开放接口只有「一键发房、楼盘字典、三网经纪人查询」，**无二手房检索** | 待商务 | P1 |
| `FIFTY_EIGHT` | ⚠️ 同上 | 同上 | ❌ 同上 | 待商务 | P1 |
| `FANG` | ✅ `ai.fang.com/open/` | 账号登录取 API Key | ❌ 官方定义为 **AI 智能体对话**场景，非房源批量 | 待商务 | P2 |
| `XINGFULI` | ✅ `open.xflapp.com` | 经纪公司身份 + token | ❌ 文档标题为「**经纪公司 VR 接入**」，推送方向 | 待商务 | P2 |
| `GOVERNMENT_DATA` | ✅ `opendata.sz.gov.cn` 等 | 机构注册 / 省统一认证 OAuth | ⚠️ **仅按日汇总成交统计，无房源明细** | 待调研 | P2 |
| `LOCAL` | ❌ | 上海网上房地产实测 **HTTP 412 拦截** | ❌ | 待调研 | P3 |
| `DEVELOPER` | — | 开发商直连商务合作 | ⚠️ 新房可谈 | 待商务 | P3 |
| `MOCK` | — | 仅演示，**必须标注 Demo** | ✅（假数据） | 已实现 | — |

#### 3.4.1 关键判断：`GOVERNMENT_DATA` 只能做行情，不能做房源

深圳市政府数据开放平台有**真实活跃 API**（二手房成交信息按日统计，7 日调用 5111 次），
支持 JSON/CSV/XML/XLSX/RDF，机构注册 + 广东省统一认证 OAuth。

**但服务条款原文**：
> 「用户**不得有偿或无偿转让**在开放平台中获取的任何数据资源」

**用途定位**：内部分析与派生指标（行情判断、议价参考、市场热度），
**不可原样转售给 SaaS 客户**。因此它是一个**辅助 Provider**，不是房源 Provider。

#### 3.4.2 唯一可行的"外部真实房源"路径：客户授权模式

调研给出的三条合法路径中，只有**路径三**能拿到**真实房源明细**：

> **客户授权模式**：客户本身是认证经纪公司，
> 由其在 `qiye.anjuke.com` 发起授权码，我方凭 `ClientID`/`ClientSecret`
> **只访问该客户自己的数据、不跨客户聚合**。

这就是 §12.4 提到的「端口绑定」生态的法律形态。

**架构含义**：这类 Provider 是**租户级凭证**（每个客户一套 Key），
而不是平台级凭证（一套 Key 服务所有客户）。

> ⚠️ **这对架构有直接影响**：`PropertyProvider` 的凭证解析必须支持
> **"平台级"与"租户级"两种模式** —— 这正是 `PropertyProviderConfig`
> 表里 `usePlatformCredentials` 字段的用途（见 §5.1.2）。
> **这张已有的表恰好为这个模式设计好了。**

#### 3.4.3 命名规范

`PropertyProviderKind` 现有值 `ANJUKE` 是平台名，但 `'58'` 是**非法标识符**
（数字开头不能做 TS 枚举值名），因此统一为语义化命名（`FIFTY_EIGHT`）。

另建议新增 `GOVERNMENT_DATA` 与 `DEVELOPER` 两个值，
把"行情数据源"与"房源数据源"在类型层面区分开。

> ⚠️ **合规红线**（您的需求 §4 已明确，本设计重申）：
> **禁止个人账号爬虫**、**禁止网页自动抓取作为核心商业方案**。
> 架构上通过"Provider 必须声明 `credentialType`"来强制这一点 ——
> 只有 `OFFICIAL_API` / `BUSINESS_AGREEMENT` / `SELF_OWNED` / `CUSTOMER_AUTHORIZED`
> 四种凭证类型被允许注册。
> 登记 `SCRAPING` 类型的 Provider 将在**代码层面被拒绝注册**（不依赖人工审查）。

---

## 4. 统一房源模型

### 4.1 扩展后的 NormalizedProperty

现有模型已接近目标，需补充字段（**标记 ⭐ 为新增**）：

```
{
  // 来源标识
  provider,              // BEIKE | ANJUKE | 58 | FANG | INTERNAL | ...
  externalId,
  sourceUrl,             // ⭐ 原始房源链接（经纪人可点开核实）
  rawData,

  // 位置
  city, district, subDistrict, community, address,
  longitude, latitude,
  communityNormalized,   // ⭐ 归一化小区名（跨源匹配用）
  districtNormalized,    // ⭐

  // 价格
  totalPrice, unitPrice,
  priceUpdatedAt,        // ⭐ 价格最后变动时间（判断时效）

  // 户型
  bedrooms, livingRooms, bathrooms, area,
  floor, totalFloors,
  buildYear, decoration, orientation,

  // 配套
  subway,                // { lines, station, distanceMeters, walkMinutes }
  school,                // { name, type, district, isKeySchool }
  tags, images, floorPlan,

  // 状态
  status,                // ACTIVE | PENDING | SOLD | DELISTED | SUSPENDED
  listingDate,
  lastVerifiedAt,        // ⭐ 最后一次核验在售的时间

  // 聚合元数据
  fingerprint,           // ⭐ 跨源归并指纹（从 rawData 提升为正式字段）
  mergedFrom,            // ⭐ 该房源还出现在哪些源：[{provider, externalId, sourceUrl}]
  fieldProvenance,       // ⭐ 字段级来源：{ totalPrice: 'BEIKE', images: 'ANJUKE' }
  confidence             // ⭐ 数据可信度 0~1（多源一致 → 高）
}
```

### 4.2 `fieldProvenance` 为什么重要

同一房源的多源数据**质量不同**：贝壳价格准，安居客图片多，自有源知道"有没有钥匙"。

因此合并时**不是简单取第一条**，而是按字段选最可信的源：

| 字段 | 优先来源 |
|---|---|
| 价格 / 在售状态 | 自有源 > 贝壳 > 其它（自家房源最准） |
| 图片 / 户型图 | 哪个源有就用哪个（可合并去重） |
| 学区 | 贝壳（有官方学区数据） |
| 钥匙房 / 是否可看 | **仅自有源**（这是独家信息） |
| 业主底价 / 议价空间 | **仅自有源**（绝不外泄） |

这让"多源"从"重复数据"变成"信息互补"。

---

## 5. 数据库设计

### 5.1 决策：复用已有的两张多源表（不新建）

审计确认数据库里**已有两张为多源设计但零使用的表**。本设计**不新建表**，直接启用。

#### 5.1.1 `PropertyProviderRecord` —— 作为「房源来源」表

您的需求 §6 要求建 `property_sources`。**复用 `property_provider_records`**：

| 您的字段要求 | 现有字段 | 结论 |
|---|---|---|
| `id` | `id` | ✅ |
| `propertyId` | `propertyId` | ✅ |
| `provider` | `provider` | ✅ |
| `externalId` | `externalId` | ✅ |
| `syncTime` | `createdAt` | ✅ 语义相符 |
| `rawData` | `payload` | ✅ |

**需补充 2 个字段**：

| 新字段 | 类型 | 用途 |
|---|---|---|
| `isPrimary` | `Boolean @default(false)` | 标记主来源（决定卡片显示哪个平台标签） |
| `sourceUrl` | `String?` | 原始链接，供经纪人点开核实 |

#### 5.1.2 `PropertyProviderConfig` —— 作为「数据源管理」配置表

需求 §12 的 Data Source Management **不需要新建表**。启用已有表并补充：

| 新字段 | 类型 | 用途 |
|---|---|---|
| `priority` | `Int @default(100)` | 管理员可调优先级（越小越优先） |
| `status` | `ProviderStatus` | `ONLINE`/`DEGRADED`/`OFFLINE`/`DISABLED` |
| `responseTimeMs` | `Int?` | 最近响应耗时 |
| `successRate` | `Float?` | 滚动成功率 |
| `totalCalls` / `failedCalls` | `Int @default(0)` | 调用统计 |
| `consecutiveFailures` | `Int @default(0)` | 熔断依据 |
| `lastCheckAt` | `DateTime?` | 最后健康探测 |
| `lastErrorMessage` | `String?` | 最后错误 |

> **为什么健康度并入本表而非新建 `provider_health`**：
> 两者是 1:1 关系（每租户每源一条），拆表会引入无意义的 JOIN。
> 但如果您希望**全局健康度**（跨租户共享，反映供应商真实状态）与
> **租户级配置**分离，则新建 `provider_health` 更合适 —— **这是一个待决策项**（见 §14.2）。

#### 5.1.3 关键前提：配置双轨制必须先对齐

⚠️ **审计发现的隐藏陷阱**：

- `configuration.ts:279-285` 声明了 `config.beike.*`（含 `appId`/`appKey`/`appSecret`/`baseUrl`/`cityCode`/`rateLimitPerMinute`）
- 但 `BeikeMcpClient` 构造函数（`beike-mcp-client.ts:161-187`）**完全无视 config，
  直接读 `process.env.BEIKE_CLI_PATH` / `process.env.BEIKE_MCP_API_KEY`**
- 因此 `PropertyProviderConfig.appSecretEncrypted` 字段目前是**纯空壳**

**如果不先对齐这一点**，多源配置会做出**两套互不相通的凭证机制**（一套环境变量、一套数据库），
导致"在后台配置了凭证但不生效"这类极难排查的问题。

**建议**：定义统一的 `ProviderCredentialResolver`，优先级为
`数据库配置（租户级）` > `环境变量（平台级）`，并让贝壳适配器改为从 resolver 取凭证。

### 5.2 Property 表补充字段

| 字段 | 类型 | 用途 |
|---|---|---|
| `fingerprint` | `String?` + `@@index` | **跨源归并（当前唯一硬缺口）** |
| `mergedSourceCount` | `Int @default(1)` | 出现在几个平台（界面显示"3 个平台在售"） |
| `fieldProvenance` | `Json?` | 字段级来源 |
| `lastVerifiedAt` | `DateTime?` | 最后核验在售时间 |
| `dataConfidence` | `Float?` | 数据可信度 |

> **关于 `provider` 与 `providerPropertyId`（您的需求 §6）**：
> **已存在**，名字是 `externalProvider` 与 `externalId`。
> **不建议重命名** —— 会破坏现有唯一约束
> `@@unique([organizationId, externalProvider, externalId])`（`schema.prisma:1011`）
> 以及所有已入库数据。

> ⚠️ **唯一命名遗留问题**：`RecommendationBatch.beikeTotalRecalled`
> （`schema.prisma:2313-2314`）是**全库唯一**把供应商名字写进列名的字段。
> 应改为 `providerTotalRecalled` 或直接改为 `Json`（按源统计）。需一次迁移。

---

## 6. 去重引擎设计（Property Deduplication Engine）

这是整个设计**技术含量最高**的部分，也是您需求 §7 的核心。

### 6.1 三级判定策略

不能只用一条规则，因为不同源的字段完整度差异很大：

#### 第一级：强标识匹配（置信度 1.0）

同一 `provider + externalId` → **确定是同一套**（这是去重，不是归并）。

#### 第二级：指纹精确匹配（置信度 0.95）

指纹组成（在现有实现上增强）：

```
fingerprint = hash(
  city
  + communityNormalized     // 归一化小区名
  + bedrooms
  + round(area / 2) * 2     // 面积归到 2㎡ 档，容忍 1㎡ 误差
  + floorBucket             // 楼层分档：低/中/高（不要求精确相等）
)
```

**为什么楼层用分档而非精确值**：不同平台对楼层的记录方式不同
（"5/6层" vs "中楼层"），精确匹配会漏判。

**为什么面积用 2㎡ 档**：您举的例子 —— 贝壳 105㎡ / 安居客 105㎡ 没问题，
但真实场景常见 104.8 vs 105.2，必须容错。

#### 第三级：模糊相似度（置信度 0.6~0.9，需人工确认）

当指纹不匹配但字段高度相似时，计算加权相似度：

| 维度 | 权重 | 判定方式 |
|---|---|---|
| 小区名 | 40% | 归一化后编辑距离 / Jaccard |
| 面积 | 20% | 相对误差 < 2% 得满分，> 5% 得 0 |
| 户型 | 15% | bedrooms + livingRooms 完全一致 |
| 总价 | 15% | 相对误差 < 1% 满分（不同源价格会有差异） |
| 楼层 | 10% | 分档一致 |

**阈值策略**：
- 相似度 ≥ 0.85 → **自动归并**
- 0.70 ~ 0.85 → **标记为疑似，进人工确认队列**（宁可让经纪人确认，也不自动合并错）
- < 0.70 → 视为不同房源

**为什么不自动合并 0.70~0.85**：错误合并的代价远高于漏合并 ——
把两套不同的房子合成一条，会让经纪人带客户看错房。这是**不可接受的错误**。

### 6.2 小区名归一化（必须重写）

您举的例子暴露了核心难点：**"浦东XX花园" vs "XX花园"**。

归一化规则：

| 步骤 | 处理 | 示例 |
|---|---|---|
| 1 | 去空白、全角转半角 | `浦东 XX 花园` → `浦东xx花园` |
| 2 | 去除括号内容（分期/别名） | `玉兰香苑(四期)` → `玉兰香苑` |
| 3 | 去除行政区前缀 | `浦东xx花园` → `xx花园` |
| 4 | 统一同义词 | `花园`/`苑`/`花苑` → 保留原词但建立同义索引 |
| 5 | 去除"小区""公寓"等通用后缀（可选） | `xx公寓` → `xx` |

⚠️ **风险警告**：第 3、5 步过于激进会**错误合并不同小区**
（如"浦东花园"和"浦西花园"都变成"花园"）。

**因此归一化必须保守**：
- 第 3 步只在**同城市同行政区**内生效
- 第 5 步**默认关闭**，仅用于第三级模糊匹配的辅助
- 保留 `communityNormalized` 与 `communityOriginal` 两份数据

### 6.3 图片特征（您需求 §7 提到）

**结论：不建议把图片特征作为主判据。**

原因：
1. 跨平台图片通常**不是同一张**（水印、尺寸、裁剪都不同）
2. 图片感知哈希（pHash）对水印敏感，误判率高
3. 计算成本高，且多源图片需要先下载

**建议**：仅在第三级模糊匹配中，当其它维度分不清时**作为辅助加分项**（权重 ≤ 10%）。
不作为独立判据。

---

## 7. 多源搜索策略

### 7.1 流程

```
客户需求
   ↓
SearchQueryBuilder → 标准查询条件（city/districts/budget/bedrooms...）
   ↓
MultiSourceAggregator
   ├─ 查询 ProviderHealth，过滤掉 OFFLINE / DISABLED 的源
   ├─ 按 priority 排序，并发调用可用的源（超时独立，互不影响）
   ├─ 单源失败 → 记录健康度，继续其它源
   ↓
DeduplicationEngine → 跨源归并
   ↓
HardFilterService → 确定性硬筛（预算/户型/区域/房龄）
   ↓
MatchScoringService → 9 维打分（**不感知来源**）
   ↓
排序 → Top N
   ↓
（可选）checkAvailability 核验在售状态
```

### 7.2 并发与超时策略

| 项 | 策略 | 理由 |
|---|---|---|
| 并发方式 | `Promise.allSettled` | 单源失败不能拖垮整体 |
| 单源超时 | 8~15 秒（可配置） | 贝壳正常 3~7 秒，留余量 |
| 整体超时 | 30 秒 | 符合"几十秒内出结果"的产品目标 |
| 重试 | 仅 `retryable` 错误，指数退避 | 已有实现，迁移到 Provider 层 |
| 结果配额 | 每源取 Top N，按 priority 分配 | 避免某个源淹没结果 |

### 7.3 降级矩阵（您需求 §10）

| 场景 | 行为 | 用户感知 |
|---|---|---|
| 全部源正常 | 合并多源结果 | 正常，显示多个来源标签 |
| 贝壳失败，自有源正常 | 用自有源结果 | **无感知**，只少了贝壳的房源 |
| 贝壳失败，自有源为空 | 用本地缓存（已有实现） | 黄色提示"数据非实时" |
| 全部源失败且无缓存 | 明确错误 + 重试入口 | 红色提示，说明是外部依赖问题 |
| 某源响应慢 | 超时后放弃该源，用其它源结果 | 无感知，仅是房源少一些 |

**关键设计**：**永不返回空结果而不解释**。只要有任何一个源返回了数据，就必须给经纪人结果。

### 7.4 结果配额分配

多源结果的合并策略（避免"某个源刷屏"）：

```
目标 N 套推荐
   ↓
按源分组，每组按匹配度排序
   ↓
轮询取（round-robin）：优先保证"每个有结果的源都至少露脸 1 套"
   ↓
剩余名额按全局匹配度补齐
```

**为什么**：如果贝壳返回 50 套、自有源只有 2 套，简单排序会让自有源被淹没 ——
而自有源往往是**独家房源**，恰恰最该优先展示。

---

## 8. Provider 健康监控与熔断

### 8.1 状态机

```
         探测成功
  OFFLINE ────────→ ONLINE
     ↑                 │
     │ 连续失败 ≥ 5     │ 失败率 > 50%（滚动 20 次）
     │                 ↓
     └──────────── DEGRADED
                      │
              管理员手动关闭
                      ↓
                  DISABLED（不参与搜索，不被健康检查复活）
```

### 8.2 熔断策略

| 参数 | 值 | 说明 |
|---|---|---|
| 滑动窗口 | 最近 20 次调用 | 避免历史数据影响判断 |
| 熔断阈值 | 失败率 > 60% | 进入 `DEGRADED` |
| 恢复探测 | 每 60 秒一次 | 恢复后自动回到 `ONLINE` |
| 半开状态 | 允许 1 个请求试探 | 避免恢复瞬间被流量打垮 |

**特别说明**：`DEGRADED` **不等于不调用**。贝壳当前的真实情况是
"所有查询都失败但连接正常" —— 这类源应该**继续尝试但排在后面**，
而不是完全跳过（因为对方可能随时恢复）。

### 8.3 与现有实现的衔接

现有 `BeikeMcpClient` 已有重试 + `isUnavailable` / `isServiceBusy` 判定。
重构时把这部分**上移到 Provider 基类**，贝壳只保留"如何识别自己的错误"。

---

## 9. AI Matching 与来源解耦（您需求 §11）

### 9.1 强制约束

**打分函数签名不得包含 `provider` 字段。**

```ts
// ✅ 正确
score(property: NormalizedProperty, profile: MergedRequirementProfile): ScoredProperty

// ❌ 禁止
score(property: NormalizedProperty & { provider }, ...)  // provider 参与任何计算
```

### 9.2 如何保证（防回归）

1. **类型层面**：定义 `ScoringInput` 类型，显式 `Omit<NormalizedProperty, 'provider' | 'externalProvider'>`
2. **测试层面**：同一房源改 `provider` 字段，断言打分**完全一致**（可写成单元测试）
3. **代码审查**：`match-scoring.service.ts` 内出现 `provider` 即视为缺陷

### 9.3 来源在哪些地方**允许**出现

| 位置 | 允许 | 用途 |
|---|---|---|
| 匹配打分 | ❌ | 必须公平 |
| 排序 | ❌ | 同上 |
| **结果配额分配** | ⚠️ 有限允许 | 保证多源都有露脸机会（§7.4） |
| **界面展示** | ✅ 必须 | 经纪人要知道数据出处 |
| **合规审计** | ✅ 必须 | 追溯数据来源 |
| **字段合并** | ✅ 必须 | 按来源选最可信字段（§4.2） |

---

## 10. 后台数据源管理（您需求 §12）

### 10.1 界面能力

| 功能 | 说明 |
|---|---|
| 源列表 | Provider / 状态 / 凭证类型 / 优先级 |
| 健康指标 | 平均响应、成功率、错误率、调用次数、最后检查时间 |
| 配额 | API 余额（若供应商提供）、今日调用量 |
| 操作 | 启用 / 停用 / 调整优先级 / 手动触发健康检查 |
| 错误详情 | 最后错误信息 + traceId，便于定位 |

### 10.2 权限

仅 `OWNER`（公司负责人）与超管可见。经纪人**不应看到**数据源配置 ——
他们只需要看到房源卡片上的来源标签。

---

## 11. 实施顺序与风险控制

### 11.1 分阶段计划（按您的需求 §13）

| Phase | 内容 | 前置条件 | 风险 |
|---|---|---|---|
| **P1** | Provider 接口完善 + 统一错误模型 + 健康监控骨架 | 无 | 低（新增为主） |
| **P2** | **重构编排器解耦贝壳** + 指纹去重覆盖全路径 | P1 | **中（会碰已验证代码）** |
| **P3** | 实现 `InternalPropertyProvider`（自有房源） | P2 | 低（新增） |
| **P4** | 多源聚合器 + 去重引擎 + 来源标注（前端） | P3 | 中 |
| **P5** | 后台数据源管理界面 | P4 | 低 |
| **P6** | 接入第一家外部授权源 | **商务授权就绪**（见 §14.1） | 取决于商务 |

> ⚠️ **P1–P5 完全不依赖商务授权**，可以立即开始。
> 只有 P6 阻塞在商务/法务上（§14.1 的四项）。
>
> **这正是"先建平台、再等商务"的意义**：即使所有平台授权都谈不下来，
> P1–P5 交付的能力（自有房源 + 来源标注 + 跨源去重 + 健康监控 + 数据源管理）
> **本身就是完整可用的产品**，且立刻解决了"贝壳挂了项目就废了"的问题。

### 11.2 最高风险：多源改造会顺带拆掉 4 条已验证的补偿逻辑 ⚠️

审计发现：现有代码里有 **4 条因为踩过坑才写的"贝壳专属补偿逻辑"**。
它们散落在编排器里，多源重构时**极易被"顺手删掉"，从而复现已修复的严重产品缺陷**。

#### 风险 1：TopK 区域放宽回退（`orchestrator.ts:575-621`）

**现状**：贝壳单次只返回约 10 条。如果这 10 条恰好不在客户要的板块（如"张江"），
硬筛后就是 0 条 —— 但整个行政区（浦东新区）其实有几千套。
于是自动降一级重搜（先去板块 → 再去行政区）。

**为什么是风险**：
- 如果新 Provider 能返回更多结果 → 这段逻辑变成**多余**（每次失败多打一次外部 API）
- 如果新 Provider **也是 TopK 语义** → 删掉它会**直接复现"几千套里说没有房源"的严重错误**

**处理策略**：**先定义 Provider 的能力位，再决定这段逻辑的去留**：

```
ProviderCapability {
  canPaginate: boolean        // 能否翻页取全量
  maxResultsPerQuery: number  // 单次返回上限（贝壳 ≈ 10）
  isSemanticSearch: boolean   // 语义检索（贝壳）vs 结构化查询
}
```

编排器根据 `canPaginate` 决定是否需要放宽重搜：
- `canPaginate = true` → 翻页取全，不需要放宽回退
- `canPaginate = false` → 保留放宽回退逻辑

#### 风险 2：错误三类分流链条（跨 4 个文件）

**现状**（这条链任一环改名都会静默失效）：

```
beike-mcp-client.ts:49-75          isUnavailable / isServiceBusy
        ↓                          （靠硬编码中文串与 errno 匹配：
                                     '请求贝壳 MCP 失败'、'tcp connect error'、'os error 10060'）
beike-property.provider.ts:36      重导出错误类给业务层
        ↓
三处各自 if/else 判类型：
  beike.controller.ts:258-279
  wechat-assistant.controller.ts:665-666
  orchestrator.ts:1066-1080
        ↓
HTTP 503 + ApiErrorCode.BEIKE_UNAVAILABLE
        ↓
前端 wechat-assistant-module.tsx:300  error?.code === 'BEIKE_UNAVAILABLE'
        ↓                          决定显示「重新查询房源」而非让用户重走 AI 解析
```

**为什么是风险**：这个错误码承载着核心 UX 承诺 ——
**"需求已保存，只需重试房源查询，无需重新粘贴"**。
链条上任何一环改名，这个承诺会**静默失效**（用户重新粘贴、重新走 AI，体验倒退）。

**处理策略（平滑迁移）**：
1. 新增 `PROVIDER_UNAVAILABLE` / `PROVIDER_NOT_CONFIGURED` / `PROVIDER_SEARCH_FAILED`
2. **新旧错误码并存**，前端两个码都认
3. 所有消费者切到新码后，最后再删旧码
4. 保留旧码至少一个版本（DB 里可能有历史记录引用）

#### 风险 3：本地缓存降级被 MOCK 数据污染 🔴

**现状**：`cached-property-search.service.ts:73` 把降级缓存**限定为 `BEIKE` 行**。

**为什么是风险**：多源改造时若"顺势放开为全部 provider"，
缓存里的 **MOCK 行会混入** —— 经纪人可能把 **Demo 数据当真实房源发给客户**。

这**直接违反项目合规红线**（`mock-property.provider.ts:8`、
`DEVELOPMENT_PLAN.md` 要求 Demo 数据必须标注）。

**处理策略**：放开时**必须显式排除 MOCK**：

```
// ✅ 正确：白名单真实来源，而不是黑名单排除 MOCK
//（未来新增 provider 时，白名单能防止它被误当成真实数据源）
where: {
  externalProvider: { in: [BEIKE, ANJUKE, FANG, INTERNAL, ...真实来源] },
  NOT: { externalProvider: MOCK },
}
```

并加一条**测试断言**：缓存降级结果中 `externalProvider !== MOCK`。

#### 风险 4：TopN 详情补全的并发预算（`orchestrator.ts:283-284, 961-997`）

**现状**：详情补全并发 = 4，是为"每次详情 = 一次 2~10 秒的 CLI 子进程"设计的。
`beike-mcp-client.ts:147` 的 `maxConcurrent = 4` 是**实例级**的。

**为什么是风险**：多源后如果并发按 Provider 数线性放大，
会**同时打爆对方限流与本机进程数**（CLI 子进程是有成本的）。

**处理策略**：
- 并发预算从"实例级"提升为**全局级**（跨 Provider 共享令牌桶）
- 或者：详情补全改为"按最终 TopN 逐个补"，而非按源并发补

---

### 11.3 两个既有隐患（多源改造时一并处理）

#### 隐患 1：Provider 内部硬编码城市

`beike-property.provider.ts:131, 142` 把 `'上海'` 硬编码在 `fetchPropertyDetail` 内部，
调用方**无法传城市**。

**风险**：多源后如果给 Provider 加了城市参数却漏掉这两处，
**跨城市时会把上海的详情写进其它城市的房源记录**。
目前单城市（`BEIKE_CITY_CODE` 默认 `310000`）掩盖了这个问题。

#### 隐患 2：配置双轨制（见 §5.1.3）

`config.beike.*` 声明了凭证字段，但 `BeikeMcpClient` 直接读 `process.env` ——
`PropertyProviderConfig.appSecretEncrypted` 是**空壳设计**。

**风险**：多源配置会做出两套互不相通的凭证机制，
产生"后台配置了凭证但不生效"这类极难排查的问题。

---

### 11.4 关于 P2 的风险（必须坦白）

重构编排器是**唯一有真实破坏风险**的一步，因为：
- `wechat-assistant.orchestrator.ts` 是闭环核心，已有大量实测验证
- 贝壳当前**正处于故障状态**，重构后难以验证"实时数据"路径

**缓解措施**：
1. 重构**只改依赖注入与错误类型**，不改业务逻辑
2. 保留 `BeikePropertyProvider` 的现有实现（不重写，只让它实现新接口）
3. 回归测试全部跑通才算完成（现有 17 项 E2E + 3 个逻辑验证脚本）
4. **先提交 P1/P3（纯新增），P2 单独一次提交** —— 便于回滚
5. §11.2 的 4 条补偿逻辑，逐条确认"保留 / 迁移 / 删除"，**不允许静默消失**

### 11.5 验证策略（每个 Phase 必须有可执行验证）

| Phase | 验证方式 |
|---|---|
| P1 | 契约测试：所有 Provider 实现同一套接口测试用例 |
| P2 | 现有 17 项 E2E 全绿 + 编排器无贝壳 import（静态检查） |
| P3 | 录入自有房源 → 搜索能命中 → 卡片显示「本公司」标签 |
| P4 | 构造"两源有同一套房"场景 → 断言只生成 1 条推荐 + 显示 2 个来源 |
| P5 | 停用某源 → 搜索不再调用它 → 结果仍正常 |
| P6 | 按供应商官方沙箱/测试环境验证 |

---

## 12. 数据合规与法务边界

### 12.1 允许的数据获取方式

| 方式 | 合法性 | 说明 |
|---|---|---|
| 供应商官方 API | ✅ | 需签订协议、使用官方凭证 |
| 商务合作数据接口 | ✅ | 需合同明确授权范围 |
| 经纪公司自有房源 | ✅ | 自有数据，无第三方权利 |
| **经纪人主动录入** | ✅ | 类比"用户粘贴微信消息"—— 数据由用户提供 |
| 用户主动授权导入 | ✅ | 需明确授权链路与告知 |

### 12.2 明确禁止（红线）

| 方式 | 为什么禁止 |
|---|---|
| 个人账号爬虫 | 违反《数据安全法》《反不正当竞争法》，平台可追责 |
| 逆向私有接口 | 同上 + 违反用户协议 |
| 网页自动抓取作为核心方案 | 同上 + 极不稳定（页面改版即失效） |
| 使用第三方 scraper 服务 | 风险转嫁不掉，法律责任仍在使用方 |
| 绕过验证码 / 风控 | 可能构成刑事风险 |

### 12.3 架构层面的强制约束

**Provider 注册时必须声明凭证类型，只有三种被允许：**

```
type CredentialType =
  | 'OFFICIAL_API'          // 供应商官方开放平台
  | 'BUSINESS_AGREEMENT'    // 正式商务合同
  | 'SELF_OWNED'            // 自有数据 / 用户主动提供
```

**登记 `SCRAPING` 类型的 Provider 将被拒绝注册**（代码层面硬性拦截，不依赖人工审查）。

### 12.4 调研结论：三条合法路径与推荐定位

> 完整调研见 [合规调研报告](./china-property-platform-data-access-compliance-report.md)

#### 12.4.1 必须接受的现实

**五家主流平台（贝壳、安居客、58、房天下、幸福里）的开放平台方向是反的** ——
它们帮经纪公司「发房」**进**平台，不让第三方「拉数据」**出**来。

**旁证**：房软、房在线、众趣等多家房产 ERP 做的**全是"推房源上平台"**，
**无一家"从平台拉房源"**。这说明行业里根本不存在这条路。

#### 12.4.2 三条合法路径（按可行性排序）

| 路径 | 说明 | 能拿到什么 | 可行性 |
|---|---|---|---|
| **① 客户授权模式** ⭐ | 客户是认证经纪公司，由其在 `qiye.anjuke.com` 发授权码，我方凭 ClientID/Secret **只访问该客户自己的数据、不跨客户聚合** | **真实房源明细**（该客户自己的盘） | **最可行**，但需法务确认用户协议 |
| **② 自有房源** ⭐ | 经纪公司自己的房源（含独家、钥匙房） | **真实房源明细**（自有） | **完全合规，可立即做** |
| **③ 官方商务合作** | 贝壳 `jiaoxiadan001@ke.com`；房天下 API Key | 贝壳：估值/验真/成交案例（**非房源库**）<br>房天下：仅官方明示的对话场景 | 依赖商务，不可控 |
| ④ 政府开放数据 | `opendata.sz.gov.cn` 等 | **仅按日汇总成交统计**，**禁止转让** | 可做行情，不能做房源 |

**推荐产品定位**：

```
L1 市场行情  ← 政府开放平台（可接入，只输出派生指标，不转售原始数据）
L2 楼盘字典  ← 需商务或经纪公司身份
L3 房源明细  ← 自有房源 + 客户授权模式（无公开合法通道，绝不做抓取）
```

#### 12.4.3 关于"批量抓取"的最终定性

即使经纪人授权了自己的账号，**批量遍历平台数据**（而非仅查询他自己的房源）
也**超出授权范围**。这不是技术判断，是法律判断。

**识别口诀**（来自调研报告）：
> 凡是**不需要你的身份**（授权码 / 企业签约 / 认证经纪公司），
> **只要付钱就给接口**的，一定是爬虫或二道贩子。

这条口诀可以直接用于未来评估任何"数据供应商"。

#### 12.4.4 调研诚实声明

13 项标注"未找到公开信息"，包括：
上海网上房地产 API、上海/深圳 `data.sh.gov.cn`（均 412 拦截）、
`open.anjuke.com`（返回 200 但空白）、贝壳配额与价格、房天下开发者协议、
幸福里配额与费用、杭州房产 API 授权条款等。

**广州、北京本轮未完成调研** —— 已知缺口。

**这些"不知道"必须在商务决策时被当作"没有"来处理** —— 不能假设存在。

### 12.5 界面告知义务

- 每条房源显示来源平台
- 数据非实时时明确标注（已有实现）
- AI 结论附带免责声明（已有实现）

---

## 13. 技术决策记录（ADR）

| # | 决策 | 备选方案 | 选择理由 |
|---|---|---|---|
| ADR-1 | 复用 `property_provider_records` | 新建 `property_sources` | 已有表结构完全匹配，不重复建设 |
| ADR-2 | 指纹从 `rawData` 提升为正式字段 | 继续存 JSON | 需要索引与 SQL 层去重，JSON 查询性能差 |
| ADR-3 | 相似度 0.70~0.85 人工确认 | 自动合并 | 错误合并后果严重（带看错房） |
| ADR-4 | 不把图片特征作主判据 | pHash 比对 | 跨平台图片不同源，误判率高、成本高 |
| ADR-5 | 小区名归一化保持保守 | 激进归一化 | 激进会错误合并不同小区 |
| ADR-6 | `DEGRADED` 源仍参与搜索但降权 | 完全跳过 | 贝壳实测是"连接正常但查询失败"，可能随时恢复 |
| ADR-7 | 打分函数类型层面排除 provider | 仅靠代码审查 | 类型强制比人工审查可靠 |
| ADR-8 | 新增 `canPaginate` / `maxResultsPerQuery` 能力位 | 让编排器猜 | 决定"区域放宽回退"逻辑去留的唯一依据（§11.2 风险 1） |
| ADR-9 | 错误码新旧并存、分两步迁移 | 直接改名 | 该错误码承载"需求已保存"的 UX 承诺，改名会静默失效（§11.2 风险 2） |
| ADR-10 | 缓存降级用**白名单**而非排除 MOCK | 黑名单排除 MOCK | 白名单能防止未来新增 provider 被误当真实源（§11.2 风险 3） |
| ADR-11 | 启用已有 `PropertyProviderConfig` 表 | 新建配置表 | 表已存在且字段完整，零引用（§5.1.2） |
| ADR-12 | 先对齐凭证来源，再谈多源配置 | 直接做 DB 配置 | 否则两套凭证机制互不相通（§11.3 隐患 2） |
| ADR-13 | 契约层 `PropertyQuery` 提升为结构化 | 继续用 `as` 强转 | 现有 `PropertySearchQuery` 是超集，靠强转读取是隐患 |

---

## 13.1 明确「不需要改动」的代码（保护已验证成果）

审计确认以下文件**可以完全不动**，重构时应主动保护：

| 文件 | 行数 | 为什么不用动 |
|---|---|---|
| `property-text-parser.service.ts` | 833 | 纯文本解析，与 provider 无关 |
| `property-import.service.ts` | 556 | 已用 `PropertyProviderKind.INTERNAL` + 自有指纹，天然多源友好 |
| `chinese-expression-parser.ts` | 855 | 纯中文规则解析 |
| `requirement-extractor / merge / profile / snapshot` 四个服务 | — | AI/规则需求域，与房源来源无关 |
| `hard-filter.service.ts` | 394 | **只吃 `NormalizedProperty`** —— 本来就是来源无关的（仅 1 句文案需改） |
| `match-scoring.service.ts` | 864 | **只吃 `NormalizedProperty`** —— 同上 |
| `wechat-reply-generator.service.ts` | — | 仅 1 处注释提及 |
| `mock-property.provider.ts` | 1037 | 已实现完整接口 |
| `apps/web/next.config.ts` | — | 前端已用原生 `img` 绕开域名白名单，多源新增 CDN 无需改配置 |
| `apps/web/.../recommended-property-card.tsx` | 333 | 渲染的是后端下发的 `property.source` 字符串，**后端不再硬编码即可，前端零改动** |

> 💡 这条清单的价值：说明**多源改造的真实改动面只有 9 个文件**，
> 而不是"重写整个房源层"。这对排期与风险判断很重要。

---

## 14. 待办与开放问题

### 14.0 文档状态与调查覆盖度

| 项目 | 状态 |
|---|---|
| 代码库架构审计（贝壳耦合点） | ✅ **已完成**（结论已并入 §1.2、§11.2、§11.3） |
| **各平台官方 API 可用性调研** | ✅ **已完成**（382 行报告，结论已并入 §0.0、§3.4、§12.4） |
| Provider 接口与去重引擎设计 | ✅ 已完成（§3、§6） |
| 数据库设计 | ✅ 已完成（§5，含"复用已有两张表"的决策） |
| 广州 / 北京 地方平台调研 | ❌ **未完成**（已知缺口） |
| 上海数据开放平台 | ❌ **未完成**（站点 412 拦截） |

### 14.1 🔴 需要立即处理（合规，优先于一切开发）

| # | 事项 | 负责方 | 为什么紧急 |
|---|---|---|---|
| 1 | **书面确认贝壳 AI 开放平台的商用授权范围** —— 去信 `jiaoxiadan001@ke.com`，说明"我方是 B2B SaaS，为经纪公司提供 AI 匹配服务，通过我方系统调用 `building.ke.com` MCP 是否在授权范围内？" | 商务 | 现用能力协议为 `private_protocol`，**未获授权前不应继续扩大使用，也不应对外宣称"已对接贝壳官方"** |
| 2 | **就"客户授权模式"征求法务意见** —— 客户（认证经纪公司）发授权码后，我方代其访问**该客户自己的**数据，是否符合平台用户协议 | 法务 | 这是唯一能拿到**外部真实房源明细**的合法路径 |
| 3 | **确认能否联系中介 ERP 厂商**（房在线/房软/众趣）探讨数据层合作 | 商务 | 它们已有平台对接协议，可能绕开自建授权 |
| 4 | **停止一切对外"已对接多家官方 API"的表述**（BD / 融资 / 官网） | 全员 | 调研结论不支持该表述，存在虚假宣传风险 |

### 14.2 需要商务确认（阻塞 P6）

- [ ] 安居客/58 的企业合作通道（`hugopenapi.58.com/openapi`、`qiye.anjuke.com`）
- [ ] 房天下 `ai.fang.com/open/` 的配额、协议、是否允许批量（**未找到公开信息**）
- [ ] 幸福里 `open.xflapp.com` 的配额与费用（**未找到公开信息**）
- [ ] 贝壳 `open.ke.com`（估值/验真/成交案例）是否可用于产品（客户群是银行/AMC/持牌机构）
- [ ] 深圳/杭州政府开放数据的机构注册流程
- [ ] 广州（阳光家缘）/ 北京住建委 数据获取路径（**调研缺口**）

### 14.3 需要产品决策

- [ ] **产品定位**：接受"L1 行情 + L2 楼盘字典 + L3 自有/授权房源"的定位，还是坚持"必须聚合多平台房源明细"（后者无合法路径）？
- [ ] 自有房源的**录入方式**：手工表单 / Excel 导入 / 从现有系统对接？
- [ ] 健康度放哪：并入 `PropertyProviderConfig`（1:1，避免 JOIN）还是独立 `provider_health` 表（全局共享）？
- [ ] 疑似重复房源的人工确认队列，放在哪个界面？
- [ ] 数据源管理界面的权限边界（仅负责人？还是店长可见？）

### 14.4 技术待验证

- [ ] 第三级模糊匹配的阈值（0.85 / 0.70）需要**用真实数据校准**，不能拍脑袋
- [ ] `checkAvailability` 的调用频率（每次推荐都核验会很慢，需权衡）
- [ ] 多源图片去重的实际收益（是否值得做）
- [ ] `PropertyProviderConfig` 的 `appSecretEncrypted` 加密方案（当前是空壳）

---

## 附录 A：与现有代码的映射

| 设计中的组件 | 现有文件 | 改造性质 |
|---|---|---|
| `PropertyProvider` 接口 | `packages/types/src/property.ts` | 扩展（新增方法，不删旧的） |
| Provider 注册表 | `providers/provider-registry.ts` | 扩展（加健康度、优先级） |
| 贝壳适配器 | `providers/beike/*` | **保留**，让它实现新接口 |
| 统一错误模型 | 新增 | 新建 |
| 健康监控 | 新增 | 新建 |
| 多源聚合器 | 新增 | 新建 |
| 去重引擎 | 部分逻辑在 `property-import.service.ts` | 抽取为独立服务 |
| 编排器 | `requirement/wechat-assistant.orchestrator.ts` | **重构（解耦贝壳）** |
| 打分服务 | `requirement/match-scoring.service.ts` | 微调（类型约束） |
| 本地缓存检索 | `requirement/cached-property-search.service.ts` | 改造为兜底 Provider |

## 附录 B：术语表

| 术语 | 含义 |
|---|---|
| Provider | 房源数据供应商适配器 |
| NormalizedProperty | 统一房源模型 |
| Fingerprint | 跨源归并指纹 |
| Deduplication | 去重（同一源内）vs 归并（跨源） |
| DEGRADED | 降级状态：仍可调用但成功率低 |
| Provenance | 字段级数据来源追溯 |

---

**文档状态**：待评审
**下一步**：评审通过后从 P1（Provider 接口完善）开始实施
