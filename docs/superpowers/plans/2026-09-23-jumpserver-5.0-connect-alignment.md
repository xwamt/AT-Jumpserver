# JumpServer 5.0 连接方式对齐实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用官方 Luna 客户端与服务端源码验证过的事实（服务端 `connect-methods` 是权威连法清单；KoKo 5.0 的 WS 认证是三段式 cookie→Bearer→ticket）把本插件的连接链路对齐到 JumpServer 5.0，同时**不破坏 v3 / v4 老部署**。

**Architecture:** 严格二分。

- **A 组（现有实现优化）**：所有端点都在 **v3.10.23 已存在**，可以改现有代码路径，只需要保留失败兜底。
- **B 组（仅 5.0 新增）**：`/koko/api/connect-ticket/` 与「WS 握手接受 Bearer/ticket」**只在 5.0 有**，必须做成**能力探测 + 失败静默降级**，绝不能替换现有 cookie 链路。

**Tech Stack:** TypeScript / Vitest / 原生 `ws` ∥ 既有 `JumpServerClient` + `createJumpServerFetch`。

**Spec / 前序研究:** `docs/research/jumpserver-5.0-luna-vs-at-plugin.md`（核验版 v2）+ 本计划 §0。**两者冲突时以本计划 §0（源码实测）为准。**

**TDD:** 每个节点先写失败测试 → 看 RED → 实现 → 看 GREEN。**不得**在未跑通测试的情况下把节点标记完成。

**Branch:** 新建 `feat/jumpserver-5.0-connect-alignment`，A 组与 B 组分两个 commit 批次（A 先 B 后，见 §2）。

**禁止事项（硬约束）:** luna 是 **GPL-3.0-or-later**，只借鉴协议与分层，**不得抄代码**；不得硬编码 `connect-methods` 的 `value` 枚举；不得为对齐官方删掉本插件已有的应用层心跳。

---

## 修订记录

**v2（本次，按产品决策收窄范围）**

| # | 变更 | 原因 |
| - | ---- | ---- |
| 1 | **A4（`client-url` / 本机外部客户端）整节删除**，`client-url`、`rdp-file`、`exchange` 在 §1 标为「不采用」 | 产品是 VS Code 插件，连接能力只依赖自身内嵌终端，不引入第三方终端依赖 |
| 2 | **A3 重写**：范围从「消掉两次开会话」收紧为「SFTP **保持懒加载**，仅复用终端的 connection-token」 | 原表述与插件有意的懒加载设计冲突；且经服务端源码核实，协议支持的「复用」是 token 复用，不是复用 WS 通道 |
| 3 | **B3 去掉深链一半**，只留会话模型（并降级为可选） | `jms://` / `jms2://` 的消费方是 Luna 桌面端，与本插件定位冲突（随 A4 一并去除） |
| 4 | **新增 §B.4「B 组回归审查」**，并据此修正 B0 / B1 的改动点与判据 | B1 原改动点清单不全（`ensureWebSession` 有 3 个调用点），原验收判据不可达；另有一处测试基座会被 B1 必然翻转 |

---

## 0. 依据：重读官方更新说明后的结论

### 0.1 服务端 v5.0.0（2026-09-17 发布）

GitHub Release 原文要点：

> "JumpServer v5.0 introduces a refreshed native client with a unified entry point for SSH, RDP, Kubernetes, database, and RemoteApp assets, alongside **split views**, a **file workspace**, a **script library**, and **SFTP Server connections**. New AI-assisted features include command recommendations, real-time operation risk alerts, and automated audit reports... The updated **KoKo TUI** makes it easier to find assets, choose accounts and protocols, and switch between sessions from an SSH terminal."

官网发布说明《跨越新高度：JumpServer V5 来了！》两大主题为「全面升级的原生客户端使用体验」与「内置更多 AI 能力」。

**必须如实记录的三点：**

1. **发布说明里没有「放弃兼容旧版本」这句话。** 该表述不成立，不能作为设计前提。
2. **服务端并没有删旧端点。** v5.0.0 仍保留 `connect-methods` / `client-url` / `rdp-file` / `reuse` / `exchange`；`/api/v1/settings/client/versions/` 仍返回 `['4.0.0','4.1.0','4.1.1','4.1.2','5.0.0']`，即**仍把 4.x 客户端列为受支持**。真正硬拦截发生在**客户端侧**：Luna 登录前强制版本预检，4.x 服务端清单里没有 `5.0.0` → 直接拦截。
3. **发布说明里的「SFTP Server connections」不是新接口。** 源码核实为 Luna 的**客户端 UI 能力**——在文件工作台里再连一个远端 SFTP 以做双向传输（i18n 键 `RemoteSftpHint`: "Connect another SFTP server to transfer files between both sides"，实现于 `ui/koko/components/FileManagement/workspace/SftpGlobalWorkspace.vue`）。它复用同一个 `/koko/ws/sftp/` + connection-token，**没有新增服务端 API**。因此本计划不把它列为接口节点。

### 0.2 客户端 Luna（`github.com/jumpserver/luna`，`jumpserver-web` 5.0.0，**GPL-3.0-or-later**）

`README_CN.md` 原文要点：

| 原文主张 | 对插件的事实意义 |
| -------- | ---------------- |
| 「终端、文件管理、数据库、远程桌面和 Kubernetes 连接都在同一个工作区中打开，可以通过标签页切换会话」 | 会话模型是 session/tab 挂多 surface；插件当前是 asset+kind 单会话（B3 的动机，非接口） |
| 支持协议：SSH / Telnet / SFTP / **MySQL / PostgreSQL / Redis / MongoDB / Oracle / SQL Server / ClickHouse / MariaDB / 达梦 / DB2** / RDP / VNC / RemoteApp / K8s / Web 资产 | 插件当前只认 SSH / MySQL / Redis ⇒ A1 的直接收益 |
| 「浏览器可通过 `jms2://` 链接唤起客户端……**旧版客户端使用的 `jms://` 协议保持独立**」 | `jms://` 与 `jms2://` 是**并存的两套 scheme**；本插件不消费、也不生成深链（见 §4） |
| 「可用的资产和连接方式**由 JumpServer 服务端配置及用户授权决定**」 | 官方自己也把「连法」交给服务端 ⇒ A1 是唯一正确做法 |
| 桌面端「支持本地 Shell、调用外部终端或数据库客户端」 | **本插件不做**（见 §4） |

### 0.3 本次重读对前序研究文档的两处修正

| # | 前序 doc（v2）的说法 | 源码事实（本次重读） |
| - | ------------------- | ------------------- |
| 1 | §5 版本归属表把 `POST .../connection-token/?create_ticket=1` 与 KoKo 的 connect-ticket 混在一行，暗示二者相关 | **无关。** `create_ticket` 是 `_validate_acl` 里 **ACL `review` 审批分支**的开关（v3.10.23 `connection_token.py:440`、v5.0.0 `:982`），语义是「命中审批 ACL 时不报错、改为自动创建登录审批工单」。它与 KoKo 的 connect-ticket **不是同一个东西**，本计划不采用它。 |
| 2 | §7 A2 只列了 `@USER/@INPUT/@ANON` 三种别名账号 | 服务端 `AliasAccount` 共 **5 个**值：`@ALL` / `@INPUT` / `@USER` / `@ANON` / `@SPEC`（`apps/accounts/const/account.py:14-19`，v3.10.23 与 v5.0.0 **完全一致**）。计划按 5 值处理。 |

---

## 1. 接口版本归属总表（决定每个节点能不能改现有实现）

**判定方法：** 对 `v3.10.23`（v3 LTS 最新）与 `v5.0.0` 同时定位路由与实现；两者都有 ⇒ A 组；仅 v5.0.0 有 ⇒ B 组。

