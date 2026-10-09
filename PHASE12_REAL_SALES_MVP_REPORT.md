# Phase 12 实施报告 · 真实销售 MVP

> 目标：把 EstatePilot 从「AI 房地产演示系统」升级为「房地产销售每天使用的 AI 房源推荐助手」
> 日期：2026-10-09
> 核心原则：**Demo 数据绝不进入真实销售流程**

---

## 1. 完成内容

### 1.1 一句话总结

**Phase 12 的核心目标——隔离 Demo 数据、建立可信度模型、升级推荐排序与卡片——已完成并验证。**

具体地说：**从架构层面保证演示数据无法进入推荐结果**，并且每条房源现在都带有
"有多可信、多久前确认过、能不能直接发给客户"的完整信息。

### 1.2 逐项对照需求

| 需求 | 状态 | 说明 |
|---|---|---|
| §2 生产推荐流程禁止 Demo | ✅ **完成** | 三层防线（注册表 / 聚合器 / 数据库白名单） |
| §3 环境区分（dev 允许 / prod 禁止） | ✅ **完成** | 生产环境**一票否决**，无法通过配置绕过 |
| §4 Property 加可信度字段 | ✅ **完成** | `dataReliabilityScore` / `lastVerifiedAt` / `verificationStatus` |
| §5 推荐排序升级 | ✅ **完成** | 综合分 = 匹配度×0.7 + 可信度×0.2 + 时效性×0.1 |
| §5 来源不影响评分 | ✅ **完成** | 打分函数签名无 provider；可信度是独立维度 |
| §6 推荐卡片可信度区域 | ✅ **完成** | 星级 + 来源 + 更新时间 + 核验状态 + 诚实说明 |
| §6 不隐藏风险 | ✅ **完成** | 三种状态用颜色区分，文案明确写出"非实时" |
| §9 AI 学习客户偏好 | ✅ **后端已具备** | 反馈解析服务已实现并验证（Phase 11） |
| §10 房源人工导入 UI | ⏸ **未完成** | 后端已有（`UserProvidedProvider` + 导入接口），**UI 待做** |
| §8 客户反馈 UI | ⏸ **未完成** | 后端已有（`POST /recommendations/:batchId/feedback`），**UI 待做** |
| §11 贝壳 Provider 错误区分 | ✅ **已完成**（Phase 11） | 区分无结果 / 服务异常 / 授权问题 |
| §12 前端优先级 P0 前两项 | ✅ **完成** | 微信助手页面 + 推荐卡片 |
| §14 六项必需测试 | ✅ **5/6 完成** | 见 §4.1 |
| §13 禁止事项 | ✅ **全部遵守** | 未扩大 Demo、未编造房源/地铁/学区/成交状态 |

### 1.3 三个核心交付

#### ① Demo 数据三层隔离（架构级保证）

**为什么需要三层**：一次配置失误就可能让假房源发给真实客户，代价太高。

| 层 | 位置 | 拦截逻辑 |
|---|---|---|
| **第 1 层** | `ProviderRegistryV2.getSearchableProviders()` | 生产环境直接排除 DEMO 源；开发环境需 `includeDemo` + `ALLOW_DEMO_DATA=true` 双重门控 |
| **第 2 层** | `MultiSourceAggregator` 归并后 | 再过滤一次 MOCK 来源的房源（防御性） |
| **第 3 层** | `CachedPropertySearchService` 数据库查询 | **白名单** `[BEIKE, INTERNAL, ANJUKE]` —— 不是"排除 MOCK" |

**为什么第 3 层用白名单而不是黑名单**：
黑名单是"列举不允许的"，将来新增任何来源都会**默认被允许**（包括测试数据）。
白名单是"列举允许的"，新增来源必须**显式加进来**。

**防绕过设计**：生产环境**无视** `ALLOW_DEMO_DATA=true`。这是刻意的"一票否决"。

#### ② 数据可信度模型

**新增三个字段**（详见 §3 数据库变化）：

