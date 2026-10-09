# 贝壳调用链路诊断报告

> 纯诊断，未修改任何业务代码
> 日期：2026-10-09

---

## 一、完整调用链路

### 1.0 总览：实际有两条路径，只有一条是产品的

| 路径 | 谁在用 | 状态 |
|---|---|---|
| **A. 微信闭环** | 前端唯一真实使用 | ✅ 产品主链路 |
| B. `/beike/*` HTTP 路由 | **无人调用**（前端零引用） | 调试/客户端工具 |

前端**没有**任何地方调用 `/beike/*` —— 已全量扫描确认。

---

### 1.1 路径 A：微信消息闭环（唯一真实路径）

```
浏览器（客户详情页）
  │
  │  POST /api/v1/customers/:customerId/wechat-assistant
  │  Header: Authorization: Bearer <我方 JWT>
  │  Body:   { message: "客户微信原文", recommendationCount, replyStyle }
  ▼
WeChatAssistantController.analyze()
  │  文件: apps/api/src/modules/requirement/wechat-assistant.controller.ts
  ▼
WeChatPropertyAssistantOrchestrator.run()
  │  文件: apps/api/src/modules/requirement/wechat-assistant.orchestrator.ts
  │  职责: 14 阶段编排（需求理解→搜索→硬筛→打分→文案）
  │
  │  ⚠️ 注意：这里**直接注入 BeikeMcpClient**，未经过 Provider 抽象层
  │     （多源 Provider 层已实现，但编排器尚未接入）
  ▼
BeikeMcpClient.searchHouses()
  │  文件: apps/api/src/modules/property/providers/beike/beike-mcp-client.ts
  │  行号: 431
  │  职责: 构造 args、spawn CLI、重试、熔断、解析 apiError
  ▼
BeikeMcpClient.spawnCli()   ← 真正发起子进程调用
  │  行号: 385
  │  execFile(cliPath, args, { env })
  ▼
beike.exe（Rust CLI，官方二进制）
  │  路径: infrastructure/beike/bin/beike.exe  (v0.2.26)
  ▼
https://building.ke.com/mcp   ← JSON-RPC 2.0 over MCP (SSE 响应)
```

**关键代码位置**：

| 步骤 | 文件 | 函数 | 行号 |
|---|---|---|---|
| 1. HTTP 入口 | `wechat-assistant.controller.ts` | `analyze()` | — |
| 2. 编排 | `wechat-assistant.orchestrator.ts` | `run()` | — |
| 3. 搜索调用 | 同上 | `attemptSearch()` | 529 |
| 4. CLI 客户端 | `beike-mcp-client.ts` | `searchHouses()` | 431 |
| 5. 重试 + 熔断 | 同上 | `invoke()` | 234 |
| 6. 单次调用 | 同上 | `invokeOnce()` | 333 |
| 7. 启动进程 | 同上 | `spawnCli()` | 385 |
| 8. 响应解析 | `beike-response-parser.ts` | `parse()` / `mapEntity()` | — |

---

### 1.2 路径 B：`/beike/*` HTTP 路由（无人调用）

```
BeikeController
  文件: apps/api/src/modules/property/beike.controller.ts
  前缀: @Controller('beike')  →  /api/v1/beike/*
```

| 路由 | 方法 | 内部调用 |
|---|---|---|
| `GET  /beike/status` | `status()` | `BeikePropertyProvider.describeAvailability()` + 可选 `searchHouses()` 真实探测 |
| `POST /beike/diagnose` | `diagnose()` | `BeikePropertyProvider.diagnose()` → `BeikeMcpClient.diagnose()` |
| `POST /beike/search` | `search()` | `BeikePropertyProvider.searchForCustomer()` |
| `POST /beike/search-by-requirement` | `searchByRequirement()` | 同上 |
| `POST /beike/detail` | `detail()` | `BeikePropertyProvider.fetchPropertiesDetail()` |

---

### 1.3 环境变量（完整清单）

| 变量名 | 用途 | 默认值 | 读取位置 |
|---|---|---|---|
| **`BEIKE_MCP_API_KEY`** | **凭证（必需）** | 无 | `beike-mcp-client.ts:198` |
| `BEIKE_CLI_PATH` | CLI 二进制路径 | `infrastructure/beike/bin/beike.exe` | `beike-mcp-client.ts:184` |
| `BEIKE_MCP_BASE_URL` | API 地址（**仅用于展示，CLI 内部硬编码**） | `https://building.ke.com/mcp` | `beike-mcp-client.ts:233` |
| `BEIKE_NO_CONFIG_WRITE` | 由本方注入，阻止 CLI 写用户目录 | `'1'` | `beike-mcp-client.ts:402` |