| 接口 / 能力 | 证据位置 | v3.10.23 | v4.10.19 | v5.0.0 | 归属 |
| ---------- | ------- | -------- | -------- | ------ | ---- |
| `GET /api/v1/terminal/components/connect-methods/` | 路由 `terminal/urls/api_urls.py:56`(v3) / `:57`(v5) | ✅ | ✅ | ✅ | **A**（API 文件 `diff -q` 逐字节相同） |
| `POST /api/v1/authentication/connection-token/` | `authentication/api/connection_token.py` | ✅ | ✅ | ✅ | **A** |
| `PATCH .../connection-token/{id}/reuse/` | v3 `:263`、v5 `:557` | ✅ | ✅ | ✅ | **A**（受全局开关约束；**A3 的核心**） |
| 别名账号 `@ALL/@INPUT/@USER/@ANON/@SPEC` | `accounts/const/account.py:14-19` | ✅ | ✅ | ✅ | **A** |
| **KoKo 沿用调用方传入的 `?token=`（不再新建 token）** | koko v3 `srvconn/sftp_asset.go:591-593`；v5 `:1096-1099` + `:1030-1032` 注释 | ✅ | ✅ | ✅ | **A**（A3 成立的服务端依据） |
| token 取用时被消费（除非 reusable） | v3 `connection_token.py:524-535`；v5 `:1289-1300` | ✅ | ✅ | ✅ | **A**（A3 的前置条件） |
| `GET /api/v1/settings/client/versions/` | `settings/api/settings.py` | ❌ 404 | ✅ | ✅ | 可作 **v4+ 能力探针**（B0 采用） |
| `POST {koko}/koko/api/connect-ticket/` | v5 `pkg/httpd/webrouter.go:49-52`；v3/v4 **无 `/koko/api/` 路由组** | ❌ | ❌ | ✅ | **🔴 B（仅 5.0）** |
| WS 握手接受 `Authorization: Bearer` / `?ticket=` | v5 `pkg/auth/http.go:21-93`（**122 行**）；v3.10.23 与 v4.10.19 均 **47 行，仅 cookie** | ❌ | ❌ | ✅ | **🔴 B（仅 5.0）** |
| `POST .../connection-token/{id}/client-url/` | v3 `:242`、v5 `:536` | ✅ | ✅ | ✅ | **不采用**（A4 已删除，见 §4） |
| `GET/POST .../connection-token/{id}/rdp-file/` | v3 `:227`、v5 `:517` | ✅ | ✅ | ✅ | **不采用**（同上） |
| `POST .../connection-token/exchange/` | v3 `:275`、v5 `:569` | ✅ | ✅ | ✅ | **不采用**（非本计划必须） |
| `client-url` 返回 scheme（`jms://` vs `jms2://`） | v3 `:253` vs v5 `:547` | `jms://` | `jms://` | `jms2://` | **不采用**（深链随 A4 一并去除） |

> 标记「不采用」的三行**属实存在**（含 v3），列出仅为版本归属记录：本插件不把凭据交回操作系统、不生成深链，故不实现。

**`connect-methods` 的内容差异（API 契约不变，仅数据层新增）** —— 来自 `apps/terminal/connect_methods.py` 的 `diff`：

```
+ WebMethod.web_proxy            'Built-in Browser'（新增，绑 Protocol.http）
+ NativeClient.vnc_client / vnc_guide + TerminalType.nec（新增）
+ chen.support   += clickhouse
+ magnus.support += mongodb
+ koko.support   += http, oracle
~ xpack_methods: [mstsc] → [mstsc, db_client, vnc_guide]
~ mongodb/oracle native clients 改为 settings.VENDOR.lower()=='jumpserver' 时才加
~ get_user_allowed_connect_methods: 旧版只有 reject 禁用；
  5.0 改为 accept 放行 − reject 禁用（双向）
~ _filter_disable_components: 追加 and settings.XPACK_LICENSE_IS_VALID
```

> ⇒ **必须以 `value` 动态处理，不得硬编码枚举**：同一份插件代码会在 4.x 下拿到旧集合、5.0 下拿到含 `web_proxy` / `vnc_client` / `vnc_guide` 的集合。

**已知上游瑕疵（只记录，不在插件侧规避）：** `ConnectMethodUtil.get_protocols_connect_methods` 的读缓存写成 `cls._all_methods.get('os')`（字面量 key），写入却是 `cls._all_methods[os] = methods` ⇒ 缓存**实际几乎不命中**。仅影响服务端性能，不影响正确性。

**不能用作版本探针的接口：** `GET /koko/health/` 三个版本都有（`webrouter.go:66`），但只返回 `{"timestamp","uptime"}`（`pkg/httpd/webserver.go:281-287`），**不含版本号** ⇒ 无法区分 3.x/4.x/5.0。

### 接口契约（已核验，实现时照抄，勿自行发挥）

**① connect-methods**

```http
GET /api/v1/terminal/components/connect-methods/            # 默认：按当前用户 ConnectMethodACL 过滤
GET /api/v1/terminal/components/connect-methods/?flat=1      # 全量协议、按 value 去重，返回 list
Authorization: Bearer <access_token>
X-JMS-ORG: <orgId>            # 多组织时有意义
# 权限：IsValidUser
# os 参数：?os=windows|linux|macos；缺省时服务端用 get_request_os(request) 从 User-Agent 推断

# 默认返回（dict）：
{
  "ssh":   [ { "component":"koko","type":"web","endpoint_protocol":"http","value":"web_cli","label":"Web CLI" }, ... ],
  "mysql": [ { "component":"chen","type":"web","endpoint_protocol":"http","value":"web_gui","label":"Web GUI" }, ... ]
}
# flat=1 返回：去重后的 method 列表（不是 dict）
# method 字段：component / type('web'|'native'|'applet'|'virtual_app') / endpoint_protocol / value / label
#   applet 额外: icon / disabled；virtual_app 额外: disabled；二者会被补 'listen'
# 注意：响应体没有 originals 字段（服务端直接 Response(queryset)）
```

**sftp 协议的合法 `connect_method` 值**（`apps/terminal/connect_methods.py:23,50`）：

```
web:    web_sftp      （WebMethod.get_spec_methods → Protocol.sftp: [web_sftp]）
native: sftp_client   （NativeClient.get_native_clients → Protocol.sftp: [sftp_client]）
```

**② connection-token 创建**

```http
POST /api/v1/authentication/connection-token/
{ "asset":"<assetId>", "account":"<accountId 或 @USER/@INPUT/@ANON/@ALL/@SPEC>",
  "protocol":"ssh|sftp|mysql|redis|...", "input_username":"", "input_secret":"",
  "connect_method":"web_cli", "connect_options":{...} }
→ 201 { "id":"<tokenId>", ... }
```

`connect_method` 在模型上是**自由 `CharField(max_length=32)`**（`authentication/models/connection_token.py:60`），创建时**不做枚举校验**；只有在 `client-url` / `rdp-file` 路径才会因 `ConnectMethodUtil.get_connect_method()` 返回 `None` 而报 `Connect method not support: <name>`。

**③ reuse（A3 核心契约）**

```http
PATCH /api/v1/authentication/connection-token/{id}/reuse/     { "is_reusable": true }
  → 全局开关 CONNECTION_TOKEN_REUSABLE 默认 false（apps/jumpserver/conf.py:258）
  → 关闭时 400: "Reusable connection token is not allowed, global setting not enabled"（v3 connection_token.py:266-268）
  → RBAC 权限：authentication.reuse_connectiontoken（models/connection_token.py:84-87）
  → v5: 若 token 有 personal_credential_id，set_reusable 强制为 false（models/connection_token.py:128-131）
    v3: **没有**这层保护（models/connection_token.py:84-94）⇒ 插件侧自行判断，个人凭据 token 不申请复用
  → 复用有效期 = CONNECTION_TOKEN_REUSABLE_EXPIRATION；一次性 = CONNECTION_TOKEN_ONETIME_EXPIRATION
```

**「token 是否已被消费」的判定点（决定 A3 能否成立）**

```text
KoKo 取 token：sshcert.GetConnectTokenInfo(apiClient, token, expireNow=true)
  → Core POST /api/v1/authentication/connection-tokens/secret/
     v5 connection_token.py:1289-1300 / v3 :524-535
     if token.is_reusable and settings.CONNECTION_TOKEN_REUSABLE:  # 不过期，可再用
     elif expire_now is False:                                    # API 指定不过期
     else: token.expire()                                         # ← 默认行为：用完即废
```

**④ 仅 5.0：connect-ticket**

```http
POST {kokoBase}/koko/api/connect-ticket/
Authorization: Bearer <access_token>
Content-Type: application/json
X-JMS-ORG: <orgId>
X-TZ: <timezone offset>
Referer: <kokoBase origin>
{ "token_id":"<connection-token id>", "org_id":"<orgId>" }
→ 201 { "ticket":"<uuid>", "token_id":"<id>", "org_id":"<orgId>",
        "expires_at":"<RFC3339 UTC>", "expires_in":<seconds> }
# 中间件：apiGroup.Use(auth.HTTPMiddleSessionAuth(jmsService))
# 实现：webserver.go:289-314；票据 TTL = 30min（pkg/auth/connect_ticket.go:16）
# 消费：WS 用 query ?ticket= 或 header X-Koko-Connect-Ticket；ticket 与 token_id 强绑定，
#       query token 不匹配 → 401 "connect ticket token mismatch"
```

**⑤ 仅 5.0：KoKo WS 认证三段式（`pkg/auth/http.go:21-93`）**