| 字段 | 作用 |
|---|---|
| `dataReliabilityScore` (0~100) | 数据有多可信 |
| `lastVerifiedAt` | 最后一次**确认在售**的时间（≠ 同步时间） |
| `verificationStatus` | `VERIFIED` / `PENDING` / `EXPIRED` |

**关键设计：`lastVerifiedAt` 与 `lastSyncedAt` 的区别**
- `lastSyncedAt` = 同步到了数据
- `lastVerifiedAt` = **确认过它还在卖** ← 后者才决定能不能发给客户

**四档可信度**（需求 §4 规定的标准值）：

| 来源 | 基础分 | 核验时效 |
|---|---|---|
| 贝壳实时 API | 100 | 24 小时 |
| 公司自有房源 | 95 | 72 小时 |
| 经纪人上传 | 80 | **null（无法核验）** |
| 本地缓存 | 70 | 72 小时 |
| 演示数据 | **0** | — |

**无法核验的来源如实处理**：经纪人手动录入的房源 `verificationTtlHours = null`，
状态永远 `PENDING`，且**不写 `lastVerifiedAt`** ——
写一个假的时间会让界面误以为"刚确认过"，那是欺骗用户。

#### ③ 推荐排序与卡片

**新公式**（需求 §5）：

```
FinalScore = 需求匹配度 × 0.7 + 数据可信度 × 0.2 + 时效性 × 0.1
```

**权重理由**：
- 匹配度 70%：产品核心价值是"给客户找到对的房子"，匹配度必须主导排序
- 可信度 20%：同样匹配的两套，更可信的优先
- 时效性 10%：刚核验过的排前面

⚠️ **来源名称不参与任何计算** —— 只有量化的可信度分数参与。
满足需求 §5「不要让来源名称影响评分，只影响真实性权重」。

**时效性得分用阶梯式而非线性**（因为经纪人的判断是定性的）：

| 时间 | 得分 |
|---|---|
| 1 小时内 | 100 |
| 半天内 | 95 |
| 一天内 | 85 |
| 三天内 | 70 |
| 一周内 | 50 |
| 一个月内 | 30 |
| 更久 | 10 |

**推荐卡片新增可信度区域**（需求 §6）：

```
★★★☆☆  来源：贝壳（本地缓存）  更新时间：未知  需要确认
贝壳当前不可用，这是此前同步的历史快照，房源状态可能已变化。
发送给客户前请先确认是否仍在售。
────────────────────────────────────────────
综合排序分 75.6            曾推荐过    [详情] [上移] [置顶] [移除]
```

**状态颜色区分**：可发（绿）/ 需确认（黄）/ 已过期（红）。
**匹配度与可信度分开显示** —— 一个是"合不合适"，一个是"真不真"，不能混成一个数。

---

## 2. 代码修改文件

### 2.1 新增文件（5 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `apps/api/src/modules/property/reliability/property-reliability.service.ts` | ~420 | 可信度策略：Demo 隔离 + 评分 + 综合排序 |
| `apps/api/src/modules/property/providers/legacy-provider.adapter.ts` | ~200 | 旧接口 → V2 适配器 + Demo Provider 构造 |
| `apps/api/scripts/verify-phase12.ts` | ~520 | 六项必需测试（36 项断言） |
| `apps/api/scripts/stats-overview.ts` | ~150 | 数据统计脚本 |
| `packages/database/prisma/migrations/20261009150000_phase12_property_verification/migration.sql` | 14 | 数据库迁移 |

### 2.2 修改文件（8 个）

