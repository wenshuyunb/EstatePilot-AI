# 贝壳 API 修复报告

> 日期：2026-10-09
> 目标：保证项目能用贝壳 API 正常搜索房源

---

## 一、结论先说

### 1.1 我修了什么

| # | 问题 | 修复 | 效果 |
|---|---|---|---|
| **1** | **直连调用报 `-32602 Invalid request parameters`** | `notifications/initialized` 是 JSON-RPC **通知**，不能带 `id`；且通知失败不应阻断握手 | 直连从"全部失败"变为**正常到达服务层** |
| **2** | **生产链路依赖 CLI 子进程** | 新增**直连 HTTP MCP 传输层**，CLI 保留为兜底 | 耗时 **232ms vs CLI 5107ms（快 22 倍）** |
| **3** | **服务故障时白等 25 秒** | 直连识别出确定性失败后**立即熔断**，且**跳过 CLI 回退** | 单次 **702ms**（原 5835ms） |
| **4** | **错误信息误导** | 直连把服务端原始错误透出 | 不再把"服务故障"说成"没有房源" |
| **5** | **诊断走 CLI 看不到真相** | 诊断优先走直连 | `直连 MCP 正常（发现 18 个工具）` |

### 1.2 我没能修什么（必须如实说明）

**贝壳服务端的数据层当前是故障状态，我方无法修复。**

这不是推测，是三重独立验证的结论：

| 证据 | 内容 |
|---|---|
| **1. 直连 HTTP 也失败** | 带正确的 `X-Beike-Cli-Version` 头、正确参数，`house_search` 返回 `service temporarily unavailable` |
| **2. 伪造 Key 对照** | 换假 Key 返回的是**另一个错误**（`Invalid or missing Authorization header`）→ 说明真 Key **已通过鉴权**，故障在鉴权之后 |
| **3. 16/16 工具全挂 + 连测 3 次稳定** | 不是瞬时抖动，是持续性服务故障 |

```
initialize      → 200 ✓ 布丁MCP服务 v3.4.7
tools/list      → 200 ✓ 18 个工具
tools/call ×16  → 全部 isError=true: "service temporarily unavailable"
```

**Key 有效、协议正确、参数正确、网络正常 —— 是对方的数据服务挂了。**

---

## 二、修复内容详解

### 2.1 修复 1：直连调用的 `-32602`（最重要的 bug）

**现象**：我第一版直连实现所有 `tools/call` 都返回 `-32602 Invalid request parameters`。

**定位过程**（做了三组对照实验）：

| 变体 | `notifications/initialized` | `tools/call` |
|---|---|---|
| A（带 id + params） | ❌ **-32602** | ✅ 到达服务层 |
| B（不带 id、不带 params） | ✅ 202 空响应 | ✅ 到达服务层 |
| C（跳过通知） | — | ✅ 到达服务层 |

**根因**：我把 `notifications/initialized` 当普通请求发（带了 `id`）。
按 JSON-RPC 规范，**通知不能有 id** —— 服务端因此返回 -32602。

**为什么后果是"全部失败"**：我的 `doHandshake()` 对任何 JSON-RPC 错误都抛异常，
于是通知的 -32602 让**整个握手被判失败**，后续 `tools/call` 根本没机会执行。

**修复**（两处）：
1. 通知不带 `id`、不带 `params`
2. 通知失败**只记日志不抛错** —— 它本身无响应语义，把它的错误当致命错误，
   会让"只是通知格式问题"演变成"整个链路不可用"

**教训**：如果不做对照组实验，我会一直以为是参数或鉴权问题。

### 2.2 修复 2：新增直连 HTTP 传输层

**为什么必须做**（诊断确认的三个 CLI 硬问题）：

| 问题 | 后果 |
|---|---|
| CLI 不发送 `X-Beike-Cli-Version` 头 | 服务端会因此拒绝请求，而我们无法控制也无法验证 |
| CLI 把所有服务端错误压成 `service temporarily unavailable` | 看不到真实原因（版本？鉴权？限流？）——**这次排查就是被它误导了很久** |
| 失败时 HTTP 状态码仍是 200 | 只看状态码会误判成功 |

