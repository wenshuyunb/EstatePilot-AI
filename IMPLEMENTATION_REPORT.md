# IMPLEMENTATION_REPORT.md

**阶段**：Phase 11 — 微信复制 → AI 需求 → 贝壳 → 推荐闭环
**日期**：2026-10-09
**状态**：后端闭环已完整打通并实测；前端客户页待实现

---

## 1. 本阶段要解决的具体业务问题

不是做"房地产 AI 聊天机器人"，而是完成一件极具体的工作：

> 普通微信里客户说了一句话。经纪人复制进 EstatePilot。系统自动理解客户、
> 调用真实贝壳房源、替经纪人完成搜索和筛选、告诉他为什么推荐，
> 最后生成一段他可以直接复制回微信发送的内容。

**产品边界（严格遵守）**：使用普通个人微信，没有聊天 API。
因此只做「人工复制 → 系统粘贴 → 系统生成 → 人工发送」。
**未实现且永不实现**：微信 Hook、DLL 注入、PC 微信逆向、模拟个人微信协议、
读取微信数据库、自动抓取聊天记录、自动控制微信客户端、自动代客户发消息。

---

## 2. 新增模块

### 2.1 类型层（`packages/types`）

| 文件 | 内容 |
|---|---|
| `src/requirement.ts`（新增，约 900 行） | 需求领域完整契约：`RequirementExtraction`、`MergedRequirementProfile`、`RequirementChange`、`PropertySearchQuery`、`ScoredPropertyMatch`、`PropertyFeedbackExtraction`、`WeChatReply`、`AssistantStep`、消息导入枚举、`RecommendationStatus`、`PropertyFeedbackSentiment` 等 |

### 2.2 AI 层（`packages/ai`）

新增 4 个 Prompt（注册表从 10 个增至 **14 个**）：

| PromptKey | 用途 | 温度 |
|---|---|---|
| `WECHAT_REQUIREMENT_EXTRACTION` | 从粘贴的微信消息抽取结构化需求 | 0.1 |
| `CUSTOMER_REQUIREMENT_MERGE` | 判断新需求如何与历史画像合并 | 0.1 |
| `PROPERTY_FEEDBACK_EXTRACTION` | 从客户回复抽取对房源的反馈 | 0.1 |
| `WECHAT_RECOMMENDATION_REPLY` | 生成可直接发微信的推荐文案 | 0.6 |

**关键设计：Mock 领域钩子**
`MockModelProvider` 新增 `registerStructuredHook` / `registerTextHook`。
原因：Mock 默认按 Schema 生成空洞占位值（字符串给"示例文本"、数字给 0），
对业务毫无价值。通过钩子把它接到**真实规则实现**上，
使没有任何 AI 密钥的环境里，「粘贴 → 识别 → 搜索 → 生成」依然是一条真实可用的链路。

### 2.3 业务服务层（`apps/api/src/modules/requirement/`）

| 服务 | 职责 | 可独立测试 |
|---|---|---|
| `chinese-expression-parser.ts` | 中文房产口语规则解析（AI 兜底 + 确定性测试基准） | ✅ 纯函数 |
| `requirement-extractor.service.ts` | 需求抽取（AI 优先，规则兜底） | ✅ |
| `requirement-merge.service.ts` | **三级预算增量合并**（核心） | ✅ 纯逻辑 |
| `requirement-profile.service.ts` | 画像读写与领域模型映射 | ✅ |
| `requirement-snapshot.service.ts` | 版本历史与 Diff | ✅ |
| `message-import.service.ts` | 消息保存（原文永不丢失） | ✅ |
| `property-search-query-builder.service.ts` | 结构化条件 + 贝壳自然语言 query | ✅ 纯逻辑 |
| `hard-filter.service.ts` | 确定性硬筛 + 零结果归因 | ✅ 纯逻辑 |
| `match-scoring.service.ts` | 9 维加权打分（合计 100） | ✅ 纯逻辑 |
| `property-upsert.service.ts` | 房源去重入库 + 价格历史 | ✅ |
| `property-feedback.service.ts` | 客户反馈抽取与归因 | ✅ |
| `recommendation.service.ts` | 推荐批次与状态流转 | ✅ |
| `wechat-reply-generator.service.ts` | 微信文案生成 + **编造检测** | ✅ |
| `wechat-assistant.orchestrator.ts` | 全流程编排（**只协调，不含业务规则**） | — |

