# Multi Provider 实施报告

> 阶段：Provider 抽象层 + 多源聚合（Phase 1–2 完成）
> 日期：2026-10-09
> 设计依据：[MULTI_PROVIDER_ARCHITECTURE.md](./MULTI_PROVIDER_ARCHITECTURE.md) · [合规调研报告](./china-property-platform-data-access-compliance-report.md)

---

## 0. 本阶段结论摘要

| 项目 | 结果 |
|---|---|
| **架构改造** | ✅ 完成。业务层与数据源解耦，新增 Provider 抽象层与多源聚合器 |
| **既有功能** | ✅ **零回归**。17/17 E2E 通过，编排器与贝壳原实现**一行未改** |
| **多源去重** | ✅ 完成并验证（含需求 §8 的原始用例） |
| **故障降级** | ✅ 完成并验证（贝壳失败时其它源正常返回） |
| **合规拦截** | ✅ 架构层强约束（非法凭证类型无法注册） |
| **爬虫 Provider** | ⏸ **未实施** —— 等待明确授权（见 §10） |
| **Redis 缓存** | ⏸ 未实施（见 §11） |

### 关键数字

| 指标 | 值 |
|---|---|
| 新增文件 | 7 个 |
| 修改已有文件 | 1 个（`packages/types/src/index.ts` 加一行导出） |
| 新增验证断言 | **94 项**（33 + 27 + 34），全部通过 |
| E2E 回归 | 17/17 通过（含完整微信闭环 27 秒） |
| 类型检查 | 全仓 6 个包全绿 |

---

## 1. Provider 架构

### 1.1 分层（已实现）

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

### 1.2 接口设计

需求 §3 要求的方法**全部实现**：

| 需求要求 | 实现 |
|---|---|
| `search(query)` | ✅ `search(query: ProviderSearchQuery)` |
| `getDetail(id)` | ✅ |
| `getImages(id)` | ✅（贝壳如实返回空 —— 它的搜索/详情接口不含图片） |
| `getCommunity(id)` | ✅ 返回 `CommunityProfile`（容积率/绿化率/物业费/户数） |
| `checkStatus(id)` | ✅ `checkAvailability(id)` 返回 `AvailabilityResult`（含核验方式） |
| `healthCheck()` | ✅ |

**额外增加的元信息**（这是架构解耦的关键）：

```
readonly kind: PropertyProviderKind          // 哪一家
readonly sourceType: PropertySourceType      // 什么形态（官方 API / 用户提供 / 私有 / 演示）
readonly credentialType: ProviderCredentialType  // 凭证类型（合规约束）
readonly tier: ProviderTier                  // 层级（Level 1/2/3/4）
readonly capability: ProviderCapability      // 能力声明
displayName(): string                        // 界面来源标签
```

### 1.3 能力声明（`ProviderCapability`）

**这是本阶段最重要的设计之一** —— 它解决了"多源改造会拆掉已有补偿逻辑"的风险：

| 能力位 | 为什么必须 |
|---|---|
| `canPaginate` | 贝壳 `false`（单次 TopK ≈ 10）→ 上层据此决定是否做"区域放宽重搜" |
| `maxResultsPerQuery` | 贝壳 10，用户提供 200 |
| `supportsRealtimeStatus` | 贝壳 `true`，用户提供 `false`（无法核验，必须诚实声明） |
| `supportsImages` | 贝壳 `false`（搜索/详情不含图片 URL） |
| `rateLimit` | 并发与缓存策略依据 |

### 1.4 统一错误模型

```
ProviderError {
  provider: PropertyProviderKind     // 哪个源出问题
  code: ProviderErrorCode            // NOT_CONFIGURED / AUTH_FAILED / UNAVAILABLE
                                     // / RATE_LIMITED / INVALID_QUERY / EMPTY_RESULT
                                     // / PARSE_FAILED / TIMEOUT / UNKNOWN
  retryable: boolean                 // 是否值得重试
  retryAfterMs: number | null        // 建议等待多久
  originalError: Error | null        // 保留原始错误便于排查
}
```

**收益**：业务层不再需要 `instanceof BeikeCliError` 这类供应商专属判断。
贝壳的错误特征判定逻辑（硬编码中文串 + errno）**保留在 `BeikeMcpClient` 里**，
适配器只做语义映射 —— 不复制规则，避免两处漂移。

---

## 2. 数据库变化

### 2.1 本阶段**未做任何数据库迁移**

原因：审计发现数据库里**已有两张为多源设计但零使用的表**，本阶段先完成代码层抽象，
表结构变更（新增 `fingerprint` 列等）留到下一步与去重持久化一起做。