| 文件 | 改动 | 风险 |
|---|---|---|
| `packages/database/prisma/schema.prisma` | 新增枚举 + 3 字段 + 2 索引 | 低 |
| `packages/types/src/property-provider.ts` | 能力加 `baseReliabilityScore` / `verificationTtlHours`；聚合结果加可信度字段 | 低 |
| `apps/api/.../providers/provider-registry-v2.ts` | 注入可信度策略 + 自动装配 Provider + Demo 拦截 | 中 |
| `apps/api/.../providers/multi-source-aggregator.service.ts` | 第二层 Demo 过滤 + 可信度计算 | 中 |
| `apps/api/.../providers/beike/beike-provider-v2.ts` | 声明可信度档位（100 / 24h） | 低 |
| `apps/api/.../providers/user-provided/user-provided-property.provider.ts` | 声明可信度档位（80 / null） | 低 |
| `apps/api/.../requirement/cached-property-search.service.ts` | **来源白名单** + **修复来源硬编码 bug** | 中 |
| `apps/api/.../requirement/wechat-assistant.orchestrator.ts` | 注入可信度服务 + DTO 加可信度字段 + **修复来源硬编码** | 中 |
| `apps/api/.../requirement/property-upsert.service.ts` | 可信度透传（4 处签名） + 归一化修复 | 中 |
| `apps/api/src/modules/property/property.module.ts` | 注册 V2 服务 | 低 |
| `apps/web/src/lib/queries/use-wechat-assistant.ts` | 类型加可信度字段 | 低 |
| `apps/web/src/components/customer/recommended-property-card.tsx` | 可信度区域 + 星级/时间辅助函数 | 低 |
| `apps/web/e2e/wechat-assistant.spec.ts` | 更新来源断言 + 新增可信度断言 | 低 |

### 2.3 修掉的两个真实 bug

**Bug 1：`cached-property-search.service.ts` 的来源硬编码**

原代码 `toNormalized()` 里写死 `externalProvider: PropertyProviderKind.BEIKE`。
在"缓存里只有贝壳房源"时看不出问题；但 Phase 12 放开了白名单
（允许自有房源、经纪人录入），硬编码会导致**自有房源被错误标注成贝壳来源** ——
这是数据溯源上的严重错误（界面会显示错误的来源标签）。

**修法**：从数据库读取真实来源，并加入 `select`。

**Bug 2：`normalizeCommunity` 里的空操作正则**

```js
.replace(/(小区|花园|公寓|大厦|苑|城|湾|府|园)$/u, (match) => match)  // 匹配到又原样返回
```
作者本意大概是"保留后缀"，但 `match => match` 等于什么都没做。
已改为与 `CommunityNormalizerService.normalizeBasic()` 一致的实现（含全角转半角）。

### 2.4 ⚠️ 一次事故与恢复（必须记录）

**事故**：我在用 PowerShell 修改 `property-upsert.service.ts` 时触发了
`Get-Content -Raw`（按 ANSI 读取 UTF-8）→ `WriteAllText`（按 UTF-8 写回）
的**编码往返损坏**，导致 **80 行中文注释 + 12 行代码**变成乱码。

**这违反了项目已有的环境事实 E22**（PowerShell 文本往返会损坏 UTF-8，必须用编辑工具）。

**恢复方式**：
1. 全量扫描 `apps/api/src` 的 71 个文件，**确认只有 1 个文件损坏**
2. 用 `dist`（损坏前最后一次构建，**保留了完整中文注释**）作为恢复依据
3. 用 `write` 工具完整重写该文件（460 行）
4. 恢复后验证：无乱码、类型检查通过、全部测试通过

**教训**：含中文的文件**一律用 edit/write 工具**，绝不用 PowerShell 做文本往返。
已把这条写进本报告，避免后人重蹈。

---

## 3. 数据库变化

### 3.1 迁移

```
20261009150000_phase12_property_verification
```

```sql
-- 新增枚举
CREATE TYPE "PropertyVerificationStatus" AS ENUM ('VERIFIED', 'PENDING', 'EXPIRED');

-- properties 表新增 3 列
ALTER TABLE "properties"
  ADD COLUMN "dataReliabilityScore" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "lastVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "verificationStatus" "PropertyVerificationStatus" NOT NULL DEFAULT 'PENDING';

-- 新增 2 个索引
CREATE INDEX "properties_organizationId_verificationStatus_dataReliabilit_idx"
  ON "properties"("organizationId", "verificationStatus", "dataReliabilityScore");
CREATE INDEX "properties_lastVerifiedAt_idx" ON "properties"("lastVerifiedAt");
```