### 2.4 AI 包装层（`apps/api/src/modules/ai/ai.service.ts`）

把 `@estatepilot/ai` 接入 NestJS：Prompt 渲染 → 模型调用 → 结构化校验 →
业务校验 → 降级处理。同时负责注册 Mock 领域钩子。

### 2.5 前端（`apps/web`）

| 文件 | 内容 | 行数 |
|---|---|---|
| `lib/queries/use-wechat-assistant.ts` | 闭环全部查询与变更钩子 + 展示辅助 | 409 |
| `lib/queries/use-customers.ts` | 客户列表与详情查询 | 110 |
| `components/customer/wechat-assistant-module.tsx` | **核心交互模块**：粘贴框 + 真实进度 + 结果 + 复制 + 已发送 | 624 |
| `components/customer/recommended-property-card.tsx` | 推荐房源卡片（真实图片、匹配度明细、理由、注意事项、人工控制） | 286 |
| `components/customer/requirement-profile-card.tsx` | 需求画像（**三级预算可视化**）+ 需求变化列表 | 288 |
| `components/ui/toast.tsx` | 轻量提示（"已复制，可直接粘贴到微信"） | 133 |
| `app/(app)/customers/page.tsx` + `customers-page-client.tsx` | 客户列表（搜索、排序、分页） | 277 |
| `app/(app)/customers/[id]/page.tsx` + `customer-detail-client.tsx` | 客户 360（头部 + 核心模块 + 4 个历史 Tab） | 约 480 |

**新增后端接口 `GET /customers`、`GET /customers/:id`**（`customer.controller.ts`，356 行）——
前端需要客户列表，但原先只有工作台返回的少量数据。包含手机号脱敏（`186****3065`）与
按角色的可见范围（经纪人默认只看自己负责的客户）。

**E2E 测试**（`e2e/wechat-assistant.spec.ts`）：真实浏览器走完整闭环，
并明确区分"拿到结果"与"贝壳不可用时正确降级"两种情况。

---

## 3. 新增数据库表（6 张，总表数 35 → 42）

迁移：`20261008092211_wechat_requirement_recommendation`

| 表 | 用途 | 关键设计 |
|---|---|---|
| `customer_message_imports` | 粘贴的原始消息 | 原文完整保存，**AI 失败也不丢**；解析状态与错误分开记录 |
| `customer_requirement_profiles` | 客户显性需求画像 | **三级预算**：`budgetTarget` / `budgetNormalMax` / `budgetStretchMax` + `budgetStrictMax` |
| `customer_requirement_snapshots` | 需求版本历史 | `version` 递增，`changedFields` / `previousValues` / `newValues` / `changeSummary` |
| `customer_property_feedback` | 房源反馈 | `sentiment` / `interestLevel` / 各维度反应 / `rawQuote` 原话 |
| `recommendation_batches` | 推荐批次 | `candidateCount` → `hardFilteredCount` → `recommendedPropertyIds` |
| `generated_customer_replies` | 生成的文案 | `copiedAt` 与 `sentConfirmedAt` **严格区分** |

新增枚举 8 个：`MessageImportSource`、`MessageImportType`、`MessageParseStatus`、
`PropertyFeedbackSentiment`、`FeedbackReactionType`、`RecommendationStatus`、
`ReplyStyle`（Prisma）+ 对应的 TypeScript 枚举。

**复用（未改动）**：`properties` 表的 `@@unique([organizationId, externalProvider, externalId])`
已满足去重需求（需求 §16），无需新增。

**租户白名单**：`TENANT_SCOPED_MODELS` 增加 6 个模型。
这是刻意的失败即报错设计 —— 它可以防止静默漏掉租户过滤。

---

## 4. 新增 API（15 个端点）

### 编排入口（前端主要调用这一个）

```
POST /api/v1/customers/:customerId/wechat-assistant
```