```
① Cookie                          → CheckUserCookie
② Authorization / Date / X-JMS-ORG → CheckUserHeaders（= 原样转发给 Core GET /api/v1/users/profile/）
   ← 有头但无效：401 硬失败，不回落 ③
③ ?ticket= 或 X-Koko-Connect-Ticket → ConnectTickets.Get → 注入 ticket.Headers 后放行
```

> ⚠️ **②的行为是陷阱：带失效 Bearer 比不带更糟**（吃掉了 ③ 的回落）。B2 必须处理。

**⑥ 不存在的能力：把 SFTP 挂到「已连接的终端通道」上**

```text
WS 参数结构 koko v5 pkg/httpd/message.go:151-165（WsRequestParams）:
  type / target_id / token / asset / pod / namespace / container / disableautohash
  ⇒ 没有任何 session / 会话标识字段，无法指定「复用某条已有会话」

/koko/ws/sftp/ 每次握手都：新建 AssetDir → getNewSftpConn → NewSSHClientWithToken → 自行 SSH dial
  （koko v5 pkg/srvconn/sftp_asset.go:1088-1094、:1121-1138）

进程内会话注册表只服务心跳与运维任务（pkg/session/manager.go:11-36；使用点 pkg/koko/task.go:171,265）
  ⇒ 不用于复用通道
```

> ⇒ A3 只能做「复用 connection-token」，不能做「复用 WS 通道」。详见 A3。

---

## 2. 实施顺序与依赖

```
A1（connect-methods） ──→ A2（账号模式）
A3（token 复用；SFTP 保持懒加载） ← 与 A1 无依赖，但建议排在 A1 之后（避免同时动建连主流程）
A3 → B1（connect-ticket，探测 + 降级）
A3 → B2（WS Bearer，探测 + 降级；与 B1 共用探测结果）
B3（会话模型：一个资产多 surface；可选、纯本地重构）← 独立，排在最后
```

**批次划分（两个 commit 批次）：**

- 批次 1 = A 组（`feat: align connect methods and account modes with JumpServer 5.0`）
- 批次 2 = B 组（`feat: opt-in KoKo 5.0 cookie-less handshake with capability probe`）

**为什么 A 先 B 后：** A 组改的是「连法怎么选」；B 组改的是「握手怎么认证」。先做 A 能在完全不碰认证的前提下拿到最大功能收益；B 组一旦出问题，回滚面更小。

---

# Part A — 现有实现优化（端点在 v3.10.23 已存在，可改现有代码）

> A 组共同前提：**每个节点都必须保留现有实现作为失败兜底**，不是删除替换。新增失败路径的验收判据见 §3。

### A1. 用 `connect-methods` 取代客户端的协议字符串猜测

**修改原因**

现状 `src/jumpserver/connectionTypes.ts`（100 行）靠 `type/platform/category/protocolNames/name` 做**子串匹配**，只认 `ssh | mysql | redis`，其余一律 `unsupported`（`getAssetConnectionKind` → `connectionTypes.ts:40-51`）。后果：RDP / VNC / K8s / Web / ClickHouse / MariaDB / PostgreSQL / SQL Server / Oracle / MongoDB / 达梦 / DB2 **全部不可用**；且每支持一个新资产类型都要改客户端代码、发版。

**官方客户端怎么做**

`ui/shared/connectors/capabilities.ts` 声明「我能原生渲染什么」，`ui/composables/useConnectMethods.ts` 负责拉取与归一，`ui/composables/useAssetAction.ts` 在建连前取一次 `GET /api/v1/terminal/components/connect-methods/`，按「上次选择 → 偏好 → 原生 → 外部客户端 → 第一个」选 method；**发给服务端前必须把本地注入项换回服务端认识的 `origin_value`**（`useAssetAction.ts:457-489`）。

关键点：官方把「这个资产能用哪些连法」的判定权**完全交给服务端**（含用户 ACL 过滤），客户端只做展示与选择。这正是官方 README 里写的「可用的资产和连接方式由 JumpServer 服务端配置及用户授权决定」。

**接口契约**

见 §1「① connect-methods」。端点 **v3.10.23 已存在且 API 文件与 v5.0.0 逐字节相同**，只读 `os` / `flat` 两个 query。

**改动点**

| 文件 | 改动 |
| ---- | ---- |
| `src/jumpserver/connectMethods.ts`（**新增**） | `ConnectMethod` 类型；`normalizeConnectMethods(payload)` 同时吃 dict 与 list；`selectConnectMethod(methods, { protocol, preferred })` |
| `src/jumpserver/JumpServerClient.ts` | 新增 `getConnectMethods(protocol?)`，30s TTL + in-flight 合并；`openKokoSocket` 前可选校验 |
| `src/jumpserver/connectionTypes.ts` | `getAssetConnectionKind` 改为**只做兜底**：`connect-methods` 请求失败/超时时才回落到现有猜测 |
| `src/jumpserver/JumpServerSession.ts` (`connect()`，99-176) | 在 `getAssetDetail` 之后插入一次 connect-methods（与 token POST 并行）；按选中的 method 决定 `connect_method` 取值 |

要点：

- [ ] **默认（非 `flat`）调用**，让服务端按当前用户 `ConnectMethodACL` 过滤。
- [ ] **按 `value` 动态处理，不硬编码枚举**（5.0 多出 `web_proxy` / `vnc_client` / `vnc_guide`）。
- [ ] 用 `type` + `component` 决定落点：`type=web` ⇒ 内嵌终端/工作区；**`type=native` ⇒ 本插件明确返回 `unsupported` 并给可读原因**（不自研本地客户端，见 §4）；`type=applet|virtual_app` ⇒ 同样明确返回 `unsupported`（不静默）。
- [ ] 顺手修一个既存不一致：`buildSftpConnectionTokenPayload` 现在发 `connect_method: 'sftp'`（`JumpServerClient.ts:484`），而服务端 sftp 的合法值是 `web_sftp`（web）/`sftp_client`（native）（§1「①」）。改为按服务端返回的 method 填写——该字段服务端创建时不校验，但继续写下服务端不认识的枚举值会让后续任何依赖它的路径（含诊断与审计）失真。
- [ ] **Step 1（RED）** `test/jumpserver/connectMethods.test.ts` 新增：dict 与 list 两种响应都能归一；未知 `value` 不抛错；空 payload 返回空集合。
- [ ] **Step 2（RED）** `test/jumpserver/JumpServerClient.test.ts` 新增：两次 `getConnectMethods()` 只发 1 次请求（TTL 合并）；服务端 500 时抛可分类错误。
- [ ] **Step 3（RED）** `test/jumpserver/JumpServerSession.test.ts` 新增：mock 返回 `rdp: [mstsc]` 时 `connect()` 选择的 `connect_method` 为 `mstsc`；mock 返回 `ssh: [web_cli]` 时仍为 `web_cli`。
- [ ] **Step 4（RED）** 新增「connect-methods 500 → 回落到现有字符串猜测且连接仍成功」的回归测试。
- [ ] **Step 5（GREEN）** 实现 `connectMethods.ts` + client/session 接线。
- [ ] **Step 6** `npx vitest run test/jumpserver && npx tsc --noEmit`。

**测试**

- `connect-methods` 归一：dict / list / 空 / 未知 value / `disabled` 字段透传。
- 选择策略：协议精确匹配；同协议多 method 时的确定性顺序（偏好 → web → native → 首个）。
- 失败回落：4xx / 5xx / 超时三条路径都回落到旧逻辑且不抛错。
- 不回归：SSH / MySQL / Redis 三条现有链路的 `connect_method` 取值不变。

**复检**

1. 断言每次建连**最多 1 次** connect-methods 请求（TTL 缓存 + in-flight 合并生效）。
2. 断言插件 UA（`AT-JumpServer/1.0`）下 `os` 判为未知时**不影响结果**——源码依据：开源版 `NativeClient.get_native_clients()` 返回普通 list，`isinstance(_clients, dict)` 分支不生效。**顺带改进**：请求显式带 `?os=`（由 `process.platform` 映射 `win32→windows` / `darwin→macos` / 其余 `linux`），为企业版 per-OS 形态留出正确性。
3. **必须用真实实例或按 §1「①」逐行转录的 mock 验证一次 dict 响应的真实形状**（不能只依赖纯色夹具）。

---

### A2. 支持别名账号模式 `@USER` / `@INPUT` / `@ANON`（+ `@ALL` / `@SPEC`）

**修改原因**

现状 `resolveFirstUsableAccount(detail)`（`JumpServerClient.ts:425-446`）取「第一个 `has_secret === true` 且 alias 不以 `@` 开头」的账号，取不到直接 `throw new Error('No usable JumpServer account was returned for this asset.')`。后果：**别名账号资产在插件里完全连不上**，而服务端从 v3.10.23 起就支持 `@INPUT`（手动输入）、`@USER`（动态同名账号）、`@ANON`（匿名）三种别名账号。