**实现**：`beike-direct-client.ts`（约 520 行）
- 完整的 MCP 协议：`initialize` → `notifications/initialized` → `tools/call`
- 必需的请求头：`Authorization`、`X-Beike-Cli-Version`、`Mcp-Session-Id`（若下发）
- SSE 响应解析（`event: message` + `data: {...}`）
- **正确识别 `result.isError`**（不看 HTTP 状态码）
- 归一化成 CLI 信封格式 → **复用同一个响应解析器**，上层零改动

**传输模式**（`BEIKE_TRANSPORT` 环境变量）：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 直连优先；**服务不可用时直接降级**，其它错误才回退 CLI |
| `http` | 只用直连（问题暴露，不掩盖） |
| `cli` | 只用 CLI（保留，便于对比排查） |

### 2.3 修复 3：熔断与降级路径优化

**问题**：诊断发现服务故障时是**确定性失败**（~220ms 就返回确定答案），
而原实现要重试 5 次 + 指数退避 ≈ 25 秒，纯属浪费。

**修复**：
1. 直连识别到 `service temporarily unavailable` → **立即打开熔断**（120 秒）
2. 熔断期间**直接快速失败**，不发起任何请求
3. 直连已判定服务不可用时，**跳过 CLI 回退**（再试一遍不会有不同结果）

**效果**：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 首次搜索 | 5835ms | **702ms** |
| 熔断期间 | 5835ms | **0ms** |
| **完整闭环** | **69700ms** | **1042ms** |

### 2.4 修复 4：错误信息质量

**修复前**：
```
搜索房源 直连与 CLI 均失败。直连：贝壳 MCP 错误（-32602）：Invalid request parameters；
CLI：贝壳服务返回错误：service temporarily unavailable
```
→ 真正的错误（-32602 是我的 bug）被淹没在噪音里。

**修复后**：
```
贝壳服务返回错误：service temporarily unavailable
```
→ 直连把服务端原始错误透出，一眼看出是服务侧问题。

---

## 三、代码变更

### 3.1 新增文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `apps/api/src/modules/property/providers/beike/beike-direct-client.ts` | ~520 | 直连 HTTP MCP 客户端 |

### 3.2 修改文件（1 个）

| 文件 | 改动 |
|---|---|
| `beike-mcp-client.ts` | 加传输模式开关；各业务方法改走 `dispatch()`（直连优先 + 可控回退）；诊断优先走直连；熔断与降级优化 |

**关键设计**：`dispatch()` 保持所有公开方法签名不变，
因此**上层业务代码零改动**（编排器、Provider、控制器都不受影响）。

### 3.3 诊断脚本（全部独立实现，不经过业务代码）

| 脚本 | 用途 |
|---|---|
| `test-beike-connection.ts` | 最小连通性测试（任务要求） |
| `test-beike-tools.ts` | tools/list 诊断（发现版本头问题） |
| `test-beike-headers.ts` | 对照实验证明版本头是必需项 |
| `diagnose-cli-env.ts` | CLI 环境变量对照实验 |
| `test-beike-direct.ts` | 直连调用 house_search |
| `test-beike-all-tools.ts` | 18 个工具逐个可用性测试 |
| `diagnose-mcp-session.ts` | MCP 会话流程诊断（发现服务端无状态） |
| `diagnose-direct-client.ts` | **定位 -32602 的关键脚本** |
| `verify-beike-transport.ts` | 传输层验证（10 项断言） |

---

## 四、验证结果

### 4.1 传输层验证（10/10 通过）

```
【1】默认模式（auto）           ✓ isConfigured / CLI 存在 / 凭证掩码正确
【2】诊断                       ✓ 走直连，发现 18 个工具
【3】数据调用                   ✓ 错误清晰，未把"服务不可用"说成"没有房源"
【4】熔断验证                   ✓ 第二次 0ms（第一次 232ms）
【5】CLI 模式对比               ✓ CLI 未被破坏；直连快 22 倍
```

### 4.2 全仓回归（零破坏）

| 验证 | 结果 |
|---|---|
| 全仓类型检查（6 个包） | ✅ 全绿 |
| `verify-phase12.ts` | ✅ 36 项 |
| `verify-provider-layer.ts` | ✅ 33 项 |
| `verify-aggregator.ts` | ✅ 34 项 |
| `verify-dedup.ts` | ✅ 27 项 |
| `verify-budget-merge.ts` | ✅ 5 项 |
| `debug-tags.ts` | ✅ 4 项 |

