# BEIKE_INTEGRATION.md — 贝壳官方 API 接入指南

> **当前状态**：接入层已完整实现（认证、限流、重试、字段映射框架、错误处理），
> 等待官方凭证即可联调。未配置凭证时系统自动降级到 `MockPropertyProvider`（Demo 数据）。

---

## 0. 合规声明（必读）

本项目**只对接贝壳官方开放平台的正式 API**。以下行为在任何情况下都不会实现，也不应被要求实现：

| 禁止行为 | 原因 |
|---|---|
| 爬取贝壳网页 / App 数据 | 违反贝壳服务条款，可能构成不正当竞争 |
| 绕过反爬机制、验证码、签名校验 | 违反《网络安全法》 |
| 模拟登录、盗用或复用他人 Cookie / Token | 违反《数据安全法》与《个人信息保护法》 |
| 使用逆向出的私有接口 | 接口随时变更，且法律风险高 |
| 从第三方购买"贝壳数据" | 数据来源不可追溯，责任由使用方承担 |

**如果您的机构已与贝壳签约**，请通过商务或技术对接人获取官方凭证，然后按本文档第 2 节配置。
在此之前，请使用第 1 节的替代方案 —— 它们能让系统立刻跑真实业务数据。

---

## 1. 凭证到位前的替代方案（推荐先用这个）

真实中介最常用的房源入库方式其实不是 API，而是**人工搬运 + 系统解析**。
本项目已实现「粘贴导入」，覆盖从贝壳/链家后台复制房源信息后批量入库的场景。

### 1.1 粘贴导入（已实现并验证）

**API**：

```
POST /api/v1/properties/import/preview   # 解析预览，不入库
POST /api/v1/properties/import/confirm   # 用户修正后确认入库
```

**支持的三种真实格式**（均已通过实测）：

#### 格式 A：带标签逐行（贝壳后台详情页复制，最常见）

```
小区名称：碧云国际社区
户型：3室2厅1卫
建筑面积：128.5平米
总价：1250万
单价：97276元/平
所在楼层：中层/18层
朝向：南北
装修：精装修
建筑年代：2012年
所在区域：浦东新区
板块：金桥
地铁：9号线 金桥站 约650米
学校：福山外国语小学 / 建平中学西校
标签：满五唯一，南北通透，精装
```

实测解析结果：置信度 **96%**，14 个字段全部命中
（`中层/18层` 会换算为 9/18 层并换算具体楼层数）。

#### 格式 B：紧凑单行（列表页批量复制）

```
徐家汇花园 3室2厅 128.5㎡ 1580万 精装 中层/18层
春申景城 2室1厅 88㎡ 520万 简装 高楼层/11层
```

实测：2 行正确切分为 2 条房源，户型/面积/价格/楼层全部解析。

#### 格式 C：JSON（部分系统的复制按钮给出结构化数据）

```json
[{ "community": "陆家嘴中央公寓", "bedrooms": 3, "buildArea": 152, "totalPriceWan": 1950 }]
```

**字段标签兼容性**：解析器支持同一字段的多种中文叫法，例如
`总价 / 售价 / 挂牌价 / 房屋总价`、`小区名称 / 小区 / 楼盘名称 / 所在小区`、
`建筑面积 / 面积 / 建面 / 房屋面积`。完整映射见
`apps/api/src/modules/property/property-text-parser.service.ts` 的 `FIELD_LABELS`。

### 1.2 去重机制（重要）

重复导入同一套房源会污染匹配结果，因此系统用**指纹**判定：

```
指纹 = SHA256(城市 + 归一化小区名 + 卧室数 + 面积取整 + 楼层)
```

- 指纹相同 **且价格未变** → 标记为「已存在」，跳过
- 指纹相同 **但价格变化** → 视为**价格更新**，写入 `property_price_history`

这意味着：**您可以把同一份表格反复导入，系统只会更新有变化的部分**，
价格变化会自动触发后续的「降价机会」检测。

---

## 2. 官方凭证配置

拿到贝壳官方凭证后，在仓库根目录 `.env` 中填入：

```bash
# 数据来源切换为贝壳官方 API
PROPERTY_PROVIDER=BEIKE

# 贝壳开放平台凭证（向贝壳申请获得）
BEIKE_APP_ID=your_app_id
BEIKE_APP_KEY=your_app_key
BEIKE_APP_SECRET=your_app_secret
BEIKE_BASE_URL=https://open.beike.com
BEIKE_CITY_CODE=310000
BEIKE_RATE_LIMIT_PER_MINUTE=60
```

配置完成后重启 API，启动日志会显示：

```
[PropertyProviderRegistry] 已注册的房源 Provider：MOCK, BEIKE
[PropertyProviderRegistry] 当前可用的 Provider：MOCK, BEIKE
```