**官方客户端怎么做**

`ui/composables/useConnectionFormState.ts:89-90` 判定手动输入（`account === "@INPUT"` 或本地化标签「手动输入」）；`ui/composables/useAssetAction.ts:287-307` 决定最终喂给 `connection-token` 的 `account` 字段。服务端对应识别逻辑在 `authentication/api/connection_token.py`（`AliasAccount` 分支）。

**接口契约**

```
account 字段可取值（AliasAccount，apps/accounts/const/account.py:14-19，v3.10.23 与 v5.0.0 一致）：
  @USER  → 动态同名账号（用当前登录用户名）
  @INPUT → 手动输入，需同时带 input_username / input_secret
  @ANON  → 匿名账号
  @ALL   → 全部
  @SPEC  → 指定账号
托管账号：直接给 account 的 UUID
```

**改动点**

| 文件 | 改动 |
| ---- | ---- |
| `src/jumpserver/JumpServerClient.ts` (`resolveFirstUsableAccount`，425-446) | 返回 discriminated union：`{kind:'managed', id}` / `{kind:'alias', alias:'@USER' \| '@INPUT' \| '@ANON' \| '@ALL' \| '@SPEC'}`；**不再对 `@` 前缀抛错** |
| `src/jumpserver/JumpServerClient.ts` (`buildConnectionTokenPayload`，449-472 及 3 个分协议函数 474-527) | `account` 按 kind 填 UUID 或别名；`@INPUT` 时填 `input_username` / `input_secret` |
| `src/jumpserver/JumpServerSession.ts` (`connect()`，123) | 别名账号时把选择/输入交给 UI 层，而不是静默取第一个 |

要点：

- [ ] `@INPUT` 的密码走**已有**的 per-bastion SecretStorage 通道，不新增明文落盘。
- [ ] 账号无法唯一确定时**给用户选**，不要猜（现状是猜第一个，这本身就是缺陷）。
- [ ] **Step 1（RED）** `test/jumpserver/JumpServerClient.test.ts`：`permed_accounts = [{alias:'@INPUT', ...}]` 时不再抛错，返回 `{kind:'alias', alias:'@INPUT'}`。
- [ ] **Step 2（RED）** 断言 `@INPUT` 时 payload 含 `account:'@INPUT'` + 非空 `input_username`。
- [ ] **Step 3（RED）** 断言 `@USER` / `@ANON` 时 payload 的 `account` 正确、且**不带** `input_username`。
- [ ] **Step 4（RED）** 断言托管账号（有 UUID）行为与改动前**逐字节一致**（防回归）。
- [ ] **Step 5（GREEN）** 实现 union + payload 分支。
- [ ] **Step 6** 跑测试 + typecheck。

**测试**

- 5 个别名 × payload 正确性；托管账号回归；`permed_accounts` 为空时报可读错误（保留现有行为）。
- UI：`@INPUT` 时弹出输入（宿主侧测试）。

**复检**

1. 对真实实例验证一次 `@INPUT` 建连成功（服务端返回 token 且 KoKo 能登目标机）。
2. 断言别名账号不会写任何明文凭据到 `globalState`（复核 `webSessionStore.ts` 同级的 SecretStorage 用法）。

---

### A3. 复用终端的 connection-token（**SFTP 懒加载不变**）

> **本节已按产品约束重写。** 上一版把本节点写成「消掉『一次点击 = 两次开会话』」，既与插件**有意的懒加载设计**冲突，对成本的描述也不准。以下三条是新的边界：

**① SFTP 必须保持懒加载（产品约束，不可改）**

`JumpServerSftpManager.openAsset`（`:56-66`）只**登记**连接（`session: undefined`），全仓唯一的 `connect()` 调用点在 `ensureSession`（`:247-276`），而它只被 `ensureRoot / listDirectory / refreshDirectory / mkdir / rename / deleteEntry / uploadFile / downloadFile / stat / readFile / writeFile / createFile` 触发 —— 即**用户显式操作文件树/传输**时才建连。**本节点不得在任何路径上把 SFTP 提前到「连接终端」时建立**；连接速度优先。

**② 「复用已连接终端的 WS 通道」在本协议栈里不存在，不能实现**

- WS 参数结构 `WsRequestParams`（koko v5 `pkg/httpd/message.go:151-165`）只有 `type/target_id/token/asset/pod/namespace/container/disableautohash`，**没有任何 session/会话标识**，无法指定复用哪条会话；
- `/koko/ws/sftp/` 每次握手都新建 `AssetDir` 并**自行 SSH dial 目标机**（koko v5 `pkg/srvconn/sftp_asset.go:1088-1094`、`:1121-1138`）；
- 进程内会话注册表只服务心跳与运维任务（`pkg/session/manager.go:11-36`；使用点 `pkg/koko/task.go:171,265`），**不用于复用通道**。

**③ 协议真正支持、且服务端为自己设计的「复用」是 connection-token 复用**

- KoKo 在 SFTP 握手时若拿到 `?token=`，会**直接沿用调用方的 token**，不再新建：`srvconn/sftp_asset.go` v3 `:591-593` / v5 `:1096-1099` 的 `if ad.opts.token != nil { return *ad.opts.token, nil }`；v5 `:1030-1032` 的注释写明 —— “**The WebTerminal SSH protocol token was reused by the web folder**, so we now force the protocol to SFTP.”（即这条路径本来就是为「终端 + 文件管理共用一个 token」设计的）
- **前置条件：token 必须还没被消费。** KoKo 取 token 时带 `expire_now=true`，Core 侧据此 `token.expire()`；**只有 `is_reusable and CONNECTION_TOKEN_REUSABLE` 才跳过**（§1「③」）。所以复用开关就是 `PATCH .../reuse/`。

**收益与代价（如实）**

| | 结论 |
| - | ---- |
| **省下** | 一次 `POST /api/v1/authentication/connection-token/`（含 Core 侧 ACL 校验、token 记录与审计） |
| **不省** | 目标机侧连接 —— SFTP 仍会另起一次 SSH/SFTP 会话（`getNewSftpConn` → `NewSSHClientWithToken` 必然 dial） |
| 用户可见延迟 | 仅 SFTP **首次打开**时少一次 REST 往返；**终端连接速度完全不受影响**（本节点不改终端任何一步） |

> ⇒ 本节点的正确描述是「**消掉第二次授权**」，不是「消掉两次开会话」。文档与日志都不得写成后者。

**接口契约**：见 §1「③ reuse」与「token 消费语义」。

**改动点**

| 文件 | 改动 |
| ---- | ---- |
| `src/jumpserver/JumpServerClient.ts` | 新增 `markTokenReusable(tokenId)`：仅在「全局可用」时调用一次；`400/403` 一律吞掉并回落 `reusable:false`（**绝不抛给用户**） |
| `src/jumpserver/JumpServerSession.ts`（`connect()` `:126-154`） | 建 token 后按需标记可复用；把 token id 通过新增回调（如 `onTokenReady(tokenId, kind)`）交给宿主。**不改变现有建连顺序与并行结构**（token 与 endpoint 仍并行） |
| 宿主装配（`src/extension.ts:80-86`） | 给 SFTP 侧注入「可复用 token 查询」：按 `connectionKey`/asset 查活跃终端会话的 token id；查不到返回 `undefined` |
| `src/sftp/JumpServerSftpSession.ts`（`connect()` `:127-140`） | **步骤顺序不变**（detail → 协议校验 → account → token → endpoint → WS）。只在「建 token」这一步分叉：**查得到 ⇒ 直接用 + 声明复用**；查不到 / 旧服务端 / 复用失败 ⇒ 走今天的 `createConnectionToken` |
| `src/sftp/JumpServerSftpManager.ts` | 只把 `connectionKey` 透传给 `createSession`（`:255`）；**不引入任何 timer 或预连** |

**绝不做的三件事**

- ❌ 不在 `openAsset` / `selectTerminal` / 终端 `connect()` 里触发 SFTP 连接（懒加载是产品设计）。
- ❌ 不为「复用」而在终端连接路径上多发一次请求（宁可 SFTP 侧多一次判断）。
- ❌ 复用失败不得打断连接：任何异常一律回落今日行为。