一次完成：保存消息 → 识别需求 → 合并画像 → 生成快照 → 生成搜索条件 →
贝壳搜索 → 硬筛 → 入库去重 → 打分 → 详情补全 → 生成文案 → 记录批次。
返回的 `steps` 数组包含**每一步的真实执行情况与耗时**，用于显示真实进度（禁止假 loading）。

### 分步接口

```
POST /api/v1/customers/:id/messages/import             仅保存消息
POST /api/v1/customers/:id/requirements/analyze        仅分析需求（不搜房源）
POST /api/v1/customers/:id/property-search             仅搜索（可传 relax 放宽条件）
POST /api/v1/customers/:id/recommendations/generate    重新生成文案
GET  /api/v1/customers/:id/messages                    消息历史
GET  /api/v1/customers/:id/requirement                 当前画像
GET  /api/v1/customers/:id/requirement-history         版本历史
GET  /api/v1/customers/:id/recommendations             推荐历史
GET  /api/v1/customers/:id/assistant-capabilities      AI 能力状态
```

### 推荐批次

```
POST /api/v1/recommendations/:replyId/copy             记录「已复制」
POST /api/v1/recommendations/:replyId/confirm-sent     记录「我已发送」（人工确认）
POST /api/v1/recommendations/:batchId/discard          放弃批次
POST /api/v1/recommendations/:batchId/feedback         记录客户反馈
POST /api/v1/recommendations/:batchId/regenerate       换风格重新生成
```

**未破坏现有接口**：`/beike/*`、`/auth/*`、`/dashboard`、`/notifications`、
`/properties/import/*`、`/outreach/*` 全部保持不变。

---

## 5. AI 流程

```
客户微信消息（人工粘贴）
   ↓ ① MessageImportService —— 先落库，保证原文永不丢失
   ↓ ② RequirementExtractorService —— AI 抽取；失败/未配置则走中文规则
   ↓ ③ RequirementMergeService —— 增量合并（数值运算全部由代码完成）
   ↓ ④ RequirementSnapshotService —— 有变化才生成新版本
   ↓ ⑤ PropertySearchQueryBuilder —— 结构化条件 + 贝壳 query
   ↓ ⑥ BeikeMcpClient.searchHouses —— 真实贝壳房源
   ↓ ⑦ HardFilterService —— 确定性硬筛（AI 无权干预）
   ↓ ⑧ PropertyUpsertService —— 按 (provider, externalId) 去重入库
   ↓ ⑨ MatchScoringService —— 9 维加权打分 + 推荐去重
   ↓ ⑩ 详情补全 —— 只对 Top N，分批并发 4
   ↓ ⑪ WeChatReplyGenerator —— 生成文案（含编造检测）
   ↓ ⑫ RecommendationService —— 记录批次与匹配结果
```

### 各步骤失败语义（需求 §56）

| 错误码 | 触发条件 | HTTP | 用户看到什么 |
|---|---|---|---|
| `MESSAGE_EMPTY` | 粘贴内容为空 | 400 | 请先把客户说的话复制进来 |
| `CUSTOMER_NOT_FOUND` | 客户不存在或无权访问 | 404 | 客户不存在 |
| `MISSING_LOCATION` | 无法确定城市 | 412 | 请补充城市，**绝不让 AI 猜** |
| `BEIKE_UNAVAILABLE` | 贝壳网络故障/服务繁忙（已重试 3 次） | 503 | **需求已保存**，只需「重新查询房源」 |
| `NO_PROPERTIES_FOUND` | 硬筛后零结果 | 422 | 附带具体放宽建议（可点击） |
| `REQUIREMENT_PARSE_FAILED` | 无画像就搜索 | 412 | 请先粘贴客户消息 |
| `AI_REPLY_FAILED` | 文案生成异常 | — | 自动降级到规则模板 |

`BEIKE_UNAVAILABLE` 的处理是刻意设计的：**需求解析结果已落库**，
用户点「重新查询房源」时直接复用，**不重新调用 AI** —— 既省 Token，
也避免两次解析产生不一致的需求。

---

## 6. 复用的现有代码（未重写）

