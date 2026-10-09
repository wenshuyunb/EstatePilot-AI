# EstatePilot AI 项目完整报告

> 版本：Phase 11 完成 + 多源架构 Phase 1–2
> 日期：2026-10-09
> 基调：**如实陈述**。已实现的写清楚，未实现的明确标注，不夸大。

---

# 目录

1. [项目定位与价值主张](#1-项目定位与价值主张)
2. [业务逻辑（完整闭环）](#2-业务逻辑完整闭环)
3. [功能实现清单](#3-功能实现清单)
4. [数据来源（重点，含合规现状）](#4-数据来源重点含合规现状)
5. [技术架构](#5-技术架构)
6. [数据库设计（41 个模型）](#6-数据库设计41-个模型)
7. [AI 系统](#7-ai-系统)
8. [真实数据统计](#8-真实数据统计)
9. [当前真实可用的功能 vs 演示数据 vs 未实现](#9-当前真实可用的功能-vs-演示数据-vs-未实现)
10. [测试与验证](#10-测试与验证)
11. [已知问题与限制](#11-已知问题与限制)
12. [运行方式](#12-运行方式)
13. [下一步规划](#13-下一步规划)

---

# 1. 项目定位与价值主张

## 1.1 一句话定位

**EstatePilot AI 是给房产经纪公司的 B2B SaaS，用「客户真实行为 + 房源变化 + AI」让经纪人每天知道最应该联系谁、推荐什么房、下一步怎么推进。**

## 1.2 目标客户

- 5～100 人的房产经纪公司
- 明确**不是**：另一个贝壳（不做流量平台）、不是房源展示站、不是普通 CRM

## 1.3 与普通 CRM 的根本差异

| 维度 | 普通 CRM | EstatePilot AI |
|---|---|---|
| 核心数据 | 经纪人**手动录入**的跟进记录 | **客户真实行为**（浏览/收藏/对比/带看）自动采集 |
| 每日起点 | 打开看列表 | 打开看**"今天 AI 帮你发现了什么"** |
| 推荐依据 | 经纪人凭记忆 | 9 维打分 + 需求画像 + 历史行为 |
| 客户沟通 | 自己组织语言 | AI 生成**可直接发送的微信文案** |
| 房源来源 | 手动录入 | 多源聚合（架构已就位） |

## 1.4 核心闭环（产品的"心脏"）

```
客户在微信里说一句话
      ↓
经纪人复制 → 粘贴进 EstatePilot → 按 Ctrl+Enter
      ↓
AI 理解需求 → 与历史需求增量合并 → 更新客户画像
      ↓
生成搜索条件 → 调用房源数据源 → 硬条件过滤 → 9 维打分 → 排序
      ↓
Top 3～5 套真实房源（含匹配度、推荐理由、注意事项）
      ↓
AI 生成微信话术
      ↓
一键复制 → 回微信 Ctrl+V → 人工发送
      ↓
点「我已发送」记录
```

**成功标准**：「客户说一句话，经纪人复制进系统，几十秒后得到真实房源和可以直接发送给客户的微信回复。」

**实测结果**：完整闭环 **12.4 秒**（贝壳正常时）/ **21～31 秒**（走本地缓存降级时）。

---

# 2. 业务逻辑（完整闭环）

## 2.1 微信消息 → 需求画像（14 阶段编排）

`wechat-assistant.orchestrator.ts`（888 行）串起完整链路，每一步都有真实记录（前端显示真实进度，非假 loading）：

| # | 阶段 | 做什么 | 关键设计 |
|---|---|---|---|
| 1 | 保存消息 | 原文落库 | **先落库** —— 后续任何步骤失败都不丢客户消息 |
| 2 | 识别需求 | AI 优先，规则兜底 | AI 不可用时自动降级到内置中文规则，功能不中断 |
| 3 | 加载历史画像 | 读已有 `CustomerRequirementProfile` | |
| 4 | 增量合并 | 新需求合并进旧画像 | **客户最新表达优先**，但不覆盖未提及的旧信息 |
| 5 | 生成快照 | 有变化才生成新版本 | 支持 `v1 → v2 → v3` 需求演进追溯 |
| 6 | 构建搜索条件 | 画像 → `PropertySearchQuery` | **价格锚点用 `budgetTarget`（理想价）而非放宽后的上限** |
| 7 | 查询房源 | 调用数据源 | 见 §4 |
| 8 | 硬条件过滤 | 确定性规则 | 预算上限、户型、区域、房龄、非在售 |
| 9 | 匹配度打分 | 9 个维度合计 100 分 | **不看来源**（需求明确要求） |
| 10 | 补充详情 | 只对 Top N 补详情 | 贝壳详情是独立调用（2~10 秒），全量补会超时 |
| 11 | 生成微信文案 | AI 优先，规则兜底 | 含**反编造校验** |
| 12 | 落库推荐批次 | 记录候选数/筛选数/耗时 | |
| 13 | 记录步骤 | 每步真实耗时与结果 | 供前端展示真实进度 |
| 14 | 返回结果 | 含警告、错误分类 | |

## 2.2 三级预算模型（本产品的关键设计）

普通 CRM 只有"预算上限"一个数。本产品区分三个层次：

| 层级 | 含义 | 例子 |
|---|---|---|
| **理想预算** `budgetTarget` | 客户心里想花的钱 | "500 左右" → 500 万 |
| **常规上限** `budgetNormalMax` | 能接受的最高价 | "550 也可以" → 550 万 |
| **极限上限** `budgetStretchMax` | 特别满意才考虑 | "600 以内也可以" → 600 万 |
| **严格上限** `budgetStrictMax` | 明确拒绝超价 | "最多 520，超过不看" → 真 |

**为什么重要**：经纪人一眼看出"客户想花 500 万，能接受到 550 万，特别满意才考虑 600 万" ——
这直接决定他怎么向客户介绍房源。前端有**三段式可视化条**（绿/黄/橙）。

**演进规则**（已实测验证）：
- 新消息只放宽不收紧（除非客户明确改口）
- 客户**再次给出更低的常规上限时允许回落**（踩坑修复，见 §11）
- `严格上限` 会压掉极限上限

## 2.3 9 维匹配度打分（合计 100 分）

| 维度 | 满分 | 打分逻辑 |
|---|---|---|
| 预算 | 25 | 理想预算内满分；常规上限内递减；超出则低分 |
| 区域 | 15 | 命中板块 > 命中行政区 |
| 户型 | 15 | 完全匹配 > 部分匹配 |
| 面积 | 10 | 落在需求区间内 |
| 房龄 | 10 | 满足"较新"要求 |
| 地铁 | 10 | 按客户对地铁的在意程度加权 |
| 小区环境 | 5 | 按客户在意程度加权 |
| 装修 | 5 | 精装要求等 |
| 历史行为 | 5 | 是否与客户历史偏好一致 |

**关键约束**：打分函数签名里**没有 provider 字段** —— 来源不参与打分（需求 §11 明确要求）。

## 2.4 硬条件过滤（确定性规则，不由 AI 决定）

| 规则 | 容差 | 理由 |
|---|---|---|
| 预算上限 | 超出即拒 | 硬约束 |
| 户型 | 精确匹配 | 3 房需求不会推 2 房 |
| 面积 | ±8% | 跨源面积记录有差异 |
| 房龄 | −1 年宽限 | 跨源建成年份记录有差异 |
| 在售状态 | 非在售即拒 | **已成交的房源推给客户是严重错误** |

**零结果处理**：不自动放宽，而是**分析原因并列出可放宽的建议**（分类：预算超限/户型不符/位置不符/面积不符/房龄不符/楼层不符/非在售/信息缺失）。

## 2.5 推荐去重（区分"重复推荐"与"降价重推"）

| 场景 | 行为 |
|---|---|
| 已推荐过、价格未变 | 仍可推荐但标记「曾推荐过」 |
| 已推荐过、**业主降价** | **优先重新推荐**（这是真实的成交机会） |
| 未推荐过 | 正常推荐 |

## 2.6 发送状态语义（重要产品设计）

| 状态 | 含义 |
|---|---|
| `GENERATED` | 文案已生成，未复制 |
| `COPIED` | **已复制到剪贴板 ≠ 已发送** |
| `SENT_CONFIRMED` | **人工确认已发送**（唯一可信的"已触达"信号） |

系统**不会自动发送微信**（普通微信无发送 API，且项目明令禁止自动化个人微信）。

---

# 3. 功能实现清单

## 3.1 已实现且经过实测（真实可用）

### ✅ 微信消息智能处理闭环（产品核心）

**后端**：14 个服务 / 约 4500 行

| 服务 | 行数 | 职责 |
|---|---|---|
| `wechat-assistant.orchestrator.ts` | 888 | 闭环编排 |
| `match-scoring.service.ts` | 864 | 9 维打分 |
| `requirement-merge.service.ts` | 858 | 需求增量合并 |
| `chinese-expression-parser.ts` | 855 | 中文房产表达解析（规则通道） |
| `property-feedback.service.ts` | 519 | 房源反馈解析 |
| `recommendation.service.ts` | 447 | 推荐批次管理 |
| `wechat-reply-generator.service.ts` | 419 | 微信文案生成 |
| `hard-filter.service.ts` | 394 | 硬条件过滤 |
| `property-upsert.service.ts` | 380 | 房源去重入库 |
| `property-search-query-builder.service.ts` | 369 | 搜索条件构建 |
| `requirement-profile.service.ts` | 349 | 画像持久化 |
| `cached-property-search.service.ts` | 304 | 本地缓存降级检索 |
| `requirement-snapshot.service.ts` | 284 | 需求版本快照 |
| `requirement-extractor.service.ts` | 274 | 需求抽取（AI 优先） |
| `message-import.service.ts` | 235 | 消息导入落库 |

**前端**：`wechat-assistant-module.tsx`（777 行）

- 粘贴框 + `Ctrl+Enter` 提交
- 推荐数量（3/5/8 套）、文案风格（自然专业/简短/详细）
- 真实进度面板（8 阶段，明确标注"预期步骤"而非伪造实时状态）
- **数据来源诚实标注**（见 §4）
- 需求变化 Diff 展示（之前 → 现在，含"客户改口"标记）
- 三级预算可视化
- 推荐卡片：匹配度（可展开 9 维明细）、推荐理由、**注意事项**、来源标注
- 人工控制：移除 / 置顶 / 上移 / 按当前列表重新生成
- 一键复制 + Toast「已复制，可直接粘贴到微信」
- 「我已发送」确认
- 历史 Tab：需求画像 / 需求变化 / 推荐记录 / 消息记录

### ✅ 客户管理

- 客户列表：意向分着色、意向/状态/已识别需求徽标、**需求速览**、多久没联系（人类可读）、行为次数/带看次数
- 搜索（姓名/手机/微信）、排序（意向分/最近活跃/最近联系/创建时间）、分页
- 客户 360 详情页：客户头部（意向分/联系方式/来源/多久没联系/行为统计）+ 4 个历史 Tab

### ✅ 工作台（"今天 AI 帮你发现了什么"）

- AI 发现网格（降价/新上/高意向等）
- **今天最值得联系的客户**（含推荐理由 + 建议动作 + 建议联系时间）
- 今日带看 / 待跟进
- 60 秒自动刷新

### ✅ 登录与认证

- 手写 HS256 JWT（access/refresh 分离密钥）
- **Refresh Token 轮换 + 重放检测**（检测到重放即吊销整个令牌家族）
- Refresh Token 存 SHA-256 哈希（不存明文）
- 5 次失败锁定
- 前端：自动刷新 + **并发刷新去重**（避免 5 个请求同时刷新触发后端重放检测误吊销会话）

### ✅ 多源房源架构（本轮新增）

见 §4。

## 3.2 已实现但前端无 UI（数据层就绪）

| 能力 | 后端 | 前端状态 |
|---|---|---|
| 通知中心 | ✅ 5 个接口 | ❌ 页面是占位页；查询钩子已写好但无引用 |
| 销售机会处理 | ✅ `PATCH /opportunities/:id` | ❌ 占位页 |
| 门店驾驶舱 | ✅ `GET /dashboard/store` | ❌ 无页面 |
| 客户房源反馈录入 | ✅ `POST /recommendations/:batchId/feedback` | ❌ 无 UI（后端已能解析"不喜欢XX"这类反馈） |
| 房源导入（粘贴/Excel） | ✅ `POST /properties/import/{preview,confirm}` | ❌ 无 UI |
| 多源数据源管理 | ✅ 注册表 + 健康监控 | ❌ 无 UI（需求 §12） |

## 3.3 占位页与死链（诚实清单）

**占位页 3 个**（有路由，只有"正在实现中"文字）：
`/properties`（房源库）、`/opportunities`（销售机会）、`/notifications`（通知中心）

**导航中但无页面（点击即 404）9 个**：
`/tasks`、`/matches`、`/search`、`/viewings`、`/messages`、`/ai`、`/settings`、`/manager`、`/admin`

> ⚠️ 项目**没有自定义 404 页面**，用户体验是 Next.js 默认 404。
> 工作台内还有 4 处链接指向不存在的路由。

**前端真实页面统计：5 个真实页面 + 1 个重定向 = 6 个**

---

# 4. 数据来源（重点）

## 4.1 数据来源总览

| 来源 | 类型 | 状态 | 真实房源数 |
|---|---|---|---|
| **贝壳官方开放平台** | 官方 API | ✅ **已接入**（但有授权问题，见 4.4） | **41 套真实在售** |
| **本公司房源（自有）** | 自有数据 | ✅ Provider 已实现 | 0（待录入） |
| **用户录入（安居客/58 等）** | 用户提供 | ✅ Provider 已实现 | 0（待录入） |
| 内置演示数据 | Demo | ✅ 已实现（**界面标注 Demo**） | **2090 套** |
| 安居客官方 API | 官方 API | ❌ **无公开 API** | — |
| 58 同城房产 | 官方 API | ❌ **无公开 API** | — |
| 房天下 | 官方 API | ❌ 仅 AI 对话场景 | — |
| 幸福里 | 官方 API | ❌ 仅经纪公司 VR 接入 | — |
| 上海网上房地产 | 政府 | ❌ 实测 HTTP 412 拦截 | — |
| 深圳政府开放平台 | 政府 | ⚠️ 有真 API，但**仅按日汇总成交统计**且**禁止转让数据** | 无房源明细 |

## 4.2 合规调研的核心结论（必须知道）

> 完整报告见 [docs/china-property-platform-data-access-compliance-report.md](docs/china-property-platform-data-access-compliance-report.md)

**结论**：**中国主流商业房源平台（贝壳、安居客、58、房天下、幸福里）没有任何一家向第三方 SaaS 开放"批量获取二手房列表 + 详情 + 图片"的公开 API。**

它们的开放平台方向是**反的** —— 帮经纪公司「**发房**」进平台（入向），而非让第三方「**拉数据**」出来（出向）。

**旁证**：房软、房在线、众趣等多家房产 ERP 做的**全是"推房源上平台"**，无一家"从平台拉房源"。

## 4.3 🔴 两个法律风险（发布前必须处理）

### 风险 A：贝壳 AI 开放平台的授权范围可能不支持商用

| 事实 | 来源 |
|---|---|
| `building.ke.com` 是「贝壳 AI 开放平台」，`/mcp` 端点真实（GET 返回 405，符合 MCP 只收 POST） | 实测 |
| GitHub `LianjiaTech/beike-ai-platform` 提供 7 个 Skill | 官方原文 |
| `beike login` 自助取 API Key | 官方原文 |
| **Skill 许可写「贝壳内部使用」/「商业软件，仅限授权用户使用」** | 官方原文 |
| **用户协议 ID：`beike_AI_open_Platform_private_protocol`**（协议名含 `private`） | 官方原文 |
| 未找到任何公开的商用授权条款 | **未能验证** |

**必须做的事**：通过 `jiaoxiadan001@ke.com` **书面确认**授权范围。
**在获得书面确认前**，不要对外宣称"已对接贝壳官方 API"，不要写进 BD/融资材料。

### 风险 B：已有生效判例，赔偿 550 万元

**北京链家、天津小屋 诉 北京/成都神鹰城讯（"推推99"）**
海淀法院一审：连带赔偿 500 万 + 50 万 = **550 万元**，被告撤回上诉，**已生效**，并发出行为保全。

来源：[辽宁省高级人民法院转载](https://ykgz.lncourt.gov.cn/article/detail/2023/01/id/7113312.shtml)

**侵权形态几乎就是"房源数据 SaaS"的标准做法**：抓取 → 存自有服务器 → **去水印** → 展示给用户 + 供下载转发 → 伪装真实用户访问百万次。

**核心裁判规则（判决原文）**：
> 「涉案数据虽是二原告**向公众无差别的予以提供和展示的公开数据**，但这**并不意味着其他经营者可以不受任何限制的获取和使用**。」

**另一条对本项目尤其重要**：法院认定被告"实为房产经纪公司或经纪人发布**虚假房源**提供了重要工具和便利条件" ——
**即：下游客户怎么用数据，会成为你的责任。**

## 4.4 数据源的诚实标注机制（已实现）

这是本项目在合规上的核心工程实现 —— **绝不让用户误以为数据是实时的、真实的**：

| 场景 | 界面表现 |
|---|---|
| 贝壳实时数据 | 🟢 绿色徽标「**贝壳实时数据**」+「贝壳召回 N 套」 |
| 贝壳不可用，用本地已入库真实房源 | 🟡 黄色徽标「**本地缓存房源**」+ 同步时间 + 「**房源信息不是实时的。发送给客户前，请先在贝壳 App 上确认这几套是否仍在售。**」 |
| 演示数据 | 标注 **Demo Data** |
| 用户录入数据 | 标注「XX（用户录入）」+ **无法核验在售状态**（能力位 `supportsRealtimeStatus: false`） |

**服务状态指示器**：界面显示贝壳探测结果三态 ——「正常」/「暂时不可用（对方服务端问题，稍后重试即可，不用改配置）」/「连接异常，请检查凭证配置」。
这个区分很重要：**让用户知道是自己的配置错了，还是对方挂了**。

## 4.5 多源架构（本轮新增，已实现并验证）

### 4.5.1 架构

```
业务层（编排器 / 匹配引擎）
        ↓  只依赖接口
PropertyProviderV2 接口
        ↓
ProviderRegistryV2 ──→ ProviderHealthMonitor（健康度 + 熔断 + 启停）
        ↓
MultiSourceAggregator（并发调用 + 容错 + 归并）
        ↓
PropertyDeduplicationService（跨源去重）
        ↓
┌──────────────┬──────────────────────┐
│ BeikeProvider│ UserProvidedProvider │  ← 已实现
│ (官方 API)   │ (用户录入/自有房源)   │
└──────────────┴──────────────────────┘
        ↓ 未来只需实现同一个接口
   Anjuke / 58 / Fang / Local / Developer
```

### 4.5.2 已实现的数据源 Provider

| Provider | 类型 | tier | 能力 | 实时状态核验 |
|---|---|---|---|---|
| `BeikePropertyProviderV2` | 官方 API | Level 1 | 详情✅ 学区✅ 地铁✅ 成交✅ 图片❌ 翻页❌(TopK 10) | ✅ |
| `UserProvidedPropertyProvider` | 用户提供 | Level 3 | 图片✅ 学区✅ 地铁✅ | ❌ **如实声明无法核验** |

### 4.5.3 跨源去重（三级判定）

| 级别 | 判据 | 置信度 | 动作 |
|---|---|---|---|
| 一级 | 同 provider + 同 externalId | 1.00 | 同一条记录 |
| 一级（反向） | 同 provider + **不同** externalId | 1.00 | **确定是两套**（安全阀） |
| 二级 | 指纹匹配（归一化小区+户型+面积档+楼层档） | 0.95 | 自动归并（价格差 ≤5%） |
| 二级（变体） | 指纹一致但价格差 > 5% | 0.75 | **疑似** → 人工确认 |
| 三级 | 多维加权相似度（小区40%/面积20%/户型15%/价格15%/楼层10%） | 0.60~0.90 | ≥0.85 归并；0.70~0.85 疑似 |

**核心决策：疑似不自动合并。**
理由：**错误合并的代价远高于漏合并** —— 漏合并经纪人可能自己发现是同一套，
但**错误合并会让他带客户看错房**，不可恢复。

### 4.5.4 合规强约束（编译期拦截）

```
ProviderCredentialType {
  OFFICIAL_API        // 官方开放平台
  BUSINESS_AGREEMENT  // 商务合同授权
  SELF_OWNED          // 自有数据
  USER_PROVIDED       // 用户主动提供
}
```

**枚举里根本没有 `SCRAPING`。** 注册表还加了运行时校验（已写验证用例：`凭证类型为 SCRAPING 时注册被拒绝`）。
将来有人想加爬虫 Provider，**必须先在枚举里加一个新值** —— 那是一次需要 review 的显式改动。

---

# 5. 技术架构

## 5.1 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 包管理 | pnpm workspaces | 12.10.1 |
| 后端 | NestJS | 12.1.2 |
| 前端 | Next.js（App Router）+ React | 16.4.0 / 19.3.0 |
| 数据库 | PostgreSQL + pgvector | 18 |
| ORM | Prisma | 7.10.0 |
| 缓存 | Redis | 8 |
| 队列/调度 | （已定技术选型，待接入） | — |
| 语言 | TypeScript | 5.9.3 |
| 样式 | Tailwind CSS（CSS-first `@theme`） | 4 |
| 组件 | Radix UI + shadcn 模式 | — |
| 数据获取 | TanStack Query | 5 |
| 状态 | Zustand | 5 |
| 校验 | Zod | 4 |
| 密码哈希 | argon2 | — |
| E2E | Playwright | 1.63 |
| 单测 | Vitest | 4 |

## 5.2 Monorepo 结构

```
EstatePilot-AI/
├── apps/
│   ├── api/          NestJS 后端
│   └── web/          Next.js 前端
├── packages/
│   ├── types/        共享领域类型（单一事实来源）
│   ├── utils/        工具函数
│   ├── database/     Prisma schema + 租户隔离
│   └── ai/           AI Provider 适配 + 提示词注册表
├── infrastructure/
│   └── beike/        贝壳官方 CLI（含 SHA256 校验安装器）
└── docs/             架构与合规文档
```

## 5.3 多租户隔离

**核心机制**：`TenantScope`（`packages/database/src/tenant-scope.ts`）

| 设计 | 说明 |
|---|---|
| 白名单模型 | `TENANT_SCOPED_MODELS` 列出所有含 `organizationId` 的模型 |
| **配置错误会大声失败** | 访问未在白名单的模型抛 `TenantScopeUnsupportedError`，而不是静默返回全租户数据 |
| API 形态 | `create({data, select})` / `count(model, 裸where)` / `update({where, data, select})` |
| 请求上下文 | AsyncLocalStorage（`runWithContext` / `getContext` / `requireContext` / `runAsTask`） |

## 5.4 后端模块（17 个）

| 模块 | 职责 |
|---|---|
| `auth` | JWT 认证、密码、令牌轮换 |
| `tenant` | 多租户作用域 |
| `customer` | 客户列表与详情 |
| `behavior` | 客户行为采集与画像 |
| `requirement` | **微信闭环（14 个服务）** |
| `property` | 房源、Provider 注册表、**多源聚合** |
| `matching` | 客户-房源匹配 |
| `opportunity` | 销售机会 |
| `viewing` | 带看管理 |
| `task` | 待办任务 |
| `notification` | 通知中心 |
| `dashboard` | 工作台 / 门店驾驶舱 |
| `outreach` | 触达与推荐包 |
| `ai` | AI 服务包装（`AiService`） |
| `admin` | 平台后台 |
| `health` | 健康检查 |

## 5.5 API 路由（11 个 Controller / 36 条路由）

| Controller | 前缀 | 路由数 |
|---|---|---|
| `auth` | `/auth` | 4 |
| `customer` | `/customers` | 2 |
| `wechat-assistant` | `/customers/:customerId` | 10 |
| `recommendation` | `/recommendations` | 5 |
| `beike` | `/beike` | 5 |
| `property-import` | `/properties/import` | 2 |
| `dashboard` | `/dashboard` | 2 |
| `notifications` | `/notifications` | 5 |
| `outreach` | `/outreach` | 1 |
| `health` | `/health` | 2 |

## 5.6 性能特征（实测）

| 环节 | 耗时 |
|---|---|
| 消息保存 + 需求抽取 + 合并 + 快照 | < 50ms |
| 房源搜索（贝壳） | 3～7 秒 |
| 硬筛 + 打分 | < 20ms |
| 详情补全（Top 5，并发 4） | 5～15 秒 |
| **完整闭环** | **12.4 秒（实时）/ 21～31 秒（缓存降级）** |

---

# 6. 数据库设计（41 个模型）

## 6.1 模型清单（按域分组）

**组织与权限（5）**：`Organization`、`Store`、`Team`、`User`、`RefreshToken`

**客户域（6）**：`Customer`、`CustomerProfile`、`CustomerBehaviorEvent`、`CustomerBehavioralProfile`、`IntentScoreHistory`、`BehaviorScoringRule`

**房源域（6）**：`Property`、`PropertyImage`、`PropertyPriceHistory`、**`PropertyProviderRecord`**、**`PropertyProviderConfig`**、（`Favorite`/`Comparison` 归交易域）

**微信闭环（6）**：`CustomerMessageImport`、`CustomerRequirementProfile`、`CustomerRequirementSnapshot`、`CustomerPropertyFeedback`、`RecommendationBatch`、`GeneratedCustomerReply`

**交易域（7）**：`CustomerPropertyMatch`、`Opportunity`、`Viewing`、`ViewingProperty`、`Favorite`、`Comparison`、`Communication`

**其他（11）**：`Task`、`Notification`、`VoiceNote`、`AiConversation`、`AiMessage`、`AiRun`、`CustomerShareLink`、`Subscription`、`FeatureFlag`、`SystemSetting`、`AuditLog`、`ConsentLog`

## 6.2 迁移历史（3 个）

| 迁移 | 内容 |
|---|---|
| `20261008072102_init_estatepilot_core` | 初始核心表 |
| `20261008080000_vector_and_trgm_indexes` | pgvector + pg_trgm 索引 |
| `20261008092211_wechat_requirement_recommendation` | **Phase 11：微信闭环 6 张表 + 8 个枚举** |

## 6.3 多源相关结构（已存在，部分未启用）

| 结构 | 状态 |
|---|---|
| `Property.externalProvider` + `externalId` + 唯一约束 | ✅ 已用 |
| `Property.communityNormalized` + 索引 | ✅ 字段已用（归一化实现本轮已统一） |
| **`PropertyProviderRecord`**（多源快照） | ⚠️ 表已存在但**唯一写入点在死代码里** → 实际 0 行 |
| **`PropertyProviderConfig`**（多源配置） | ⚠️ 表已存在但**业务代码零引用** → 实际 0 行 |

**多源架构的下一阶段需要一次迁移**：加 `fingerprint` 列、`mergedSourceCount`、`lastVerifiedAt`，
并启用上面两张表。

## 6.4 索引策略

Property 表有 12 个索引，覆盖：`listingStatus`、`city+district`、`community`、`totalPrice`、
`area`、`bedrooms`、`buildYear`、`districtNormalized+listingStatus`、`lastPriceChange`、`communityNormalized`。

---

# 7. AI 系统

## 7.1 提示词注册表（14 个 PromptKey）

| 用途 | PromptKey |
|---|---|
| 客户画像分析 | `CUSTOMER_PROFILE_ANALYSIS` |
| 偏好漂移检测 | `CUSTOMER_PREFERENCE_DRIFT` |
| 匹配解释 | `PROPERTY_MATCH_EXPLANATION` |
| 销售跟进建议 | `SALES_FOLLOWUP` |
| 带看分析 | `VIEWING_ANALYSIS` |
| 销售机会识别 | `SALES_OPPORTUNITY` |
| 店长诊断 | `MANAGER_DIAGNOSIS` |
| 沟通分析 | `COMMUNICATION_ANALYSIS` |
| 意向分 | `CUSTOMER_INTENT_SCORE` |
| AI 对话 | `ASSISTANT_CHAT` |
| **微信需求抽取** | `WECHAT_REQUIREMENT_EXTRACTION` |
| **需求合并** | `CUSTOMER_REQUIREMENT_MERGE` |
| **房源反馈抽取** | `PROPERTY_FEEDBACK_EXTRACTION` |
| **微信推荐文案** | `WECHAT_RECOMMENDATION_REPLY` |

## 7.2 双通道设计（AI 优先，规则兜底）

| 通道 | 触发条件 | 特点 |
|---|---|---|
| **AI 通道** | 配置了 AI 厂商密钥 | 擅长理解含糊表达（"新一点""别太老"） |
| **规则通道** | 未配置密钥 / AI 调用失败 | 内置中文房产规则，功能完整但理解复杂表达稍弱 |

**界面会明确告知当前用的是哪一条** —— 不让用户误以为在用 AI。

## 7.3 确定性 vs AI 的边界（重要设计原则）

| 交给 AI | 交给代码 |
|---|---|
| 语言理解（客户说了什么） | 数值计算（预算、面积、单价） |
| 语义判断（"新一点"是什么意思） | 价格过滤（超出预算即拒） |
| 文案生成（怎么跟客户说） | 权限校验 |
| | 去重 |
| | **房源状态真实性** |

**理由**：AI 会出错，而"把已成交房源推荐给客户"这类错误不可接受。

## 7.4 反编造机制

微信文案生成后有**校验**（`validateGeneratedText`）：

| 检查项 | 理由 |
|---|---|
| 是否包含未提供的地铁信息 | 不能编造"地铁 5 分钟" |
| 是否包含未提供的学区信息 | 不能编造"名校学区" |
| 是否含 Markdown 语法 | 微信不渲染 Markdown |
| 是否含 JSON/字段名 | 不能把机器语言发给客户 |
| 长度是否合理 | 过长客户不看 |

## 7.5 结构化输出 + Mock 钩子

- **JSON Schema 结构化输出** + `validateAndCoerce`（返回 `{valid, issues, coerced}`）
- **Mock 领域钩子**：`MockModelProvider.registerStructuredHook` / `registerTextHook` —— 让**没有 AI 密钥的环境也跑真实规则逻辑**，而不是返回空洞占位

---

# 8. 真实数据统计

> 数据来自当前运行实例（2026-10-09）

## 8.1 组织与用户

| 指标 | 数量 |
|---|---|
| 组织 | 2 |
| 门店 | 4 |
| 团队 | 4 |
| 用户 | 28 |

## 8.2 客户域

| 指标 | 数量 |
|---|---|
| 客户 | **300** |
| 客户画像 | 300 |
| **客户行为事件** | **8,631** |
| 行为画像 | 300 |
| 客户-房源匹配 | **2,199** |
| 意向分历史 | 0（未启用历史记录） |

**客户意向等级分布**：A 级 70 人 · B 级 161 人 · C 级 69 人

## 8.3 房源域 ⚠️ 关键数据

| 指标 | 数量 |
|---|---|
| **房源总数** | **2,131** |
| ├ **演示数据（MOCK）** | **2,090** ⚠️ |
| └ **贝壳真实房源** | **41** ✅ |
| 在售状态 | 1,987 |
| 有图片 | 2,090 |
| 房源图片 | 31,350 |
| 价格历史 | 702 |

**行政区分布**：浦东新区 811 · 静安区 330 · 杨浦区 330 · 闵行区 330 · 徐汇区 330

**房源状态分布**：在售 1,987 · 已下定 74 · 已下架 70

> ⚠️ **必须清楚**：**目前 98% 的房源是演示数据**。真实贝壳房源只有 41 套（浦东张江一带）。
> 这是"演示环境"的正常状态，但**不能当成生产数据**。

## 8.4 交易域

| 指标 | 数量 |
|---|---|
| 销售机会 | 128 |
| 带看记录 | 120 |
| 带看-房源关联 | 343 |
| 收藏 | 251 |
| 对比 | 287 |
| 沟通记录 | 576 |
| 通知 | 128 |
| 任务 | 0 |

## 8.5 微信闭环（Phase 11 实测产生）

| 指标 | 数量 |
|---|---|
| 消息导入 | 17 |
| 需求画像 | 1 |
| **需求快照（版本历史）** | **6** |
| 推荐批次 | 14 |
| 生成的微信文案 | 14 |
| 房源反馈 | 0（前端无录入 UI） |

> 说明：微信闭环目前主要在**测试客户「唐刚刚」**上验证过，实测过 4 轮真实对话演进（v1→v6）。

## 8.6 系统与安全

| 指标 | 数量 |
|---|---|
| 审计日志 | 193 |
| 刷新令牌 | 175 |
| 功能开关 | 5 |
| AI 会话/消息/运行 | **0**（当前走规则通道，未配置 AI 密钥） |

---

# 9. 当前真实可用的功能 vs 演示数据 vs 未实现

## 9.1 三分钟看懂真实状态

| 类别 | 内容 |
|---|---|
| ✅ **真实可用** | 登录认证 · 工作台 · 客户列表 · 客户 360 · **微信消息智能处理闭环**（含需求理解、三级预算、9 维打分、微信文案生成、一键复制、已发送确认、历史追溯） |
| ⚠️ **能用但数据是演示的** | 房源库（98% 是演示数据）· 匹配结果 · 销售机会 · 带看记录 · 沟通记录 |
| ✅ **真实数据** | 300 位客户 + 8,631 条行为事件 + **41 套真实贝壳房源** |
| ❌ **未实现** | 房源库页面 · 销售机会页面 · 通知中心页面 · 待办任务 · 智能匹配页 · 全局搜索 · 带看管理页 · 沟通记录页 · AI 助手页 · 门店驾驶舱页 · 设置页 · 平台后台页 |
| ❌ **未配置** | AI 厂商密钥（当前走规则通道）· Redis 搜索缓存 · 消息队列 |

## 9.2 五种"数据来源"在界面上的区分

| 来源 | 界面表现 |
|---|---|
| 贝壳实时 | 🟢「贝壳实时数据」徽标 |
| 本地缓存（贝壳不可用时） | 🟡「本地缓存房源」+ 同步时间 + 非实时提醒 |
| 演示数据 | **Demo Data** 标注 |
| 本公司自有房源 | 将显示「本公司」标签（Provider 已实现，界面待接） |
| 用户录入 | 将显示「XX（用户录入）」+ 无法核验提示 |

---

# 10. 测试与验证

## 10.1 E2E 测试（Playwright，17 个用例全部通过）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `auth.spec.ts` | 8 | 未登录跳转 · 演示账号登录 · 错误密码 · 令牌持久化 · 工作台 AI 发现为核心 · 侧边栏导航 · 退出 · owner 权限入口 |
| `wechat-assistant.spec.ts` | 3 | 客户列表（真实数据/意向分/搜索/Console 干净）· **完整闭环**（粘贴→进度→结果→来源标注→复制→已发送→刷新后历史仍在）· 空消息拒绝 |
| `screenshots.spec.ts` | 4 | 截图（登录页/工作台/首屏/移动端） |
| `customer-detail-screenshots.spec.ts` | 2 | 客户列表 / 详情三态截图 |

**E2E 的关键价值**：闭环测试会真实调用贝壳，且**同时验证正常路径与降级路径**（贝壳不可用时断言错误面板内容并标记 annotation，不误判为失败）。

## 10.2 逻辑验证脚本（不依赖外部服务）

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `verify-provider-layer.ts` | 33 | 价格单位推断 · 字段校验 · ID 稳定性 · 过滤 · 合规约束 |
| `verify-dedup.ts` | 27 | 小区名归一化 · **需求 §8 原例** · 反向能力 · 指纹 |
| `verify-aggregator.ts` | 34 | **需求 §20 全部要求** · 降级 · 健康监控 · 合规拦截 |
| `verify-budget-merge.ts` | 5 轮 | 三级预算演进 · 改口 · 取消 |
| `debug-bedrooms.ts` | 13 | 户型表达（含"两房"这类易漏的） |
| `debug-tags.ts` | 4 | 标签解析（真实数据格式） |
| `verify-wechat-flow.ts` | 27 | 端到端闭环（需贝壳可用） |

## 10.3 类型检查

**6 个包全绿**：`types` · `utils` · `database` · `ai` · `api` · `web`

## 10.4 测试缺口（诚实声明）

| 缺口 | 说明 |
|---|---|
| ❌ **无后端单元测试** | `vitest run` 报 `No test files found`（`include: src/**/*.test.ts` 下无文件） |
| ❌ **无前端单元测试** | `apps/web` 的 `test` 脚本指向的 `vitest.config.ts` **不存在** |
| ⚠️ 移动端 E2E 项目空转 | `mobile-chrome` 项目的 `testMatch` 指向不存在的 `customer-portal.spec.ts` |

---

# 11. 已知问题与限制

## 11.1 外部依赖问题

| 问题 | 影响 | 应对 |
|---|---|---|
| **贝壳数据服务会整体不可用** | 所有查询工具同时返回 `service temporarily unavailable`，而 `doctor` 显示连接与凭证正常 | ✅ 已实现：5 次指数退避重试 + 本地缓存降级 + 服务状态探测（区分"对方故障"与"我方配置问题"） |
| **贝壳商用授权待确认** | 协议名含 `private` | ⏳ 需书面确认 |
| 贝壳单次只返回 TopK ≈ 10 条 | 需要"区域放宽重搜"补偿 | ✅ 已实现 |
| 贝壳响应不含图片 URL | 41 套真实房源 images 全为 0 | ✅ 如实声明 `supportsImages: false`，不编造 |

## 11.2 已修复的重要缺陷（本阶段发现）

| # | 缺陷 | 根因 | 影响 |
|---|---|---|---|
| 1 | **「标签」字段解析错误** | 该字段实为「小区基础信息 + 房源标签」的合并文本，**顶层分隔符是中文逗号 `，`**，旧代码按 `/` 无脑切分 | 推荐卡片出现「月」「年)」垃圾标签 → **React key 冲突**（用户实测发现） |
| 2 | 「两房」无法识别 | 正则字符类漏了「两」这个最常用口语数量词 | 户型解析失败 |
| 3 | 三级预算退化（最高=极限） | 上限"只升不降"导致早期误判无法永久回落 | 推荐范围被撑大 |
| 4 | 三份不一致的归一化实现 | 三处各自实现，大小写不一致 | 跨源匹配失败 |
| 5 | 面积档边界不稳定 | `round(104.8/2)*2=104` vs `round(105.2/2)*2=106` | 跨源同一套房漏匹配 |
| 6 | 楼层分档对低层建筑失效 | 纯比例法：6 层楼的 5 楼被判"高层" | 指纹错误 |
| 7 | 贝壳返回业务错误被当成"无房源" | 未解析 `ok:false` | 用户看到"没有找到房源"而非"服务故障" |
| 8 | 户型状态「已过户」未识别 | 状态枚举覆盖不全 | **已成交房源被推荐给客户** |
| 9 | 查询用放宽后的上限做锚点 | 贝壳只返回上限附近房源 | 漏掉理想价附近的房源 |

> 修复 8 尤其重要 —— 它是"把已成交房源推荐给客户"这类**不可接受错误**的实例。

## 11.3 代码卫生问题（小）

- `customers-page-client.tsx` 有死导入 `formatWan`
- `dashboard-page-client.tsx` 有死导入 `CardHeader`/`CardTitle`
- `INTENT_LABEL`/`STATUS_LABEL` 在客户列表页与详情页**重复定义**
- `api-client.ts` 的 SSR 分支与浏览器分支**代码完全相同**，与注释及 `next.config.ts` 的 rewrite 设计不符（rewrite 无人调用）
- UI 组件 10 个文件中有 **3 个完全未被使用**（`dialog`/`dropdown-menu`/`table`）
- 依赖中有 `recharts`/`react-hook-form`/`zod`/`date-fns` 但**全仓无 import**

## 11.4 产品缺口

- ❌ 无暗色模式
- ❌ 无 i18n（文案硬编码中文）
- ❌ 无自定义 404 页面（9 个导航死链点击体验差）
- ❌ 无 `loading.tsx`/`error.tsx`（错误处理全在客户端组件里手写）

---

# 12. 运行方式

## 12.1 环境要求

- Node.js 20+ · pnpm · Docker（PostgreSQL 18 + pgvector、Redis 8）

## 12.2 启动

```powershell
# 1. 基础设施
pnpm infra:up

# 2. 后端（端口 3001）
cd apps/api
node dist/main.js          # 或 pnpm dev

# 3. 前端（端口 3000）
cd apps/web
pnpm dev
```

## 12.3 访问

```
http://localhost:3000/login
```

**演示账号**（密码统一 `EstatePilot2026!`）：

| 账号 | 角色 |
|---|---|
| `owner1@estatepilot.demo` | 公司负责人 |
| `manager11@estatepilot.demo` | 店长 |
| `agent111@estatepilot.demo` | 经纪人 |
| `viewer1@estatepilot.demo` | 只读 |

## 12.4 实测步骤（微信闭环）

1. 登录 → 左侧「客户管理」→ 点开任意客户
2. 在「微信消息智能处理」粘贴客户微信消息（或点示例）
3. 点「AI 识别需求并匹配房源」，等 12～30 秒
4. 看需求变化 / 三级预算 / 推荐房源 / 匹配度明细
5. 点「复制微信内容」→ Toast 提示
6. 回到微信 Ctrl+V 发送 → 点「我已发送」
7. 刷新页面 → 切「推荐记录」「消息记录」Tab 验证持久化

## 12.5 验证脚本

```powershell
cd apps/api
# 不依赖外部服务
node --experimental-strip-types scripts/verify-provider-layer.ts   # 33 项
node --experimental-strip-types scripts/verify-dedup.ts            # 27 项
node --experimental-strip-types scripts/verify-aggregator.ts       # 34 项
node --experimental-strip-types scripts/verify-budget-merge.ts     # 三级预算
node --experimental-strip-types scripts/debug-bedrooms.ts          # 户型解析
node --experimental-strip-types scripts/debug-tags.ts              # 标签解析

# E2E
cd apps/web
node_modules\.bin\playwright.cmd test                              # 17 项
```

---

# 13. 下一步规划

## 13.1 立即可做（不依赖任何外部授权）

| # | 任务 | 价值 | 风险 |
|---|---|---|---|
| 1 | **数据库迁移**：加 `fingerprint` 列 + 启用两张零引用的多源表 | 去重持久化、数据源管理有数据层 | 低 |
| 2 | **编排器接入多源聚合** | 闭环真正用上多源 | ⚠️ **中（唯一会碰已验证闭环代码的一步）** |
| 3 | **前端来源标注** | 界面显示「贝壳」「本公司」「用户录入」+ 多源标记 | 低 |
| 4 | **用户录入界面** | 让经纪人真正用上零风险数据源 | 低 |
| 5 | Redis 搜索缓存（需求 §17） | 减少外部调用 | 低 |
| 6 | 数据源管理后台（需求 §12） | 运维可见性 | 低 |
| 7 | 补齐其余页面（房源库/通知/机会等） | 消除 9 个死链 | 低 |

**建议顺序**：1 → 2 → 3 → 4，然后 5 → 6 → 7。

## 13.2 依赖商务/法务（阻塞外部数据源）

| # | 任务 | 阻塞在 |
|---|---|---|
| 8 | **贝壳 AI 平台商用授权书面确认** | 去信 `jiaoxiadan001@ke.com` |
| 9 | 「客户授权模式」法务意见 | 法务 |
| 10 | 接入第一家外部授权源（Anjuke/58/…） | 商务 |
| 11 | 广州/北京/上海地方平台调研 | 调研（本轮未完成） |

## 13.3 产品质量欠债

| # | 任务 |
|---|---|
| 12 | 后端单元测试（当前 0 个） |
| 13 | 前端单元测试（vitest 配置缺失） |
| 14 | 清理死导入、统一重复的枚举映射 |
| 15 | 补自定义 404 / `loading.tsx` / `error.tsx` |
| 16 | 决定是否做暗色模式 |

## 13.4 需要产品决策

- [ ] **产品定位**：接受"L1 行情 + L2 楼盘字典 + L3 自有/授权房源"的定位，还是坚持"必须聚合多平台房源明细"（**后者无合法路径**）？
- [ ] 自有房源录入方式：手工表单 / Excel 导入 / 对接现有系统？
- [ ] 疑似重复房源的人工确认队列放哪个界面？
- [ ] 健康度并入 `PropertyProviderConfig` 还是独立 `provider_health` 表？

---

# 附录：文档索引

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) | 开发计划与进度、环境事实、验证方式 |
| [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) | Phase 11 微信闭环实施报告 |
| [MULTI_PROVIDER_IMPLEMENTATION_REPORT.md](MULTI_PROVIDER_IMPLEMENTATION_REPORT.md) | 多源架构实施报告 |
| [docs/MULTI_PROVIDER_ARCHITECTURE.md](docs/MULTI_PROVIDER_ARCHITECTURE.md) | 多源架构设计（741 行） |
| [docs/china-property-platform-data-access-compliance-report.md](docs/china-property-platform-data-access-compliance-report.md) | 中国房源平台合规调研（含 550 万判例） |
| [docs/BEIKE_INTEGRATION.md](docs/BEIKE_INTEGRATION.md) | 贝壳接入指南 |
| [DEVELOPMENT_ENVIRONMENT.md](DEVELOPMENT_ENVIRONMENT.md) | 开发环境说明 |