- [ ] **Step 1（RED）** 新增 `test/jumpserver/reuseToken.test.ts`：全局开关关闭（400）⇒ `connect()` **仍成功**、不抛错、`markTokenReusable` 只调用 1 次。
- [ ] **Step 2（RED）** 开关可用（200）+ 有活跃 terminal token ⇒ SFTP 侧 `createConnectionToken` **调用 0 次**，且 SFTP WS 的 `token=` 等于 terminal 的 token id。
- [ ] **Step 3（RED）** **懒加载不回退**：只调 `openAsset()` 时 SFTP `connect()` **0 次**；调 `listDirectory()` 后才 1 次。（本节点最重要的防回归断言）
- [ ] **Step 4（RED）** 无活跃终端会话 / terminal 已断开 ⇒ 回落自建 token（`createConnectionToken` 1 次）。
- [ ] **Step 5（RED）** token 带 `personal_credential_id` ⇒ **不申请**复用（避免无谓请求，并规避 v3 缺失的个人凭据保护）。
- [ ] **Step 6（GREEN）** 实现。
- [ ] **Step 7** `npx vitest run test/jumpserver test/sftp && npx tsc --noEmit`。

**测试**：开关开/关两态；个人凭据 token；RBAC 不足（403）；无活跃终端；并发建连只标记一次；懒加载不回退。

**复检**

1. 断言「开关关闭 / RBAC 403 / 无活跃终端」三条路径**用户可见结果不变**（连接照样成功）。
2. 断言复用后 SFTP 与 terminal 的 `token.id` 相同（日志只打布尔，不打 token 值）。
3. **在真实实例上验证一次「同一个 token 先 terminal 后 sftp」能否成功握手** —— 这是本节点唯一未在真机验证的前提；若服务端行为与源码不一致，回落路径必须先已生效。
4. 断言「冷启动到终端可用」的耗时**不变**（复用逻辑不在终端路径上）。

---

# Part B — 仅 5.0 新增（必须能力探测 + 降级）

> B 组共同前提：**老服务端连端点都没有**（v3/v4 无 `/koko/api/` 路由组），所以**只能新增，绝不能替换**。官方自己也是这么做的：`ui/lion/hooks/useLionConnectTicket.ts:6-12` 在失败时 `console.warn("[lion] connect ticket unavailable, falling back to cookie authentication")` 并返回空串，由上层走 cookie。
>
> **B 组还必须在落地前后通过 §B.4 的回归审查**（该节是本次新增，专门回答「新增 5.0 能力会不会打坏既有功能」）。

### B0.（前置）统一的版本/能力探测

**修改原因**：B1 与 B2 都要先回答「这台 KoKo 是不是 5.0」。探测必须**便宜、无副作用、可缓存**。

**可用探针（已核验）**

| 探针 | 结论 |
| ---- | ---- |
| `GET /koko/health/` | **不可用作版本探针**：三版本都存在，只返回 `{timestamp, uptime}`，无版本号 |
| `GET /api/v1/settings/client/versions/` | ✅ **推荐**：v3.10.23 = 404，v4.10.19 = `['4.0.0','4.1.0','4.1.1','4.1.2']`，v5.0.0 含 `'5.0.0'`。走 Core 的 Bearer，插件已有该认证 |
| `POST /koko/api/connect-ticket/` 自身 | ✅ 可行：404/405 ⇒ 不支持。但会产生一次「预期失败」的请求，日志需抑制 |

**改动点（含本次新增的缓存纪律）**

| 文件 | 改动 |
| ---- | ---- |
| `src/jumpserver/kokoCapability.ts`（**新增**） | `detectKokoCapabilities(client, bastionKey)`；结果挂在 client 实例上（client 由 `JumpServerClientPool` 每 bastion 一个，见 `JumpServerClientPool.ts`） |
| `src/jumpserver/JumpServerClient.ts` | 探测请求走既有 `restHeaders()`；**不新增认证路径** |

要点：

- [ ] **只在已认证后探测**（Bearer 可用时）；未认证时直接返回 `{cookieLess:false}` 且**不写缓存**。
- [ ] **失败分两类**：明确的 `404` / 清单不含 `5.0.0` ⇒ 缓存「不支持」；`超时 / 5xx / 网络异常` ⇒ **不缓存**（下次重探），避免一次抖动把 5.0 实例永久降级。
- [ ] 探测结果与 org 无关（`settings/client/versions/` 不随 org 变）⇒ `setOrgId` 时**不**需要清它（与 B.4.4 的 ticket 缓存处理相反）。
- [ ] **Step 1（RED）** `test/jumpserver/kokoCapability.test.ts`：`client/versions` 含 `5.0.0` ⇒ `{cookieLess:true}`；404 ⇒ `{cookieLess:false}`；超时 ⇒ `{cookieLess:false}` **且不写缓存**（第二次调用仍会发请求）。
- [ ] **Step 2（RED）** 探测结果按 bastion 缓存，多次建连只探一次；进程内可手动失效。
- [ ] **Step 3（GREEN）** 实现 `detectKokoCapabilities()`。
- [ ] **Step 4** 跑测试 + typecheck。

**复检**：断言「任何探测异常 → 都退回现有 cookie 链路」（不得 fail-open）；断言探测不写任何 cookie/Bearer 到日志。

---

### B1. `connect-ticket`：把 KoKo 的 cookie 依赖整体拆掉

**修改原因**

本插件为了拿 KoKo 的 cookie，另开了一整套 **Django 表单登录**：`GET /core/auth/login/?next=/koko/connect/` → 解析 `csrfmiddlewaretoken` → POST(`auto_login=on`) → 最多追 5 跳重定向 → 只持久化 `sessionid` + `csrftoken`。相关代码分布在 `JumpServerClient.ensureWebSession`（`JumpServerClient.ts:1068-1259`，约 190 行）、`warmupKokoConnectPage`（1035）、`parseCsrfMiddlewareToken`（311）、`isKokoLoginRedirect`（319）、cookie 解析族（158-272）、`src/jumpserver/webSessionStore.ts`。**冷启动要多付 2 次 HTTP（更坏时 +5 跳重定向）**，且身份从「Bearer 一份」退化成「Bearer + 会话 cookie 两份」。

**官方客户端怎么做**

- 桌面端：`electron/src/auth/service.ts:545-578`，用 **Bearer** 换 ticket。
- Web 端：`ui/layouts/default.vue:334-347`，用 **cookie（`credentials:"include"`）+ `X-CSRFToken`** 换 ticket。
- 消费：`ui/lion/hooks/useLionConnectTicket.ts` 拿 ticket → WS URL 带 `?ticket=`；官方刷新阈值 **25 分钟**（`ui/lion/views/ConnectView.vue:149`；服务端 TTL 30 分钟）。

**接口契约**：见 §1「④」。**仅 5.0**：v3.10.23 / v4.10.19 的 `webrouter.go` **没有 `/koko/api/` 路由组**。

**改动点**

| 文件 | 改动 |
| ---- | ---- |
| `src/jumpserver/JumpServerClient.ts` | 新增 `createKokoConnectTicket({tokenId, orgId})`：POST `{kokoBase}/koko/api/connect-ticket/`，带 `Authorization` / `X-JMS-ORG` / `X-TZ` / `Referer` / `Content-Type` |
| `src/jumpserver/JumpServerClient.ts` (`buildKokoWsUrl` 279 / `buildKokoSftpWsUrl` 295) | 支持**可选** `ticket` 参数；不传时 URL 与今天**逐字节相同** |
| `src/jumpserver/JumpServerClient.ts` (`openKokoSocket` 1285-1329) | 按 B0 探测；支持时**优先** ticket 握手，失败回落 `hasWebSessionCookie()` → `warmupKokoConnectPage()` 现有链路。**两条链（terminal / sftp）以 `kind` 显式分流**（见 B.4.1） |
| ⚠️ `src/jumpserver/JumpServerSession.ts:109-111` | **本次新增**：5.0 路径下**不再**发起 fire-and-forget 的 `ensureWebSession()`。否则表单登录照旧发生，「0 次」判据不成立（见 B.4.2） |
| ⚠️ `src/extension.ts:776-778` | **本次新增**：`prefetchAssetDetail` 在 5.0 路径下**不再**预热 `ensureWebSession()`（同上） |
| ticket 生命周期 | 缓存键 = **`(tokenId, kind)`**，25 min 刷新；`setOrgId` 时**清空**（见 B.4.4）；token 变化即失效；刷新定时器必须 `unref()`（不得让扩展宿主因此常驻） |

**⚠️ 探针实测到的三个陷阱（必须写进实现）**

1. **ticket 与 `token_id` 强绑定**：WS 的 `token` query 与 ticket 的 `token_id` 不匹配 → `401 connect ticket token mismatch`。SFTP 与 terminal 的 token 不同时必须**各换各的 ticket**；A3 生效（两处共用同一 token）时也**保持按 `(tokenId, kind)` 各换一张**，不做共票优化。
2. **TTL 是 30 分钟，官方客户端在 25 分钟刷新** —— 不要把这两个数混用；且 ticket 只在**握手**时校验，刷新只对新连接有意义。
3. **`Referer` 必须带**（官方桌面端带 `Referer: <origin>`）；插件现有 WS 头里没有 Referer，换 ticket 的 POST 要补上。