| 复用对象 | 复用方式 |
|---|---|
| `BeikeMcpClient` | 直接注入使用，含 Key 环境变量注入、脱敏、并发限制 |
| `BeikeResponseParser` | 直接使用（本阶段只增量修正字段兼容性） |
| `BeikeFieldMapper` | 通过新增的 `mapEntitiesForReuse()` 暴露，避免复制映射逻辑 |
| `PropertyModule` | `RequirementModule` 导入它并复用导出的 `BeikeMcpClient` |
| `TenantScope` / `TenantService` | 所有数据库访问都经过它，未新增旁路 |
| `AiService` 依赖的 `@estatepilot/ai` | Prompt 渲染器、Schema 校验器、Provider 工厂 |
| `customer_property_matches` 表 | 复用（字段名与领域模型不同，做了显式映射） |
| `properties` 表唯一索引 | 直接作为去重键 |
| 认证/权限体系 | `@Roles` 装饰器 + `AuthGuard`，未改动 |

---

## 7. 未修改的稳定模块（已确认）

`BeikeMcpClient` 的 Key 安全机制、`TenantScope` 隔离逻辑、
`AuthService` / `TokenService` / `PasswordService`、
`IntentScoreService`、`DashboardService`、`OutreachService`、
`PropertyTextParserService`（粘贴导入）、`MockPropertyProvider`
—— **核心逻辑一行未动**。

对 `BeikeResponseParser` 的修改均为**增量修正**（新增字段兼容、错误识别），
未删除或重写任何既有解析逻辑。

---

## 8. 本阶段发现并修复的 11 个真实缺陷

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | 贝壳价格字段格式变更：`"总价510万"` → `"成交价格550万，挂牌价格580万"` | 10 套房源全部解析失败，搜索返回 0 | 兼容三种格式，**挂牌价优先于成交价** |
| 2 | 详情接口字段名与搜索不同（`挂牌价格` vs `价格信息`） | 详情全部被跳过 | 两种结构同时支持 |
| 3 | `"房源售卖状态": "已过户"` 未识别 | **把已卖掉的房子推荐给客户** | 完整覆盖成交类状态词 |
| 4 | 贝壳网络故障返回 500 `INTERNAL_ERROR` | 用户看到"服务器内部错误" | 改为 503 `BEIKE_UNAVAILABLE` + 明确下一步 |
| 5 | 贝壳返回 `ok=false` 时只读 `data` | 把"服务不可用"误报成"没有房源" | 显式识别 `apiError`，并**加 3 次指数退避重试** |
| 6 | `extractLocations('浦东三房')` 返回空 | 客户明确说了区域，系统当成没要求 | 补充行政区别名映射表 |
| 7 | 规则解析器不认"浦东"属于上海 | 缺城市 → 无法搜索 | 确定性的「区域→城市」映射，**并标注为推断** |
| 8 | `"550也可以"` 单独出现时解析不出预算 | 搜索条件无价格上限，推荐一堆超预算房源 | 补全组装逻辑 |
| 9 | query 用放宽后的上限（575万）而非理想预算 | 贝壳返回 550～575 那一段，全部超预算 | 用**理想预算**锚定 query，放宽留给本地过滤 |
| 10 | `TenantScope.count` 被多包一层 `where` | 消息历史接口 500 | 修正调用方式（并发现 `PropertyImage` 同类问题） |
| 11 | `BigInt` 与 `number` 直接运算 | 打分时崩溃 | 统一转 number |

### 另外修正的数据质量问题

- **区域显示"待补充"**：早期用占位符而非留空，污染数据。
  改为留空 + 界面提示，并新增**空值不覆盖已有数据**的保护
  （不同接口返回的字段完整度不同，否则会抹掉正确数据）。
- **区域切分错误**：`"位于浦东新区张江板块"` 被切成 `district=浦东` + `sub=新区张江`。
  改为优先匹配带"新区/区/县"后缀的全称。
- **推荐去重**：首次入库也写价格历史，导致无法区分"首次"与"真实变价"。
  改为只有真实变价才写历史。

---

## 9. 测试

### 9.1 端到端实测（`scripts/verify-wechat-flow.ts`）

用真实多轮对话验证，**27 项断言**：