### 2.2 现成可用的多源结构（未改动）

| 结构 | 状态 |
|---|---|
| `Property.externalProvider` + `externalId` | ✅ 已有，唯一约束 `@@unique([organizationId, externalProvider, externalId])` |
| `Property.communityNormalized` + 索引 | ✅ 已有（但归一化实现有三份不一致 —— 本阶段已统一，见 §6.3） |
| `PropertyProviderRecord`（多源快照） | ⚠️ 已有但唯一写入点在**死代码**里 |
| `PropertyProviderConfig`（多源配置） | ⚠️ 已有但**业务代码零引用** |

### 2.3 下一步需要的一次迁移

| 变更 | 用途 |
|---|---|
| `Property.fingerprint String? @index` | 跨源归并指纹持久化（当前只在内存计算） |
| `Property.mergedSourceCount Int @default(1)` | 界面显示"3 个平台在售" |
| `Property.lastVerifiedAt DateTime?` | 最后核验在售时间 |
| `PropertyProviderRecord.isPrimary Boolean` | 标记主来源 |
| `PropertyProviderRecord.sourceUrl String?` | 原始链接 |
| `PropertyProviderConfig` 补健康度字段 | 启用数据源管理 |

---

## 3. 贝壳迁移情况

### 3.1 严格遵循「不重写，只做 Adapter」

| 现有部分 | 处理 |
|---|---|
| `beike-mcp-client.ts`（CLI 调用 / Key 注入 / 重试 / 脱敏） | **一行未改** |
| `beike-response-parser.ts`（响应解析 / 字段映射） | **一行未改** |
| `beike-property.provider.ts`（旧接口实现） | **一行未改** |
| `wechat-assistant.orchestrator.ts`（闭环编排） | **一行未改** |

新增 `beike-provider-v2.ts`（约 470 行）—— **纯包装**：

```
ProviderSearchQuery（结构化）
      ↓ buildNaturalQuery()          ← 唯一需要翻译的地方
贝壳自然语言查询
      ↓ BeikeMcpClient.searchHouses()  ← 复用现有
BeikeCliResult
      ↓ BeikeFieldMapper.mapEntity()   ← 复用现有
NormalizedProperty[]
      ↓ toProviderError()              ← 唯一需要翻译的地方
ProviderSearchResult / ProviderError（统一形态）
```

### 3.2 命名说明

新类名 `BeikePropertyProviderV2`（带 V2 后缀），与旧类 `BeikePropertyProvider` 共存。
**这是刻意的**：两者服务不同接口，旧的仍被 `beike.controller.ts` 等处使用。
等编排器迁移完成、新接口稳定后，再决定是否合并。

### 3.3 迁移验证

| 验证项 | 结果 |
|---|---|
| 类型检查 | ✅ 通过 |
| 文件修改时间证明 | 编排器 `10:58`、贝壳原实现 `10-08 17:52`、CLI 客户端 `11:07` —— 本轮（14:00 后）**均未触碰** |
| 端到端回归 | ✅ 17/17 E2E 通过，含完整微信闭环（27.1 秒） |
| 原有验证脚本 | ✅ 三级预算 5/5、户型 0 未识别、标签 4/4 |

---

## 4. 已实现的数据源

### 4.1 `BeikePropertyProviderV2`（贝壳官方 API）

| 项 | 值 |
|---|---|
| sourceType | `OFFICIAL_API` |
| credentialType | `OFFICIAL_API` |
| tier | Level 1 |
| 能力 | 详情✅ 学区✅ 地铁✅ 成交✅ 实时状态✅ 图片❌ 翻页❌（TopK 10） |

### 4.2 `UserProvidedPropertyProvider`（用户录入 —— 零法律风险路径）

**这是本阶段新增的最重要数据源**，因为它是唯一**现在就能用、且完全合规**的外部房源入口。

| 项 | 值 |
|---|---|
| sourceType | `USER_PROVIDED` |
| credentialType | `USER_PROVIDED` |
| tier | Level 3 |
| 输入形态 | HTML 文件 / 粘贴文本 / 结构化 JSON |
| 能力 | 图片✅ 学区✅ 地铁✅ **实时状态❌**（如实声明无法核验） |

**合规依据**：由经纪人在浏览器自行获取页面内容并提供给系统，
性质等同于"经纪人复制客户微信消息粘贴进来"——**数据由用户获取，我们不做任何自动化访问**。

**已实现的关键处理**：