- [ ] **Step 1（RED）** `test/jumpserver/JumpServerClient.test.ts`：mock 201 返回 `{ticket}` → `buildKokoWsUrl` 结果含 `&ticket=<uuid>`；**不传 ticket 时 URL 与改动前逐字节相同**。
- [ ] **Step 2（RED）** mock 404 → **不抛错**，回落到 cookie 链路，且**只发生一次**「预期失败」请求。
- [ ] **Step 3（RED）** 25 分钟边界：同一 `(tokenId, kind)` 在窗口内复用同一 ticket（不重复 POST）；超过窗口重新换票。
- [ ] **Step 4（RED）** 同一 token 下 terminal 与 sftp 各自换票，且断言两票的 `token_id` 与各自 WS 的 `token=` 一致。
- [ ] **Step 5（RED）** 刷新：401（ticket 过期）时清 ticket → 重换 → 重试一次；再失败则回落 cookie。
- [ ] **Step 6（RED）** **`ensureWebSession` 三处调用点全部受 5.0 开关约束**（见 B.4.2）。
- [ ] **Step 7（GREEN）** 实现。
- [ ] **Step 8** 改造 `test/jumpserver/researchKokoAuthPaths.test.ts`（见 B.4.7，**必须做**，否则该文件必然变红）。
- [ ] **Step 9** 跑测试 + typecheck。

**测试**：支持/不支持两态；ticket 过期刷新；token 不匹配 401；并发建连只换一次票；cookie 链路回归；`buildKokoWsUrl` 不传 ticket 时逐字节一致。

**复检**

1. **断言 5.0 路径下 `ensureWebSession` 的调用次数为 0**（三处调用点：`JumpServerSession.ts:109-111`、`extension.ts:776-778`、`JumpServerClient.ts:1327`）。**方法本身不得删除**（4.x 与 web 资产仍需要，见 B.4.2）。
2. 断言 4.x / 3.x 路径下 `ensureWebSession` 的调用次数**与改动前完全一致**（防回归）。
3. 断言 5.0 路径下 `lastKokoWarmupMs()` 返回 **0**（见 B.4.3）。
4. 断言日志中**永不出现** ticket 值（沿用现有 `token=` 脱敏约定，新增 `ticket=` 脱敏规则，`ticket` 是 UUID 长度，需显式加规则）。

---

### B2. 5.0 上直接在 WS 握手带 `Authorization: Bearer`

**修改原因**

比 B1 还少一次往返：KoKo 5.0 的中间件在 ticket 之前先试 `Authorization/Date/X-JMS-ORG`，而 `CheckUserHeaders` 只是把三个头**原样转发给 Core 的 `GET /api/v1/users/profile/`**（`sdk-go/service/jms_user.go:25-32`）——插件在 REST 上**本来就用同一套 Bearer 打同一个端点**。

**官方客户端怎么做**

官方**没有**走这条路（桌面端选 ticket）。这条属于「源码可行、非官方主推」。官方在 `luna/DESIGN.md:316-324` 里写明了推荐的中间件优先级（cookie → Bearer → core 校验），即 Bearer 是设计内的合法路径。

**接口契约**：见 §1「⑤」。

**改动点**

| 文件 | 改动 |
| ---- | ---- |
| `src/jumpserver/JumpServerClient.ts` (`openKokoSocket`，1285-1329) | 探测为 5.0 且配置开启时，给 WS 握手加 `Authorization: Bearer` 头（Node `ws` 可自定义头，浏览器 WS API 不行——这是本插件相对 Web 端的结构性优势） |
| 配置 | 开关默认 **关闭**（`at-jumpserver.kokoBearerHandshake`，默认 `false`），并提供「探测可用才显示」的提示 |

**⚠️ 必须处理的陷阱（探针第 8 项实测）**

**带失效 Bearer 比不带更糟**：中间件②一旦发现「有头但无效」就 `401` 硬失败，**不会回落到 ticket（③）**。所以：

- [ ] 走 Bearer 前**必须**确认 Bearer 新鲜度（复用 `ensureAuthToken` 的过期前刷新）；
- [ ] 收到 WS `401` 时**清掉 Authorization 头重试一次**（回落 ticket / cookie），不能直接把失败抛给用户。
- [ ] **Step 1（RED）** mock：5.0 + 开关开 + Bearer 有效 → 握手的 `Authorization` 头存在，`login`/`ticket` 命中数均为 **0**。
- [ ] **Step 2（RED）** mock：Bearer 失效 → 首次 401，客户端**清头重试**并成功（断言重试 1 次、共 2 次握手，且第二次带回 ticket）。
- [ ] **Step 3（RED）** mock：4.x → 即使开关开也**不带** Bearer（因为旧中间件不看头，带了无意义且可能被网关拒绝）。
- [ ] **Step 4（GREEN）** 实现。
- [ ] **Step 5** 跑测试 + typecheck。

**测试**：有效/失效 Bearer；探测为旧版；开关关；401 重试只做一次（防重试风暴）；terminal 与 sftp 各断言一次（B.4.1）。

**复检**

1. **必须在真实 5.0 实例上验证 Core 对 `/api/v1/users/profile/` 的接受形态**——这一条是本节点唯一的未验证前提，**未验证前不得把开关默认值改为 `true`**。
2. 断言 401 重试路径下**不出现无限重试**（上限 1 次）。
3. 断言 Bearer 值不进入任何日志。

---

### B3.（可选）会话模型：一个资产下多 surface 共用一个会话记录

> **范围已在 v2 收窄。** 原 B3 含两半：① `jms://` / `jms2://` 深链解析；② 会话 tab 化。**① 已删除** —— 深链的消费方/生产方都是 Luna 桌面端（「把连接交回 OS」），与本插件「只依赖自身内嵌终端」的产品定位直接冲突（与 A4 一并去除，见 §4）。本节只剩 ②，且标为**可选/建议延后**：它工作量大、接口收益为零。

**修改原因**

插件当前 `asset + kind` 一个会话；官方一个 session 挂多个 surface（终端 / SFTP / 监控 / AI）。这**不依赖任何新端点**，是纯客户端重构。

**官方客户端怎么做**：`README_CN.md` 明确「终端、文件管理、数据库、远程桌面和 Kubernetes 连接都在同一个工作区中打开，可以通过标签页切换会话」。

**接口契约**：无新接口。

**改动点**：会话管理器支持「一个 asset 下多 surface 共用一个 session 记录」。

**硬约束（与 A3 同源）**

- ❌ **不得**借此把 SFTP 变成 eager：多 surface 共享的是**会话记录**，不是连接；文件树仍只在用户操作时建连（A3 ①）。
- ❌ 不得引入任何新的网络请求。

- [ ] **Step 1（RED）** 会话管理：同一 asset 第二次建 surface 时**不新建 session 记录**，且**不发生**新的 SFTP/终端建连。
- [ ] **Step 2（GREEN）** 实现。
- [ ] **Step 3** 跑测试 + typecheck。

**复检**：断言 tab 化**不改变**任何网络请求次数与形状（纯本地重构）；断言不会提前建连。

---

## B.4 「不破坏既有功能」回归审查（本次新增）

> 目的：回答「新增 5.0 匹配会不会打坏之前实现的功能」。以下每条都给出**共享接缝 → 风险 → 防护 → 判据**，均为代码级核对结果。

### B.4.1 `openKokoSocket` 是 terminal 与 sftp 的唯一握手咽喉

- **接缝**：`openKokoWebSocket`（`JumpServerClient.ts:1260-1271`）与 `openKokoSftpWebSocket`（`:1273-1283`）都收敛到 `openKokoSocket`（`:1285`）。
- **风险**：B1/B2 在这里加 ticket/Bearer，会**同时**改变两条链的行为。
- **防护**：所有新分支以 `input.kind` 显式判断；测试对 terminal 与 sftp **各断言一次**；ticket 缓存键含 `kind`（B1 改动点已含）。
- **判据**：`kind=sftp` 的 ticket 不会被 terminal 复用（除非 A3 生效时 token 相同，仍各换一张）；两条链在 4.x 上行为与改动前逐字节一致。

### B.4.2 `ensureWebSession` 有 **3 个**调用点 ⇒ 原 B1 改动点清单不完整