若凭证缺失或无效，系统会**明确降级并告警**，不会静默返回空数据：

```
[PropertyProviderRegistry] Provider BEIKE 未配置凭证，自动降级到 Mock（Demo 数据）。
```

---

## 3. 认证机制

### 3.1 实现位置

`apps/api/src/modules/property/providers/beike/beike-auth.service.ts`

### 3.2 设计要点

| 关注点 | 实现方式 |
|---|---|
| Token 缓存 | 缓存在进程内，避免每个请求都换取 Token |
| 安全边界 | 提前 5 分钟视为过期，避免边界时刻的 401 |
| 并发去重 | 多个请求同时发现缓存失效时，只发起一次换取请求（防止「惊群」） |
| 主动失效 | 收到 401 时调用 `invalidate()` 清除缓存并重试一次 |
| 凭证脱敏 | `describeConfiguration()` 返回的 AppID 形如 `abcd****wxyz`，绝不返回 secret |

### 3.3 待确认项（拿到官方文档后调整）

当前实现假设的是「**client_credentials 换 Token**」模式：

```
POST {BEIKE_BASE_URL}/openapi/auth/token
{ "appId": "...", "appKey": "...", "appSecret": "...", "grantType": "client_credentials" }
→ { "data": { "accessToken": "...", "expiresIn": 7200 } }
```

**很多开放平台实际使用「签名直连」模式**（每个请求都带时间戳 + HMAC 签名，不换取 Token）。
若贝壳属于后者，只需修改 `requestNewToken()` 一个方法，其它代码不受影响 —— 这是分层设计的价值。

---

## 4. 房源同步

### 4.1 需要实现的接口

在 `beike-property.provider.ts` 中补全以下三个方法：

| 方法 | 用途 | 对应官方接口（待确认路径） |
|---|---|---|
| `fetchProperties(query)` | 房源列表（增量同步用） | 房源列表查询 |
| `fetchPropertyDetail(externalId)` | 单套房源详情 | 房源详情查询 |
| `fetchStatusChanges(since, city)` | 状态变化（下架/成交/重新挂牌） | 房源状态变更查询 |

### 4.2 字段映射框架（已完成）

`mapToNormalized()` 方法已实现完整的转换逻辑，接入时只需**核对字段名**。

**关键陷阱：单位换算**

贝壳的总价常用「**万元**」为单位，而本系统的统一模型 `NormalizedProperty.totalPrice` 使用「**元**」。
这是整个接入过程中最容易出错的地方 —— 差 10000 倍会让匹配结果完全失真。

```typescript
// 已实现的处理
const totalPriceFromWan = raw.totalPriceWan !== undefined
  ? Math.round(this.toNumber(raw.totalPriceWan)! * 10_000)   // 万元 → 元
  : null;
// 若接口直接给单价，用单价 × 面积反推总价作为兜底
```

**已处理的枚举映射**：朝向、装修、挂牌状态、产权类型、房屋类型的中文值 → 内部枚举。
未知值一律降级为 `null`（而不是报错），避免一条脏数据导致整批同步失败。

**缺失字段语义**：区分「0」与「未知」。未知一律给 `null`，
因为 `null` 会在匹配时被降权处理，而 `0` 会被当成真实的零值参与计算。

### 4.3 同步流程

`PropertySyncService.sync()` 已实现完整的五类变化识别：

1. **新增房源** → 写 `properties` + `property_images`
2. **信息更新** → 更新面积、装修、描述等非价格字段
3. **价格变化** → 更新总价 + **写入 `property_price_history`**（同一事务内完成，避免「价格变了但历史没记」）
4. **状态变化** → 下架 / 重新挂牌，记录 `delistedAt` 与 `wasRelisted`
5. **房源消失** → Provider 不再返回且原状态为在售 → 标记为已下架

**性能设计**：
- 用 `externalId` 批量查询已存在房源（1000 条一批），避免逐条 SELECT 的 N+1
- 价格历史与房源更新在同一事务内，保证一致性
- 每批 200 条处理，控制单次事务大小

### 4.4 同步触发方式

```bash
# 手动触发全量同步（通过 API 或脚本）
POST /api/v1/properties/sync

# 定时同步（环境变量配置，默认每 6 小时）
PROPERTY_SYNC_CRON=0 */6 * * *
PROPERTY_SYNC_ENABLED=true
```

---

## 5. 错误处理与限流

### 5.1 错误分类

| 错误类型 | HTTP 状态 | 是否重试 | 处理方式 |
|---|---|---|---|
| 认证失败 | 401 | 是（换 Token 后重试一次） | 清除 Token 缓存 |
| 限流 | 429 | 是（指数退避） | 等待后重试 |
| 服务端错误 | 5xx | 是（指数退避） | 最多重试 `AI_MAX_RETRIES` 次 |
| 参数错误 | 400 | **否** | 直接抛出，重试无意义 |
| 权限不足 | 403 | **否** | 直接抛出，需人工检查凭证权限 |