| 处理 | 说明 |
|---|---|
| **价格单位推断** | "568万" / 568 / "5,680,000元" / "0.0568亿" 全部正确解析为 5,680,000 元 |
| **关键字段校验** | 缺城市/小区/价格/面积 → 拒绝生成房源并报告缺失字段（防脏数据） |
| **externalId 稳定性** | 同一房源重复录入得到同一 ID（幂等入库前提）；有 URL 时从 URL 提取平台 ID |
| **字段缺失报告** | 返回 `missingFields` 供界面引导用户补全 |

---

## 5. 搜索流程

### 5.1 已实现的多源搜索

```
ProviderSearchQuery
      ↓
registry.getSearchableProviders()
      ├─ 过滤：凭证未配置 / 管理员禁用 / DEMO 源
      └─ 排序：tier 升序 → 健康度降序
      ↓
并发调用（Promise.allSettled，单源失败不影响其它）
      ├─ 每源独立超时（默认 15s）
      └─ 失败 → 记录 ProviderError + 更新健康度
      ↓
PropertyDeduplicationService.merge()
      ↓
AggregatedProperty[]（带 sources / primarySource / fingerprint / dataConfidence）
```

### 5.2 降级行为（需求 §15 已验证）

| 场景 | 行为 | 验证 |
|---|---|---|
| 贝壳失败，其它源正常 | **其它源结果照常返回**，executions 如实记录贝壳失败 | ✅ 34 项验证中的 §1 |
| 全部源失败 | 抛 `AllProvidersFailedError`（**不是"零结果"**），含每源失败原因 | ✅ §4 |
| 单源超时 | 放弃该源，用其它源结果 | ✅ 超时包装已实现 |
| 禁用单源 | 该源不参与，其它源正常 | ✅ §6 |

**关键设计**：`DEGRADED` 的源**仍然参与搜索**（只是排序靠后）。
理由：贝壳的真实故障是"连接正常但查询失败"，完全跳过会导致它恢复后仍不可用。

---

## 6. 去重方案

### 6.1 三级判定

| 级别 | 判据 | 置信度 | 动作 |
|---|---|---|---|
| 一级 | 同 provider + 同 externalId | 1.00 | 同一条记录 |
| 一级（反向） | 同 provider + **不同** externalId | 1.00 | **确定是两套**（安全阀） |
| 二级 | 指纹精确匹配（小区+户型+面积档+楼层档） | 0.95 | 自动归并（若价格差 ≤5%） |
| 二级（变体） | 指纹一致但价格差 > 5% | 0.75 | **疑似** → 人工确认 |
| 三级 | 多维加权相似度 | 0.60~0.90 | ≥0.85 归并；0.70~0.85 疑似 |

### 6.2 核心设计决策：疑似不自动合并

相似度落在 `[0.70, 0.85)` → 进人工确认队列。

**理由**：错误合并的代价远高于漏合并。
- 漏合并：经纪人看到两条相似房源，可能自己发现是同一套（可恢复）
- **错误合并：把两套不同的房子合成一条 → 带客户看错房（不可恢复，损害信任）**

多维权重：小区 40% / 面积 20% / 户型 15% / 价格 15% / 楼层 10%

### 6.3 踩坑与修复（本阶段发现并解决）

| # | 问题 | 表现 | 修复 |
|---|---|---|---|
| 1 | **面积档边界不稳定** | `round(104.8/2)*2=104` vs `round(105.2/2)*2=106` → 跨源同一套房落进不同档，**漏匹配** | 改用 5㎡ 档（104.8 与 105.2 都 → 105）；判定精度交给 `compare()` |
| 2 | **楼层分档对低层建筑失效** | 6 层楼的 5 楼被判为 `high`（按比例 0.83 > 0.67） | 总层数 ≤6 时不设 `high` 档 |
| 3 | **三份不一致的归一化实现** | 大小写不一致 → `浦东XX花园` 与 `浦东xx花园` 匹配失败 | 抽取唯一 `CommunityNormalizerService` |
| 4 | **测试期望错误**（我的） | 把「汤臣一品」vs「汤臣一品花园」当"不该合并"的反例 —— 它们本就该判为同一小区 | 修正测试期望，并补真正的边界用例 |

### 6.4 小区名归一化（保守策略）

| 步骤 | 处理 |
|---|---|
| 1 | 全角转半角 |
| 2 | 去空白 |
| 3 | 去括号内容（分期信息，`(四期)`） |
| 4 | 转小写 |
| 5 | **行政区前缀去除** —— 仅当小区确属该行政区时生效（安全阀） |