| 调用点 | 说明 |
| ------ | ---- |
| `src/jumpserver/JumpServerSession.ts:109-111` | 与 REST 腿并行的 fire-and-forget 预热 |
| `src/extension.ts:776-778` | `prefetchAssetDetail` 预热（资产浏览时触发） |
| `src/jumpserver/JumpServerClient.ts:1327` | `openKokoSocket` 内的 cookie 回落（`warmupKokoConnectPage`） |

- **风险**：只改第 3 处，5.0 上**照样会打表单登录**，B1 的「调用 0 次」判据不可达（还会白付一次登录）。
- **防护**：三处都服从 B0 的探测结果；`ensureWebSession` **方法本身不得删除** —— 4.x 与 Web 资产（`web_proxy`）仍需要它，只允许「跳过调用」。
- **判据**：5.0 路径 0 次、4.x 路径与改动前一致（B1 复检 1/2）。

### B.4.3 `lastWarmupMs` 的复位不能漏

- **接缝**：`openKokoSocket:1299` 现在无条件 `this.lastWarmupMs = 0`；`JumpServerSession.connect()` 的 finally 用它算 `warmup=`（`:165-174`）。
- **风险**：ticket/Bearer 若在复位之前提前返回，计时字段会读到上一轮的陈旧值 → 诊断日志失真（本仓库有「测量铁律」的传统，失真会误导后续性能判断）。
- **防护**：新分支同样复位。
- **判据**：新增断言「5.0 路径下 `lastKokoWarmupMs()` 返回 0」。

### B.4.4 org 切换必须让 ticket 缓存失效

- **接缝**：`JumpServerClientPool.acquire` 对复用 client 调 `setOrgId`（`JumpServerClientPool.ts:38`）；ticket 的 body 带 `org_id`（§1 ④）。
- **风险**：org 变了旧票必废 → 握手 401。
- **防护**：`setOrgId` 内清空 ticket 缓存。**探测结果不清**（`settings/client/versions/` 与 org 无关）。
- **判据**：断言 `setOrgId('other')` 后下一次握手会重新换票；断言探测结果不因 `setOrgId` 重发。

### B.4.5 A3（token 复用）与 B1（换票）叠加时的缓存键

- **风险**：A3 生效时 SFTP 与 terminal **共用同一个 token id**。若 ticket 缓存键只用 `kind`，或只用 `tokenId`，都会串。
- **防护**：键 = `(tokenId, kind)`。「同 token 共票」留作后续优化，需真机验证后再开。
- **判据**：B1 Step 4 的断言在 **A3 已落地** 的前提下仍通过。

### B.4.6 B 组不得依赖 A 组

- B0 探测失败必须回到**今天的** cookie 链路（含 `warmupKokoConnectPage`）⇒ 单独 revert B 组不产生半截状态。
- 反向：A 组落地后 B 组仍须可用（A3 对 B1 只是「token 更多时候是同一个」，不改变 B1 的任何判定）。

### B.4.7 测试基座会被 B1 翻转（真实陷阱，必须一起改）

- **现状**：`test/jumpserver/researchKokoAuthPaths.test.ts:397-404` 的用例 `'leaves the ticket endpoint unused: the plugin still logs in and sends a cookie'` 断言 `bastion.ticketHits === 0` 且 WS URL **不含** `ticket=`。这是**对「插件今天的实现」的描述**，不是服务端契约 ⇒ **B1 落地后必然变红**。
- **防护**：把该文件拆成两层：
  1. 「服务端行为」层（`:282-395`，8 条）—— 按 koko 源码逐行转录，**一条都不许动**；
  2. 「插件行为」层 —— 改为参数化：4.x ⇒ `ticketHits === 0` 且走 cookie；5.0 ⇒ `ticketHits >= 1` 且 WS 含 `ticket=`。
- **判据**：改动后文件用例数只增不减；「服务端行为」层的断言与源码引用保持不变。`test/jumpserver/JumpServerClientConnect.test.ts` / `JumpServerSession.test.ts` 等对 `createConnectionToken` / `openKokoSocket` 的 mock 也需同步复核。

### B.4.8 已核对、无需改动但需在 review 时确认的低风险面

| 面 | 结论 |
| -- | ---- |
| `webSessionStore` | 5.0 路径不再写 cookie，store 保持空；存储按 bastion 键控，从 5.0 切回 4.x bastion 不串（`src/jumpserver/webSessionStore.ts`） |
| `JumpServerSftpSession.connect()`（`:126-153`） | 自行解析 `protocols.includes('sftp')` 并自建 token；A3 只改「token 从哪来」，不改这段校验顺序与 WS 打开时机 |
| 应用层心跳 / 背压 | `JumpServerSession` 20s ping + 15s pong 超时、`JumpServerSftpSession` 8MiB 高水位 —— **与 B 组无关**，不得因对齐官方而改动 |
| 错误码分类 | B1/B2 新增的 401/404 不能污染 `src/jumpserver/apiError.ts` 的既有分类（否则用户会看到「认证失败」而实际是回落路径在探测） |

---

## 3. 复检总表（每个节点的验收判据）

| 节点 | 组 | 关键验收判据 | 失败即视为未完成 |
| - | - | ---------- | --------------- |
| A1 | 优化 | 每次建连 ≤1 次 connect-methods；未知 `value` 不崩；失败回落旧猜测 | 硬编码 `value` 枚举；请求数 >1 |
| A2 | 优化 | 5 个别名账号 payload 正确；托管账号行为逐字节不变 | 仍对 `@` 前缀抛错 |
| A3 | 优化 | **懒加载不回退**（只 `openAsset` 时 SFTP `connect()` = 0 次）；开关关闭 / RBAC 不足时连接仍成功；可复用时 token 只建 1 次 | 复用失败打断连接；为复用而提前建 SFTP |
| A4 | — | **已删除**（本插件不做外部客户端，见 §4） | — |
| B0 | 新增 | 任何探测异常 → 退回 cookie 链路（fail-closed）；**超时/5xx 不写缓存** | fail-open；一次抖动永久降级 |
| B1 | 新增 | 5.0 上 `ensureWebSession` 调用 **0** 次（**三处调用点全处理**）；4.x 上与改动前一致；ticket 与 token 绑定正确；不传 ticket 时 WS URL 逐字节不变 | 5.0 上仍走表单登录；只改了 `openKokoSocket` 一处 |
| B2 | 新增 | 401 后清头重试**恰好 1 次**；开关默认 `false` | 无限重试；默认开启 |
| B3 | 可选 | tab 化不改变网络请求，且不提前建连 | 引入新请求；提前建连 |
| §B.4 | 审查 | B.4.1–B.4.8 逐条在 PR 描述里勾选 | 漏项即未完成 |

**全局回归基线（改动前，已实测）：**

```
npx vitest run test/jumpserver   → 197 passed / 0 failed / 12 files
npx tsc --noEmit                 → exit 0
```

每个节点跑完后**必须**重跑这两条，且：

- 测试数只增不减；
- A 组不得让 `researchKokoAuthPaths.test.ts` 的 8 条「服务端行为」用例任何一条变红（该文件是判定 A/B 分组的实测地基；「插件行为」层的改写见 B.4.7）。

**上线前的一次真机联调（无真实 5.0 实例时不得跳过）：**

1. 一台 v5.0.0 + 一台 v4.10.19（或 v3.10.23）。
2. 在 v5.0.0 上验 B0/B1/B2；在 v4 上验 A 组 + 「B 组全部不启用且不报错」。
3. 验 A3：同一 token 先 terminal 后 sftp 能否握手成功；并复测「冷启动到终端可用」耗时不变。

---

## 4. 明确不做的事

- ❌ **不抄 luna 代码**（GPL-3.0-or-later）。只借鉴协议与分层。
- ❌ **不用 5.0-only 端点替换现有实现**。`connect-ticket` 与「WS Bearer」只能是「探测到才启用」的新增路径。
- ❌ **不做 `client-url` / `rdp-file` / 本机或外部客户端**（v2 决定）：产品是 VS Code 插件，连接能力只依赖自身内嵌终端；把凭据交回操作系统（`jms2://` 深链、系统 ssh、Navicat/DBeaver 等）属于官方 Luna 桌面端的职责。相应地把 §1 中 `client-url` / `rdp-file` / `exchange` 标为「不采用」，原 A4 节点整体删除，B3 去掉深链一半。
- ❌ **不改变 SFTP 的懒加载时机**（v2 决定）：只有在用户操作文件树/传输时才建连；任何「连接终端时顺手建好 SFTP」的写法都在禁止之列，包括以「会话复用」为名的变体。
- ❌ **不删应用层心跳与 `bufferedAmount` 背压**（`JumpServerSession.ts` 的 20s ping / 15s pong 超时）。这是本插件**强于**官方桌面端的地方，保留。
- ❌ **不硬编码 connect-methods 的 `value` 枚举**（5.0 新增 `web_proxy` / `vnc_client` / `vnc_guide`，4.x 没有）。
- ❌ **不在一次改动里同时上 A1 + B1 + B2 + B3**。A1 + A2 就能吃到大部分收益。
- ❌ **不把 `create_ticket` 当成 connect-ticket 用**（见 §0.3 修正 1；它是 ACL 审批工单开关）。
- ❌ **不把「SFTP Server 连接」当接口做**（见 §0.1 第 3 点；它是 Luna 的客户端 UI 能力）。