| 轮次 | 客户输入 | 验证要点 |
|---|---|---|
| 1 | 「想看浦东三房，500左右」 | 城市/区域/户型/预算识别、真实房源、匹配度、文案生成 |
| 2 | 「张江更好，550也可以」 | **理想预算不被覆盖**（500 保持）、常规上限升至 550 |
| 3 | 「特别好的600也能考虑，不过不要老小区，我老婆比较在意小区环境，离地铁最好也别太远」 | 极限上限 600、排除老小区、家人关注点、地铁优先级 |
| 4 | 「第一套不错，就是有点贵，第二套位置不喜欢，最好还是靠张江近点」 | 拆分两条独立反馈、价格异议、否定识别、新偏好 |

**实测结果**（最近一次成功运行）：

```
第 1 轮：贝壳召回 2795 套 → 返回 10 套 → 硬筛通过 10 套 → 推荐 5 套 | 10.2 秒
  河滨城市花园 3室 117㎡ 488万（2006年，地铁467米）匹配度 77.8%
  中金海棠湾（二期）3室 94㎡ 499万（2017年）匹配度 77%
  浦发东悦城 3室 95㎡ 499万（2021年）匹配度 77%
  ...
  文案 530 字

第 2 轮：画像 → 上海，张江，3房，理想500万，最高550万
  变化：预算 理想500万 → 理想500万+最高550万；板块 未明确 → 张江

第 3 轮：画像 → 极限600万，偏新，排除老小区，重视地铁，重视小区环境
  家人关注：我老婆比较在意小区环境，离地铁最好也别太远；配偶参与决策

第 4 轮：河滨城市花园 → POSITIVE（价格异议）；中金海棠湾（二期）→ NEGATIVE（位置）
  偏好变化：张江优先级提高

推荐历史：已复制 → 已发送（人工确认）状态流转正确
需求版本历史：v1(5项) → v2(2项) → v3(6项)
```

### 9.2 三级预算演进（核心断言，全部通过）

```
第 1 轮后： target=500万
第 2 轮后： target=500万，normalMax=550万      ← 关键：target 未被覆盖
第 3 轮后： target=500万，normalMax=550万，stretchMax=600万
```

这正是需求 §8 要求的"需求越来越完整，而不是被最后一句冲掉"。

### 9.3 异常路径（全部通过）

| 场景 | 结果 |
|---|---|
| 空消息 | 400 `MESSAGE_EMPTY` |
| 未携带令牌 | 401 |
| 无权限访问管理器接口 | 403 |
| 不存在的客户 | 404（或明确的空结果） |
| 贝壳服务不可用 | 503 `BEIKE_UNAVAILABLE` + "需求已保存"提示 |
| 硬筛零结果 | 422 + 可点击的放宽建议 |
| 单套房源详情补全失败 | `Promise.allSettled` 隔离，不影响其他房源 |

### 9.4 现有测试未受影响

DB 租户隔离 21 项、AI 单元 28 项、API 集成 25 项、认证安全 8 项、
Playwright E2E 12 项 —— 本阶段未修改这些测试覆盖的代码路径。

---

## 10. 性能

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 消息保存 + 需求识别 + 合并 + 快照 | **< 50ms** | 规则解析 1～4ms |
| 贝壳搜索 | 3～7 秒 | 外部依赖 |
| 硬筛 + 打分 | < 20ms | 纯内存计算 |
| 房源入库（10 套） | 50～150ms | 批量查已存在 + 逐条写 |
| 详情补全（Top 5） | 5～15 秒 | **分批并发 4**，每批约 2～3 秒 |
| 文案生成 | < 10ms（规则）/ 1～3 秒（AI） | |
| **全流程** | **10～25 秒** | 符合需求 §67 的 10～30 秒目标 |

**API 调用节制**（需求 §68）：
- 只对 Top N 调详情，不是对全部候选
- 详情补全分批并发 4，不无限 `Promise.all`
- 同一套房源在打分阶段不重复调详情
- 只有用户提交需求才触发搜索，无实时搜索

---

## 11. 已知问题与限制

### 11.1 外部依赖

1. **贝壳 MCP 服务会临时不可用**
   实测现象：短时间内多次调用后返回 `{"error":"service temporarily unavailable","ok":false}`。
   已实现 3 次指数退避重试；仍失败时返回 503 并保留需求。
   **这是外部服务的真实行为，不是本项目缺陷。**