**防误合并保护**：
- 子串匹配要求较短方 ≥3 字（"花园"不会被匹配上"汤臣一品花园"）
- 长度差 ≤4 字
- 行政区前缀去除要求 `district` 参数一致

---

## 7. 缓存方案

### 7.1 本阶段未实施

原因：多源聚合刚完成，缓存策略需要基于**真实的多源响应特征**设计
（各源响应时间差异、结果稳定性）。在没有真实多源数据的情况下设计缓存，
很可能做出错误的 TTL 与键设计。

### 7.2 已确定的设计约束（待实施）

| 约束 | 理由 |
|---|---|
| **搜索缓存 TTL ≤ 5 分钟** | 需求 §17 |
| **房源状态绝不长期缓存** | 需求原文："房源状态不能长期缓存" —— 下架的房源推荐给客户会严重损害信任 |
| 缓存键含 provider 集合 | 某个源故障时结果不同，不能复用 |
| 缓存降级结果必须标记 | 已有 `dataSource` / `cacheNote` 机制，需与搜索缓存区分 |

---

## 8. 健康监控

### 8.1 已实现

| 能力 | 说明 |
|---|---|
| 状态机 | `ONLINE` / `DEGRADED` / `OFFLINE` / `DISABLED` / `NOT_CONFIGURED` |
| 滑动窗口 | 最近 20 次调用 |
| 熔断阈值 | 失败率 > 60% → `DEGRADED`；连续失败 ≥5 → `OFFLINE` |
| 统计 | 总调用、失败数、成功率、平均响应、最后调用时间、返回条数 |
| 管理员启停 | `setEnabled(kind, enabled)` |
| 恢复 | 成功一次即从 `OFFLINE` 回到 `DEGRADED`（避免抖动）；回 `ONLINE` 由健康探测确认 |
| 持久化接口 | `snapshot()` 导出，可写入 `PropertyProviderConfig` 表 |

### 8.2 与现有实现的关系

现有 `BeikeMcpClient` 已有重试 + `isUnavailable` / `isServiceBusy` 判定，
这部分**保留不动**（它最了解自己的错误特征）。
健康监控是新的一层，记录跨源的统一统计。

---

## 9. 测试结果

### 9.1 新增验证（94 项，全部通过）

| 脚本 | 断言数 | 结果 | 覆盖 |
|---|---|---|---|
| `verify-provider-layer.ts` | 33 | ✅ | 价格解析、字段校验、ID 稳定性、过滤、合规约束 |
| `verify-dedup.ts` | 27 | ✅ | 归一化、需求 §8 原例、反向能力、指纹 |
| `verify-aggregator.ts` | 34 | ✅ | **需求 §20 全部要求** + 降级 + 健康监控 + 合规拦截 |

运行方式：
```powershell
cd apps/api
node --experimental-strip-types scripts/verify-provider-layer.ts
node --experimental-strip-types scripts/verify-dedup.ts
node --experimental-strip-types scripts/verify-aggregator.ts
```

### 9.2 回归验证（零破坏）

| 验证 | 结果 |
|---|---|
| 全仓类型检查（6 个包） | ✅ 全绿 |
| Playwright E2E | ✅ **17/17 通过**（1.4 分钟） |
| ├ 完整微信闭环 | ✅ 27.1 秒通过 |
| └ Console 零错误 | ✅ |
| `verify-budget-merge.ts` | ✅ 5/5 |
| `debug-bedrooms.ts` | ✅ 0 未识别 |
| `debug-tags.ts` | ✅ 4/4 |

### 9.3 需求 §20 测试要求对照

| 需求 | 状态 |
|---|---|
| 1. 贝壳正常 | ✅ 由已有 E2E 覆盖（闭环 27 秒通过） |
| 2. 贝壳关闭 → 系统仍返回其它来源 | ✅ 已专门验证 |
| 3. 安居客返回数据 | ⚠️ 通过 `UserProvidedPropertyProvider` 模拟验证（真实安居客数据需您提供页面内容） |
| 4. 多个来源同一房源正确合并 | ✅ 已专门验证（3 源 → 1 条） |
| 5. 同一客户搜索不产生重复房源 | ✅ 已专门验证 |
| 6. AI 推荐不受来源影响 | ✅ 架构保证（`hard-filter` 与 `match-scoring` 只接收 `NormalizedProperty[]`） |

---

## 10. 待您确认后再做：低频爬虫 Provider

### 10.1 当前状态：**未实施**

您已选择「两者都做：先做用户提供数据，同时做低频爬虫」，但我在实施前需要一次
**明确的书面确认**，原因如下（这不是保守，而是有判例依据）：

### 10.2 法律现实（已调研确认）