## 5. 风险与回滚

| 风险 | 影响 | 缓解 |
| ---- | ---- | ---- |
| `connect-methods` 在超大授权集下返回体很大 | 建连前多一次重响应 | 30s TTL + in-flight 合并；只取目标协议 |
| 5.0 的 ACL 从「只 reject」变成「accept 放行 − reject 禁用」 | 同一用户在 5.0 上**可见连法比 4.x 多**（`accept` 能覆盖 `reject`） | 以服务端返回为准，插件不做二次判断 |
| token 复用依赖管理员侧全局开关 + RBAC | 复用不生效 → 只是没省下那次 POST | 静默回落；不改变任何用户可见结果 |
| 复用后 SFTP 仍会另起一次目标机连接 | 若误以为「一次点击一次会话」会误判成本 | 文档与日志如实标注：省的是**授权**，不是连接 |
| WS Bearer 路径未被官方主推，且失效 Bearer 会 401 硬失败 | 用户看到连接失败 | 默认关闭 + 401 清头重试；真机验证通过前不放开 |
| B1 让 5.0 不再走表单登录，而 Web 资产可能仍需 cookie | Web 资产打开失败 | `ensureWebSession` 只跳过调用、不删除；`web_proxy` 路径保持 cookie（B.4.2） |
| ticket 刷新与 `token_id` 绑定 | SFTP/terminal 混用会 401 | 每 token 每 kind 独立换票 + 断言一致（B.4.5） |
| B 组改动面集中在认证 | 回滚成本 | A/B 分两个 commit 批次，B 组可整体 revert 而不动 A 组收益 |

## 6. 来源索引（本计划每条接口声称的出处）

**服务端 `jumpserver/jumpserver`**

| 主题 | 路径（tag 已固定） | 打到的版本 |
| ---- | ----------------- | --------- |
| connect-methods 路由 | `apps/terminal/urls/api_urls.py` | v3.10.23 / v4.10.19 / v5.0.0 都有 |
| connect-methods API（**三版本逐字节相同**） | `apps/terminal/api/component/connect_methods.py` | v3.10.23 == v5.0.0 |
| connect-methods 数据来源与差异 | `apps/terminal/connect_methods.py` | v3.10.23 vs v5.0.0 diff |
| sftp 的合法 `connect_method` 值（`web_sftp` / `sftp_client`） | `apps/terminal/connect_methods.py:23,50` | v5.0.0 |
| connection-token 各 action | `apps/authentication/api/connection_token.py` | v3.10.23 / v5.0.0 |
| reuse action 与全局开关报错 | v3 `connection_token.py:263-271`、v5 `:557-566` | 均有 |
| **token 取用时被消费 / reusable 例外** | v3 `connection_token.py:524-535`、v5 `:1289-1300` | 均有 |
| connection-token 模型（自由字段 / `set_reusable` / 个人凭据保护） | `apps/authentication/models/connection_token.py` v3 `:80-94` / v5 `:124-140` | v3 无个人凭据保护 |
| `CONNECTION_TOKEN_REUSABLE` 默认 false | `apps/jumpserver/conf.py:258` | v5.0.0 |
| 别名账号 5 值 | `apps/accounts/const/account.py:14-19` | v3.10.23 == v5.0.0 |
| 客户端版本清单 | `apps/settings/api/settings.py` | v4.10.19（不含 5.0.0）/ v5.0.0（含） |

**KoKo `jumpserver/koko`**

| 主题 | 路径 | 结论 |
| ---- | ---- | ---- |
| 路由表：`/koko/api/` 组 | `pkg/httpd/webrouter.go` | v3/v4 **无**；v5.0.0 `:49-52` 有 |
| `/koko/health/` 无版本号 | `pkg/httpd/webrouter.go:66`、`pkg/httpd/webserver.go:281-287` | 三版本都有，不能当探针 |
| connect-ticket 实现与响应字段 | `pkg/httpd/webserver.go:289-314` | 仅 v5.0.0 |
| 票据常量（header / query / **TTL 30min**） | `pkg/auth/connect_ticket.go:13-18` | 仅 v5.0.0 |
| WS 中间件三段式 | `pkg/auth/http.go:21-93`（v5，122 行）/ **v3.10.23 与 v4.10.19 均 47 行** | 分水岭 |
| `CheckUserHeaders` = 转发到 Core `/api/v1/users/profile/` | `jumpserver-dev/sdk-go` `service/jms_user.go:25-32` | v5.0.0 锁定 |
| **SFTP 沿用调用方传入的 token** | `pkg/srvconn/sftp_asset.go` v3 `:591-593` / v5 `:1096-1099`；v5 `:1030-1032` 注释 | **均有** ⇒ A3 依据 |
| WS 参数结构无 session 标识 | `pkg/httpd/message.go:151-165` | ⇒ 「复用通道」不存在 |
| SFTP 每次握手自建连接 | `pkg/srvconn/sftp_asset.go:1088-1094`、`:1121-1138` | 同上 |
| 会话注册表只服务心跳/任务 | `pkg/session/manager.go:11-36`；使用点 `pkg/koko/task.go:171,265` | 同上 |

**客户端 `jumpserver/luna`（GPL-3.0，只读参考）**

| 主题 | 路径 |
| ---- | ---- |
| 桌面端换 ticket（Bearer） | `electron/src/auth/service.ts:545-578` |
| Web 端换 ticket（cookie + CSRF） | `ui/layouts/default.vue:334-347` |
| 降级措辞 | `ui/lion/hooks/useLionConnectTicket.ts:6-12` |
| 25 分钟刷新阈值 | `ui/lion/views/ConnectView.vue:149` |
| 连法声明 / 获取 / 选择 | `ui/shared/connectors/capabilities.ts`、`ui/composables/useConnectMethods.ts`、`ui/composables/useAssetAction.ts` |
| 账号模式 | `ui/composables/useConnectionFormState.ts:89-90`、`ui/composables/useAssetAction.ts:287-307` |
| 中间件优先级设计说明 | `DESIGN.md:316-324` |
| WS URL 拼装 | `packages/connectors-core/src/useConnectorEndpoint.ts`、`utils/wsQuery.ts` |
| 官方 SFTP 也自建 token（`protocol:"sftp"` + `connect_method:"web_sftp"`） | `ui/koko/e2e/sftp.spec.ts:481-489` |
| 支持协议声明 | `README_CN.md` |

**本插件**

| 主题 | 路径 |
| ---- | ---- |
| 协议猜测（待被 A1 兜底化） | `src/jumpserver/connectionTypes.ts` |
| 建连 6 步 / 心跳 / `lastWarmupMs` 计时 | `src/jumpserver/JumpServerSession.ts:99-176`（预热调用点 `:109-111`） |
| token / 端点 / WS / 表单登录 | `src/jumpserver/JumpServerClient.ts`（`buildKokoWsUrl:279`、`buildKokoSftpWsUrl:295`、`resolveFirstUsableAccount:425`、`buildConnectionTokenPayload:449`、`warmupKokoConnectPage:1035`、`ensureWebSession:1068`、`openKokoSocket:1285`（`lastWarmupMs` 复位 `:1299`、cookie 回落 `:1327`）、`restHeaders:1339`） |
| cookie 持久化 | `src/jumpserver/webSessionStore.ts` |
| client 池 / `setOrgId` 复用点 | `src/jumpserver/JumpServerClientPool.ts:38` |
| **SFTP 懒加载证据** | `src/sftp/JumpServerSftpManager.ts:56-66`（只登记）、`:247-276`（唯一 connect）、`src/sftp/JumpServerSftpSession.ts:126-153` |
| 宿主装配（createSession / prefetch） | `src/extension.ts:80-86`、`:776-778` |
| 已有差分探针 | `test/jumpserver/researchKokoAuthPaths.test.ts`（**`:397-404` 会被 B1 翻转**，见 B.4.7） |
| 前序研究 | `docs/research/jumpserver-5.0-luna-vs-at-plugin.md` |

---

*本计划所有接口路径、字段、常量与版本归属均来自上表源码实测（本地克隆 tag 固定）。凡未在真实实例验证者已在 A3 / B1 / B2 的「复检」中显式标注为前置条件。*