**索引设计理由**：推荐排序需要按"核验状态 + 可信度"筛选
"能放心发给客户"的房源，因此建复合索引。

### 3.2 字段语义

| 字段 | 类型 | 语义 |
|---|---|---|
| `dataReliabilityScore` | `Int @default(50)` | 数据可信度 0~100。默认 50（保守），由 Provider 能力声明换算 |
| `lastVerifiedAt` | `DateTime?` | **最后一次确认在售**的时间。无法核验的来源保持 null |
| `verificationStatus` | enum | `VERIFIED` 可发 / `PENDING` 需确认 / `EXPIRED` 已过期 |

### 3.3 未做的数据库变更（诚实说明）

审计发现数据库里有两张为多源设计但**几乎零使用**的表，Phase 12 **未启用**：

| 表 | 状态 | 说明 |
|---|---|---|
| `PropertyProviderRecord` | ⚠️ 唯一写入点在**死代码**里 | 多源快照审计，建议下一步启用 |
| `PropertyProviderConfig` | ⚠️ 业务代码零引用 | 现成的多源配置表，建议下一步启用 |

这两张表是"数据源管理"（需求 §12 的 P2 优先级）的基础，本阶段未涉及。

---

## 4. 测试结果

### 4.1 需求 §14 的六项必需测试

| # | 需求 | 状态 | 验证方式 |
|---|---|---|---|
| 1 | 生产环境没有 Demo 房源 | ✅ | `verify-phase12.ts` 生产环境模式下 6 项断言全通过 |
| 2 | 推荐结果全部来自真实 Provider | ✅ | 断言返回结果中无 MOCK 来源，且每条都能追溯来源 |
| 3 | 房源来源正确显示 | ✅ | 断言来源名称、可信度分数、星级、核验状态、说明文案 |
| 4 | 复制微信内容正确 | ✅ | E2E 断言文案长度 > 50、无 Markdown、无字段名 |
| 5 | 客户反馈后画像变化 | ⚠️ **部分** | 后端反馈解析已实现并验证（Phase 11 的 `verify-wechat-flow`），**但前端无录入 UI，无法端到端验证** |
| 6 | 过期房源不会优先推荐 | ✅ | 断言综合分对比、EXPIRED 状态判定、分数衰减 |

### 4.2 验证脚本结果（152 项断言全部通过）

| 脚本 | 断言 | 结果 |
|---|---|---|
| `verify-phase12.ts`（开发环境） | 36 | ✅ |
| `verify-phase12.ts`（**生产环境**） | 35 | ✅ |
| `verify-provider-layer.ts` | 33 | ✅ |
| `verify-aggregator.ts` | 34 | ✅ |
| `verify-dedup.ts` | 27 | ✅ |
| `verify-budget-merge.ts` | 5 | ✅ |
| `debug-tags.ts` | 4 | ✅ |
| `debug-bedrooms.ts` | 13（0 未识别） | ✅ |
| **合计** | **152 + 22** | **全部通过** |

**生产环境关键断言**：
```
✓ 生产环境：Demo 数据策略为禁止
✓ 生产环境：即使 includeDemo=true 也不放行演示数据源
✓ 生产环境 + ALLOW_DEMO_DATA=true → 仍然禁止（防绕过）
✓ 搜索结果不含演示小区
✓ 搜索统计中也不含演示数据源
```

### 4.3 E2E 回归（17/17 通过）

| 文件 | 用例 | 结果 |
|---|---|---|
| `auth.spec.ts` | 8 | ✅ |
| `wechat-assistant.spec.ts` | 3 | ✅ 含新增可信度断言 |
| `screenshots.spec.ts` | 4 | ✅ |
| `customer-detail-screenshots.spec.ts` | 2 | ✅ |