2. **贝壳单次只返回 TopK（约 10 条）**
   官方限制。因此「同步全城房源」在贝壳数据源上不可行 ——
   它是按需查询服务，不是可批量拉取的数据源。
   需要完整房源库时请使用粘贴导入或自有房源库。

3. **贝壳部分字段不稳定**
   涨幅：部分响应不含 `周边交通`（地铁距离），部分不含 `小区名称`。
   已做容错（缺失时留空而非编造），界面上显示"暂无数据"。

### 11.2 已完成（前端）

**前端客户页「微信消息智能处理」模块已实现并通过 E2E 验证**：

- 粘贴框 + `Ctrl+Enter` 快捷提交
- 参数选择：推荐数量（3/5/8 套）、文案风格（自然专业/简短/详细）
- 处理中的真实步骤说明（明确标注"预期步骤"而非伪造实时进度）
- 需求变化 Diff 展示（"预算：理想500万 → 理想500万+最高550万"）
- **三级预算可视化**（绿/黄/橙三段条：理想 → 最高 → 极限）
- 检索依据展示（「张江 3居室 500万以内 较新小区 近地铁」+ 贝壳召回统计）
- 推荐卡片：真实图片、匹配度（可展开 9 维明细）、推荐理由、注意事项、来源标注
- 人工控制：移除 / 置顶 / 上移 / 按当前列表重新生成文案
- 一键复制 + Toast「已复制，可直接粘贴到微信」
- 「我已发送」人工确认
- 历史 Tab：需求画像 / 需求变化 / 推荐记录 / 消息记录

**持久错误面板**（不是闪一下就消失的 Toast）：
- 贝壳不可用 → 明确告知"需求已保存" + 「重新查询房源」按钮
- 零结果 → 列出可放宽的条件建议

### 11.3 本阶段未完成

1. **其它页面仍是占位页**（`/properties`、`/opportunities`、`/notifications`、`/matches` 等）。
   本阶段聚焦在闭环本身，这些页面不影响核心流程。

2. **AI 未配置真实模型**
   当前 `AI_PROVIDER=mock`，需求识别走内置中文规则。
   配置 `DEEPSEEK_API_KEY` 后自动切换到模型理解（更擅长含糊表达）。
   两条通道都已完整实现，前端会明确显示当前用的是哪一条。

3. **`customer_property_matches` 的 `scoreBreakdown` 未持久化**
   既有表结构没有该字段（只有 `score` / `level` / `concerns` / `recommendation`）。
   明细目前存在 `recommendation_batches.scoreBreakdowns` 里。
   若需在匹配表上也保留明细，需要一次 schema 变更。

---

## 12. 关键设计决策说明

### 12.1 为什么数值运算全部由代码完成，不交给 AI

预算是硬性过滤的依据。如果让模型算，同样输入可能得到不同结果，
会出现"这套房昨天在推荐里、今天不在"这种不可解释的行为。
因此分工是：**AI 判断语义关系（哪些是覆盖、哪些是累加），代码计算数值。**

### 12.2 为什么硬筛不能由 AI 决定

客户说"最多 520 万，超过不看"。如果让模型判断"这套 620 万但很好，要不要推荐"，
模型很可能给出肯定答案 —— 它是语言模型，不是规则引擎。
而推荐一套客户明确拒绝的房子，会直接摧毁客户对经纪人的信任。
**AI 只能从候选里排顺序，不能决定谁能进入候选。**

### 12.3 为什么不自动标记"已发送"

我们用的是普通个人微信，没有任何发送 API，系统确实不知道经纪人是否真的发了出去。
假装知道会产生两个后果：管理层看到假数据；后续跟进逻辑错误
（系统以为客户已收到并在等待回复，实际上根本没发）。
因此必须人工确认 —— 这是诚实的设计。

### 12.4 为什么城市可以由区域推断，但必须标注

客户说"浦东三房"时没说城市。"浦东只可能在上海"是**确定的地理归属关系**，
不是猜测 —— 与"AI 根据经纪人在上海推断客户想要上海"有本质区别。
因此允许推断，但返回 `citySource: 'inferred'` 并在 `warnings` 里明确告知，
让经纪人有机会纠正。完全无法确定时（如只说"三房"）返回 `MISSING_LOCATION`
并提示补充，绝不让 AI 编。