**CLI 自身认识的环境变量**（从二进制提取）：

| 变量 | 用途 |
|---|---|
| `BEIKE_MCP_API_KEY` | 凭证 |
| `BEIKE_MCP_BASE_URL` | API 地址 |
| `BEIKE_SOURCE` | 来源标识（`login` 时携带） |
| `BEIKE_SESSION_ID` | 会话标识（归因用） |
| `BEIKE_RAW_QUERY` | 原始查询（归因用） |
| `BEIKE_SKIP_UPDATE_CHECK` | 跳过版本自检 |
| `BEIKE_UPDATE_MANIFEST_URL` | 更新清单地址 |
| `BEIKE_INSTALL_URL` | 安装地址 |
| `BEIKE_SOH` | 内部标识 |
| `WORKBUDDY_SESSION_ID` | 平台会话（说明支持 WorkBuddy 宿主） |

---

### 1.4 Header 与 Endpoint（实测确认）

| 项 | 值 | 来源 |
|---|---|---|
| **Endpoint** | `https://building.ke.com/mcp` | CLI 二进制常量 |
| **协议** | JSON-RPC 2.0 over MCP，响应为 SSE | 实测 |
| **`Authorization`** | `Bearer <BEIKE_MCP_API_KEY>` | CLI 二进制 + 实测 |
| **`Content-Type`** | `application/json` | 实测 |
| **`Accept`** | `application/json, text/event-stream` | 实测 |
| **`X-Beike-Cli-Version`** | **必须提供**，否则被拒（见第二节） | CLI 二进制 + 实测 |
| `User-Agent` | CLI 会发送（值未知） | CLI 二进制含 `user-agent` |
| Server 响应头 | `Server: Lianjia` | 实测 |

**MCP 调用序列**（协议要求）：

```
1. POST initialize            → 返回 serverInfo（布丁MCP服务 v3.4.7）
2. POST notifications/initialized  → 通知（无响应）
3. POST tools/list            → 返回工具清单
4. POST tools/call            → 调用具体工具
```

---

### 1.5 凭证注入方式（安全设计，已确认）

```js
// beike-mcp-client.ts:392-403
execFile(this.cliPath, args, {
  env: {
    ...process.env,
    BEIKE_MCP_API_KEY: this.apiKey,      // ← 通过 env 注入
    BEIKE_NO_CONFIG_WRITE: '1',
  },
})
```

**为什么用 env 而不是命令行参数**：命令行参数在 Windows 上对外可见
（进程列表 / 审计日志），Key 会泄露。代码注释明确写了这一点。

---

## 二、诊断结论

### 2.1 Key 是有效的 —— 已证明

直连 HTTP 实测：

```
POST https://building.ke.com/mcp
Authorization: Bearer qKnbuo****7xaM
Content-Type: application/json

→ HTTP 200 | 259ms | Server: Lianjia
→ {"jsonrpc":"2.0","id":1,"result":{
     "serverInfo":{"name":"布丁MCP服务","version":"3.4.7"},
     "protocolVersion":"2024-11-05", ...}}
```

**MCP 握手成功**，服务端声明自己是「布丁MCP服务 v3.4.7」。

### 2.2 发现一个真实的协议要求：`X-Beike-Cli-Version`

**对照实验（同一个 Key、同一个 Endpoint，只差一个 Header）**：

| 实验 | `X-Beike-Cli-Version` | 结果 |
|---|---|---|
| 1 | ❌ 不带 | `{"code":-32001,"message":"未检测到 CLI 版本，视为版本过低","data":{"code":"CLI_UPGRADE_REQUIRED"}}` |
| 2 | ✅ `0.2.26` | **成功返回 18 个工具** |
| 3 | ✅ `0.2.26` + User-Agent | 成功返回 18 个工具 |

**18 个工具清单**：
```
house_search          newhouse_search       resblock_search
plate_search          rent_house_search     policy_search
decorate_search       house_rank_search     resblock_rank_search
agent_search          store_search          entity_resolution
entity_detail         entity_material       wecom_add_contact_qrcode
decor_store_search    decor_price_query     report_user_intent
```

### 2.3 CLI 路径 vs 直连路径的差异