### 4.3 端到端闭环（生产日志）

```
[BeikeMcpClient] 贝壳客户端已就绪（传输=auto，直连 HTTP 已启用）
[BeikeDirectClient] 贝壳 MCP 握手成功：布丁MCP服务 v3.4.7
[BeikeDirectClient] 贝壳数据服务不可用（确定性失败），直连熔断 120 秒
[BeikeMcpClient] 搜索房源 直连判定服务不可用，跳过 CLI 回退（直接降级）
[CachedPropertySearchService] 本地缓存检索完成：匹配 41 套
[HardFilterService] 硬性过滤完成：30 套候选 → 通过 30 套
[MatchScoringService] 匹配打分完成：30 套房源，最高 85.5 分
[Orchestrator] 闭环完成：候选 30 → 硬筛 30 → 推荐 3 套 | 耗时 1042ms
```

**HTTP 200 | 1.1 秒 | 3 套真实房源推荐**

---

## 五、当前状态与后续

### 5.1 现在能做什么

| 能力 | 状态 |
|---|---|
| 贝壳 API 调用链路 | ✅ **正确且高效**（直连 232ms，18 个工具可见） |
| 服务恢复后能否自动工作 | ✅ **能** —— 熔断 120 秒后会自动重试，成功即解除熔断 |
| 当前能否拿到实时数据 | ❌ 不能（服务端故障） |
| 当前能否拿到真实房源 | ✅ **能** —— 41 套真实贝壳房源（本地已同步） |
| 闭环能否跑通 | ✅ **能** —— 1.1 秒完成 |

### 5.2 服务恢复后如何验证

```powershell
cd D:\Projects\EstatePilot-AI\apps\api
$env:BEIKE_MCP_API_KEY = '<KEY>'

# 一条命令确认端到端可用
node --experimental-strip-types --no-warnings scripts/verify-beike-transport.ts
```

若输出 `✓ 数据调用成功`，说明贝壳已恢复，项目可正常搜索实时房源。

### 5.3 建议向贝壳反馈

反馈内容（**Key 与协议均正确，是数据服务整体不可用**）：

> 通过 MCP 协议（`https://building.ke.com/mcp`）调用：
> - `initialize` 成功（布丁MCP服务 v3.4.7）
> - `tools/list` 成功，返回 18 个工具
> - **但全部 16 个数据查询工具的 `tools/call` 都返回**：
>   `{"result":{"content":[{"type":"text","text":"service temporarily unavailable"}],"isError":true}}`
>
> 已验证：
> - 携带 `X-Beike-Cli-Version: 0.2.26`（最新版）
> - 携带正确的 `Authorization: Bearer <KEY>`
> - 换伪造 Key 返回的是鉴权错误（说明真 Key 已通过鉴权）
> - 连续 3 次、间隔 1.5 秒，结果稳定一致
>
> 结论：凭证与协议正确，**数据层服务不可用**，请协助排查。

---

## 六、经验记录（避免重蹈）

| # | 教训 |
|---|---|
| 1 | **CLI 会把所有服务端错误压成 `service temporarily unavailable`** —— 排查任何贝壳问题，先用直连 HTTP 看原始错误，不要相信 CLI 的错误信息 |
| 2 | **JSON-RPC 通知不能带 id** —— 会被判 -32602，而且错误信息完全指不到原因 |
| 3 | **`tools/call` 失败时 HTTP 仍是 200** —— 必须看 `result.isError`，不能看状态码 |
| 4 | **`X-Beike-Cli-Version` 是必需头** —— 不带会被判"未检测到 CLI 版本"（措辞误导，实际与版本号无关） |
| 5 | **服务端无状态** —— 实测不下发 `mcp-session-id`，但代码保留了会话支持（协议要求） |
| 6 | **确定性失败不要重试** —— 220ms 就给确定答案的失败，退避 25 秒纯属浪费 |
| 7 | **做对照实验** —— 定位 -32602 时，三组变体对照是唯一有效的办法 |