### 5.2 限流实现

`waitForRateLimit()` 使用**滑动窗口**：

- 窗口内请求数达到 `BEIKE_RATE_LIMIT_PER_MINUTE` 时，计算需要等待的毫秒数并挂起
- 主动限流比被对方封禁要好 —— 官方 API 通常有严格 QPS 限制

### 5.3 重试策略

`backoffDelay()` 使用**指数退避 + 抖动**：

```
delay = min(30000, 500 × 2^attempt) × (1 ± 20% 抖动)
```

抖动的作用：多个 Worker 同时重试时不会形成「同步脉冲」再次打爆对方接口。

---

## 6. 缓存策略

| 数据 | 缓存位置 | TTL | 说明 |
|---|---|---|---|
| Access Token | 进程内存 | `expiresIn - 5min` | 见 `BeikeAuthService` |
| 房源列表 | 不缓存 | — | 同步任务本身就是批量拉取，缓存意义不大 |
| 房源详情 | Redis（建议） | 5 分钟 | 详情查询频繁时可加 |
| 城市/区域字典 | Redis（建议） | 24 小时 | 字典数据几乎不变 |

---

## 7. Webhook 与 Polling 的选择

### 7.1 如果贝壳提供 Webhook（推荐）

```
POST /api/v1/webhooks/beike
```

需要在 `apps/api/src/modules/property/` 下新增 `beike-webhook.controller.ts`，处理：

- **签名校验**（必做）：用 `BEIKE_APP_SECRET` 验证请求签名，防止伪造回调
- **幂等处理**：同一事件可能重复推送，用事件 ID 去重
- **快速响应**：先返回 200，再异步入队处理（避免回调超时导致对方重推）

### 7.2 如果没有 Webhook，只能用 Polling

当前 `PropertySyncService` 就是 Polling 模式：

```
PROPERTY_SYNC_CRON=0 */6 * * *   # 每 6 小时一次
```

**轮询间隔的权衡**：
- 太频繁：消耗配额、可能被限流
- 太稀疏：降价信息滞后，影响「降价机会」的时效性

**建议**：核心区域（在售房源集中的板块）用较短间隔（1～2 小时），
偏远区域用较长间隔（6～12 小时）。这需要按区域分别配置，当前实现是全局统一间隔。

---

## 8. 联调检查清单

拿到凭证后，按此顺序验证：

- [ ] `.env` 中 `PROPERTY_PROVIDER=BEIKE` 且三个凭证已填
- [ ] 重启 API，启动日志显示 Provider 可用（无降级告警）
- [ ] `GET /api/v1/health` 正常
- [ ] 调用 `POST /api/v1/properties/sync`，检查返回的 `PropertySyncResult`：
  - `created` > 0（新入库数量）
  - `failed` = 0（失败数应为 0，若非 0 需查日志）
- [ ] 抽查数据库 `properties` 表：
  - `totalPrice` 数值是否在合理区间（上海住宅约 100 万～5000 万，**若出现 1000 左右说明单位换算错误**）
  - `district` / `community` 是否非空
  - `subwayDistance` 是否为合理的米数
- [ ] 再次调用 `POST /api/v1/properties/sync`，验证幂等性：
  - `created` 应为 0（没有重复入库）
  - `updated` / `priceChanged` 只反映真实变化
- [ ] 模拟一次价格变化（手动改数据库某条房源的总价），再跑同步：
  - `priceChanged` 应为 1
  - `property_price_history` 应新增一条记录
- [ ] 检查限流是否生效：连续快速调用，观察日志中的限流等待信息

---

## 9. 相关代码位置

| 文件 | 职责 |
|---|---|
| `apps/api/src/modules/property/providers/provider-registry.ts` | Provider 注册与降级逻辑 |
| `apps/api/src/modules/property/providers/beike/beike-auth.service.ts` | 认证与 Token 管理 |
| `apps/api/src/modules/property/providers/beike/beike-property.provider.ts` | 房源接口调用与字段映射 |
| `apps/api/src/modules/property/property-sync.service.ts` | 同步流程与变化识别 |
| `apps/api/src/modules/property/property-text-parser.service.ts` | 粘贴文本解析（替代方案） |
| `apps/api/src/modules/property/property-import.service.ts` | 导入与去重（替代方案） |
| `packages/types/src/property.ts` | `NormalizedProperty` 统一模型定义 |

---

## 10. 联系与支持

贝壳开放平台的具体接口路径、请求参数、签名方式**必须以官方文档为准**。
本文档中带「待确认」标记的部分，都是在没有官方文档的情况下做出的合理推断 ——
拿到文档后请逐项核对，不要假设它们正确。