| 路径 | 版本检查 | 数据调用 |
|---|---|---|
| **直连 HTTP（不带版本头）** | ❌ 被拒 | — |
| **直连 HTTP（带版本头）** | ✅ 通过 | 待测（见子任务） |
| **CLI（4 种环境变量组合）** | ✅ 全部通过 | ❌ 全部返回 `service temporarily unavailable` |

**重要**：CLI 在**所有**环境变量组合下都通过了版本检查
（返回的是"服务不可用"，不是版本拒绝）。

因此 `X-Beike-Cli-Version` 问题**只影响裸 HTTP 调用**，
不是 CLI 失败的原因。

### 2.4 CLI 已是最新版

```
官方 manifest latest: 0.2.26
本地 beike --version: 0.2.26
```

**本地已是最新版本**，所以"升级 CLI"这个建议在当前情况下**无法解决问题**。

### 2.5 逐项排查表（按您要求的顺序）

| 排查项 | 结论 | 证据 |
|---|---|---|
| **Key** | ✅ **正常** | 握手成功；doctor 报"Key 有效、18 个工具" |
| **Environment** | ✅ **正常** | CLI 存在、Key 注入正确、4 种环境组合行为一致 |
| **Endpoint** | ✅ **正确** | `https://building.ke.com/mcp`，Server 响应 `Lianjia` |
| **Authorization** | ✅ **正确** | HTTP 200（若 Key 错会是 401/403） |
| **CLI** | ⚠️ **可用但行为可疑** | 所有组合都通过版本检查，但数据调用全部失败；**该构建不发送 `X-Beike-Cli-Version` 头**（从二进制含该字符串但实测被服务端判为"未检测到"） |
| **Network** | ✅ **正常** | 延迟 199~277ms，无 DNS/代理错误 |

### 2.6 当前判定

```
Key 有效 + Endpoint 正确 + 网络正常 + CLI 通过版本检查
   ↓
但数据工具返回 service temporarily unavailable
   ↓
两种可能：
  A. 服务端数据平面确实故障（我方无法修复）
  B. CLI 走的调用方式与服务端期望不符（可绕过 CLI 修复）
```

**区分 A 与 B 的方法**：用带 `X-Beike-Cli-Version` 头的**直连 HTTP**
调用 `tools/call`。若直连能拿到数据 → 是 B（可修复）；若同样失败 → 是 A。

→ 该验证正在执行（`test-beike-all-tools.ts`）。

---

## 三、诊断脚本清单

| 脚本 | 用途 | 是否经过业务代码 |
|---|---|---|
| `test-beike-connection.ts` | **最小连通性测试**（任务要求） | ❌ 完全不经过 |
| `test-beike-tools.ts` | `tools/list` 诊断（发现版本头问题） | ❌ |
| `test-beike-headers.ts` | 对照实验证明版本头是必需项 | ❌ |
| `diagnose-cli-env.ts` | CLI 环境变量对照实验 | ❌ 独立实现 execFile |
| `test-beike-all-tools.ts` | 逐工具可用性测试 | ❌ |

**全部脚本都不经过 AI / Matching / Property / Database**，
各自独立实现 `execFile` 与 `fetch`，与业务代码零耦合。

### 运行方式

```powershell
cd D:\Projects\EstatePilot-AI\apps\api
$env:BEIKE_MCP_API_KEY = '<你的 Key>'

# 1. 最小连通性（推荐先跑这个）
node --experimental-strip-types --no-warnings scripts/test-beike-connection.ts

# 2. 逐工具可用性
node --experimental-strip-types --no-warnings scripts/test-beike-all-tools.ts

# 3. 只看 HTTP，不跑 CLI
node --experimental-strip-types --no-warnings scripts/test-beike-connection.ts -- --http-only
```

---

## 四、待验证（正在进行）

- [ ] 用带版本头的直连 HTTP 逐个调用 18 个工具
- [ ] 区分「服务端故障」与「CLI 调用方式不符」
- [ ] 若发现可用工具，评估能否替代当前使用的 `house_search`

---

## 五、可执行的后续动作（视验证结果而定）

| 验证结果 | 建议动作 |
|---|---|
| 直连能拿到数据 | 在 `spawnCli` 或调用层补发 `X-Beike-Cli-Version` 头；或改用直连 HTTP 替代 CLI |
| 直连也失败 | 服务端故障，等待恢复；系统已有降级（本地真实房源） |
| 部分工具可用 | 把不可用的工具从业务链路中剔除，改用可用工具 |