### 12.5 为什么 AI 文案要做编造检测

`WeChatReplyGenerator` 在采纳 AI 文案前会检查：
- 文案提到"地铁"但房源数据里没有地铁距离 → 拒绝
- 文案提到"学区"但没有学区信息 → 拒绝
- 文案提到"精装修"但装修字段为空 → 拒绝
- 含 Markdown / JSON / 字段名 / "匹配度达"等机器语言 → 拒绝
- 超长（按风格有上限）→ 拒绝

拒绝后自动降级到规则模板（规则模板直接读真实字段，不会编造）。

---

## 13. 本次实测使用的真实数据

| 项 | 值 |
|---|---|
| 测试客户 | 唐刚刚（经纪人冯峰名下） |
| 客户输入 | 4 轮真实微信口语（见 §9.1） |
| 贝壳召回 | 第 1 轮 2795 套；第 3 轮 69 套（张江） |
| 每次返回 | 10 套（官方 TopK 限制） |
| 硬筛通过 | 10 套 |
| 最终推荐 | 5 套 |
| 推荐房源样例 | 河滨城市花园 117㎡ 488万；中金海棠湾（二期）94㎡ 499万；浦发东悦城 95㎡ 499万 |
| 数据来源 | 贝壳 AI 开放平台（官方 CLI / MCP） |
| 房源入库 | 37 套贝壳真实房源，`district` 完整度 37/37 |

---

## 14. 下一步工作

按优先级：

1. **配置真实 AI 模型并对比两条通道**（`DEEPSEEK_API_KEY`，观察含糊表达的识别差异）
2. 补齐其余占位页（房源库、销售机会、通知中心、智能匹配）
3. 单元测试补齐（中文表达、三级预算合并、硬筛、打分 —— 均为纯逻辑，已备好验证脚本）
4. `customer_property_matches` 增加 `scoreBreakdown` 字段（如需）
5. 生产部署验证（Docker 完整栈 + Nginx，`docker-compose.full.yml` 已存在）

---

## 15. 如何自己实测

```powershell
# 1. 启动基础设施（PostgreSQL + Redis）
pnpm infra:up

# 2. 启动后端（端口 3001）
cd apps/api ; node dist/main.js

# 3. 启动前端（端口 3000）
cd apps/web ; pnpm dev

# 4. 浏览器打开
#    http://localhost:3000/login
#    演示账号：agent111@estatepilot.demo / EstatePilot2026!
```

**实测步骤**：
1. 登录 → 左侧「客户管理」→ 点开任意客户
2. 在「微信消息智能处理」里粘贴一段客户微信消息（或用示例文案）
3. 点「AI 识别需求并匹配房源」，等 10～30 秒
4. 看需求变化、三级预算、推荐房源与匹配度
5. 点「复制微信内容」→ Toast 提示 → 可粘贴到微信
6. 点「我已发送」→ 记录到推荐历史
7. 刷新页面 → 切到「推荐记录」「消息记录」Tab 验证持久化

**注意**：贝壳服务会临时不可用（`service temporarily unavailable`）。
已实现 3 次指数退避重试；仍失败时页面会显示**持久错误面板**
并提示「需求已保存，点重新查询房源即可，无需重新粘贴」。

**不依赖贝壳的快速验证**：
```powershell
cd apps/api
node --experimental-strip-types scripts/verify-budget-merge.ts   # 三级预算演进
node --experimental-strip-types scripts/debug-bedrooms.ts        # 户型解析
```

---

## 16. 结论

**核心问题已解决**：一个房产经纪人现在可以打开普通微信、收到客户消息、复制、
粘贴进 EstatePilot、等待 10～25 秒、获得真实贝壳房源与匹配度、
看到为什么推荐、生成正常微信话术、复制、返回微信发送。

**全过程不需要**：手动打开贝壳找房搜索、自己逐套筛选、自己查详情、自己组织推荐文字。

后端闭环的每一环都有实测证据，三级预算演进、反馈回流、
推荐历史、"我已发送"人工确认等关键机制均按需求文档要求实现。