| 事实 | 来源 |
|---|---|
| **链家/贝壳 诉「推推99」判赔 550 万元，已生效** | 海淀法院一审，被告撤回上诉 |
| 侵权形态：抓取 → 存自有服务器 → 去水印 → 展示给用户 + 供下载转发 | 判决书 |
| **裁判规则：「向公众无差别展示的公开数据，不意味着其他经营者可以不受限制地获取和使用」** | 判决原文 |
| 法院还认定被告为"发布虚假房源提供了工具和便利条件" —— **下游怎么用数据会成为你的责任** | 判决书 |

### 10.3 我建议的实施边界（若您确认要做）

| 约束 | 具体做法 |
|---|---|
| **仅开发环境** | 由 `NODE_ENV !== 'production'` + 显式开关双重门控；生产构建里直接不注册 |
| **仅手动触发** | 不接入任何自动调度；只在开发者执行脚本时运行 |
| **默认关闭** | 配置默认 `false`，需显式开启 |
| **严格限频** | 单次会话 ≤ N 个页面，页间随机延迟 ≥ 数秒 |
| **绝不落库对外展示** | 产物只用于**验证聚合链路**（走 `USER_PROVIDED` 路径），不进入生产推荐 |
| **不绕过任何限制** | 无验证码破解、无登录绕过、无安全限制规避、无 UA 伪装 |
| **代码内标注风险** | 文件头写明法律风险与适用边界，防止后人误用 |

### 10.4 需要您确认的一句话

> **"我确认已了解上述法律风险，并要求在开发环境实现低频爬虫，
> 严格限定为手动触发、默认关闭、不落库对外展示。"**

同时请确认：**Playwright 抓取的产物是否允许写入数据库**？
（我建议**不允许** —— 只用于跑通聚合链路验证。）

---

## 11. 下一阶段计划

### 11.1 立即可做（不依赖任何外部授权）

| # | 任务 | 价值 |
|---|---|---|
| 1 | **数据库迁移**：`fingerprint` 列 + 多源字段 + 启用 `PropertyProviderConfig` | 去重持久化；数据源管理有数据层 |
| 2 | **编排器接入多源聚合** | 闭环真正用上多源（当前仍是单一贝壳路径） |
| 3 | **前端来源标注** | 界面显示「贝壳」「本公司」「用户录入」+ 多源标记 |
| 4 | **用户录入界面** | 让经纪人真正能用上零风险数据源 |
| 5 | **Redis 搜索缓存** | 需求 §17 |
| 6 | **数据源管理后台** | 需求 §12 |

### 11.2 依赖商务/法务

| # | 任务 | 阻塞在 |
|---|---|---|
| 7 | 贝壳 AI 平台商用授权确认 | 书面去信 `jiaoxiadan001@ke.com` |
| 8 | 客户授权模式法务意见 | 法务 |
| 9 | 接入第一家外部授权源 | 商务 |

### 11.3 我的建议顺序

**1 → 2 → 3 → 4**（这样多源能力才真正对经纪人可见可用），
然后 **5 → 6**（体验优化与运维），最后 **7–9**（等授权）。

⚠️ 特别提醒：**任务 2 是唯一会碰已验证闭环代码的一步**，
建议单独一次改动、单独验证、便于回滚。

---

## 12. 附：本阶段新增文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `packages/types/src/property-provider.ts` | ~560 | 多源契约（枚举/接口/错误模型/聚合结果） |
| `apps/api/.../beike/beike-provider-v2.ts` | ~470 | 贝壳适配器（纯包装） |
| `apps/api/.../user-provided/user-provided-property.provider.ts` | ~520 | 用户录入数据源 |
| `apps/api/.../dedup/community-normalizer.service.ts` | ~200 | 小区名归一化（唯一实现） |
| `apps/api/.../dedup/property-deduplication.service.ts` | ~460 | 跨源去重引擎 |
| `apps/api/.../providers/provider-registry-v2.ts` | ~240 | 多源注册表（含合规拦截） |
| `apps/api/.../providers/provider-health-monitor.service.ts` | ~330 | 健康监控与熔断 |
| `apps/api/.../providers/multi-source-aggregator.service.ts` | ~400 | 多源聚合器 |
| `apps/api/scripts/verify-provider-layer.ts` | ~250 | 33 项验证 |
| `apps/api/scripts/verify-dedup.ts` | ~290 | 27 项验证 |
| `apps/api/scripts/verify-aggregator.ts` | ~560 | 34 项验证 |

**唯一修改的已有文件**：`packages/types/src/index.ts`（加一行导出）。