**闭环实测**：`POST /wechat-assistant` → HTTP 200，24.9 秒（缓存降级路径）。

### 4.4 实测输出样例

```json
{
  "community": "川杨新苑(六期)",
  "source": "贝壳（本地缓存）",
  "matchScore": 88,
  "dataReliabilityScore": 70,
  "reliabilityStars": 3,
  "verificationStatus": "PENDING",
  "freshnessScore": 0,
  "finalScore": 75.6,
  "reliabilityNote": "贝壳当前不可用，这是此前同步的历史快照，房源状态可能已变化。发送给客户前请先确认是否仍在售。"
}
```

### 4.5 类型检查

**6 个包全绿**：`types` · `utils` · `database` · `ai` · `api` · `web`

---

## 5. 当前真实能力

### 5.1 现在能做什么（真实可用）

| 能力 | 说明 |
|---|---|
| **微信需求闭环** | 粘贴客户消息 → 需求理解 → 三级预算 → 真实房源 → 9 维打分 → 微信文案 → 一键复制 → 已发送确认 |
| **Demo 数据隔离** | 生产环境保证演示数据无法进入推荐（三层防线 + 防绕过） |
| **数据可信度** | 每条房源标注可信度分数、星级、来源、更新时间、核验状态 |
| **可信度诚实提示** | 缓存数据明确写"历史快照，请确认是否仍在售"；无法核验的来源标"需要确认" |
| **综合排序** | 匹配度 + 可信度 + 时效性加权排序 |
| **多源架构** | 贝壳官方 API + 用户录入房源（Provider 层已就绪） |
| **跨源去重** | 同一套房在多个平台出现时正确归并 |

### 5.2 数据现状（诚实说明）

| 项目 | 数量 | 说明 |
|---|---|---|
| 房源总数 | 2,131 | |
| ├ **演示数据** | **2,090** | ⚠️ **生产环境已无法进入推荐** |
| └ **贝壳真实房源** | **41** | 浦东张江一带 |
| 客户 | 300 | |
| 客户行为事件 | 8,631 | |
| 微信闭环实测数据 | 消息 17 / 快照 6 / 推荐批次 14 | |

**关键变化**：虽然库里仍有 2,090 套演示数据，但**它们已经无法进入推荐结果** ——
这正是 Phase 12 的核心价值：**不是删掉演示数据，而是让它在架构上不可能被用到**。

### 5.3 当前仍不具备的能力

| 缺失 | 影响 |
|---|---|
| **房源导入 UI** | 经纪人**无法**上传自己的房源（后端已就绪）→ 这是当前最该补的 |
| **客户反馈 UI** | 无法在界面上录入"客户不喜欢这套"（后端已就绪） |
| 真实房源量少 | 只有 41 套贝壳房源；贝壳服务当前不可用 |
| AI 未配置 | 走内置规则通道，理解复杂表达稍弱 |
| 多源外部数据源 | 商务授权未就绪（安居客/58/房天下无公开 API） |
| 房源库/通知/机会等页面 | 仍是占位页或死链 |

### 5.4 关键约束仍未解除

🔴 **贝壳 AI 开放平台的商用授权待确认**
- 协议 ID 为 `beike_AI_open_Platform_private_protocol`
- Skill 许可写「贝壳内部使用」
- **建议**：去信 `jiaoxiadan001@ke.com` 书面确认
- **在确认前**不要对外宣称"已对接贝壳官方 API"

🔴 **贝壳服务当前不可用**
- 实测所有查询工具返回 `service temporarily unavailable`
- 系统已实现降级（本地缓存）+ 服务状态区分
- 恢复后会自动切回实时数据

---

## 6. 下一阶段建议

### 6.1 立即做（Phase 12 未完成的 P0）

| # | 任务 | 价值 | 依赖 |
|---|---|---|---|
| **1** | **房源导入 UI** | 让经纪人真正能用上"零法律风险"的自有房源 —— **这是当前最重要的缺口** | 后端已就绪 |
| **2** | **客户反馈 UI** | 打通"客户不喜欢 → 画像更新 → 推荐变准"的学习闭环 | 后端已就绪 |
| 3 | 真实房源补充 | 当前只有 41 套真实房源，推荐价值受限 | 需贝壳恢复或经纪人录入 |

**为什么这两项最重要**：
需求 §10/§8 要求它们，而且**后端已经全部就绪** ——
缺的只是一个让经纪人点得到的界面。做完这两项，
"销售每天打开 EstatePilot → 复制微信 → 得到真实房源推荐"的闭环才算真正可用。

### 6.2 短期（体验与运维）

| # | 任务 |
|---|---|
| 4 | 启用 `PropertyProviderRecord` 与 `PropertyProviderConfig`（数据源管理，需求 §12） |
| 5 | Redis 搜索缓存（需求 §17） |
| 6 | 编排器接入多源聚合（当前闭环仍走单一贝壳路径） |
| 7 | 补齐占位页（房源库、通知、机会） |

### 6.3 中期（依赖外部条件）

| # | 任务 | 阻塞在 |
|---|---|---|
| 8 | 贝壳商用授权确认 | 商务去信 |
| 9 | 接入第一家外部授权源 | 商务谈判 |
| 10 | 配置 AI 厂商密钥并对比两条通道 | 采购决策 |

### 6.4 质量欠债

| # | 任务 |
|---|---|
| 11 | **后端单元测试（当前 0 个）** |
| 12 | 前端单元测试（vitest 配置缺失） |
| 13 | 清理死导入、统一重复枚举映射 |
| 14 | 补自定义 404 / loading / error 页 |

### 6.5 一个提醒

Phase 12 的核心是**"让真实可验证"**，而不是"加功能"。
建议下一步继续沿这个方向：**先让经纪人能录入自己的房源与反馈**，
把真实数据用起来，而不是继续扩页面。

---

## 附录 A：验证方式

```powershell
# 全部逻辑验证（不依赖外部服务，152 项断言）
cd apps/api
node --experimental-strip-types scripts/verify-phase12.ts          # 36 项
node --experimental-strip-types scripts/verify-provider-layer.ts   # 33 项
node --experimental-strip-types scripts/verify-aggregator.ts       # 34 项
node --experimental-strip-types scripts/verify-dedup.ts            # 27 项
node --experimental-strip-types scripts/verify-budget-merge.ts     # 5 项
node --experimental-strip-types scripts/debug-tags.ts              # 4 项

# 生产环境模式（验证 Demo 隔离）
$env:NODE_ENV = 'production'
node --experimental-strip-types scripts/verify-phase12.ts          # 35 项
Remove-Item Env:\NODE_ENV

# E2E（17 项）
cd apps/web
node_modules\.bin\playwright.cmd test
```

## 附录 B：本阶段踩坑清单

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 闭环 500 错误 | 改了 schema 后只 `prisma generate`，`packages/database/dist` 是旧的增量编译产物 | 重建 database 包（`rmdir dist` + `tsc`） |
| 2 | **80 行文件损坏** | PowerShell `Get-Content -Raw` + `WriteAllText` 编码往返（违反环境事实 E22） | 用 dist 作恢复依据，`write` 工具重写 |
| 3 | 来源硬编码 bug | `toNormalized()` 写死 BEIKE，白名单放开后会错误标注自有房源 | 从数据库读取真实来源 |
| 4 | 归一化空操作 | `.replace(/.../, (match) => match)` 等于没做 | 重写为标准化实现 |
| 5 | 可信度文案错误 | 所有"无法核验"情况都写成"来自人工录入"，导致贝壳缓存被误描述 | 按来源类型区分文案 |
| 6 | 文案含 Markdown | `**历史快照**` 会原样显示在界面 | 用户可见文案禁用 Markdown 标记 |
