# AT JumpServer Terminal 后续完善建议

**Date:** 2026-08-27  
**Status:** Proposal（产品补齐路线，不是本轮要实现的代码）  
**Code basis:** 发布版 **0.1.9** + 未发布分支 `cursor/perf-remaining-impl-fb4b`（连接并行、SecretStorage 会话 cookie、SFTP 分块、MCP 惰性启动等）  
**Method:** 四路代码/规格对照扫描（认证与资产树、终端/SFTP/数据库、MCP/Agent、产品化与工程）

本文件回答：这是一个能连上 JumpServer 的早期产品，**下一步该补什么、按什么顺序、明确不做什么**。不改 HMAC 默认、不默认 `token_reusable`、不把 RDP 做成编辑器内嵌桌面。

---

## 1. 一句话现状

已经能用的核心闭环是：

- 多堡垒密码登录 → 资产树 → SSH / MySQL CLI / Redis CLI（KoKo xterm）
- SSH 上的 SFTP 树、预览/编辑、MCP 14 个 `jumpserver_*` 工具

还不能当「每天主力」的原因，不在缺一个大功能，而在三件事叠在一起：

1. **人机导航弱于 Agent**：MCP 能搜资产，人只能在树上翻；多账号资产静默挑第一个。
2. **已有能力不够可信**：状态写成 Connected 时 KoKo 可能还在 SSH；SFTP 断线后 `ensureSession` 会一直拿死会话；上传会覆盖同名文件；断线后重连藏在命令面板。
3. **发布叙事落后于代码**：perf 分支已持久化 KoKo `sessionid`/`csrftoken`，README / CHANGELOG / version 仍写 0.1.9；删堡垒只删密码、**不清** `jumpserver.webSession.<id>`。

建议把 **0.2.0 做成「把已有的做可信、可发布」**，把新协议和新 GUI 放到 0.3+。

---

## 2. 明确不做 / 缓做

| 项 | 原因 |
|---|---|
| 编辑器内 RDP / VNC | 图形协议，不是 xterm 产品形态；应用浏览器深链打开 Luna |
| 默认 `token_reusable` | 等于长期直连凭据 |
| 全局「永远允许 Agent」设置 | ADR-001：确认权在 extension host；会话级 Always-allow 是上限 |
| 交互式打 captcha | 失败时提示去浏览器登录一次即可 |
| 无限自动重连 | 审计上等于静默再登录 |
| 每 PR 起一套真 JumpServer | 慢且脆；保留 `probe` + 夜间可选任务 |
| 遥测上报主机名/资产 | 本产品持有密码和会话 cookie；「数据不出机器」可写成卖点 |
| Ahell 后端、直连 ssh2 | 首版规格 Non-Goals，维持 |
| 把确认 UI 搬进 hub | hub 只做路由 |

Chen MySQL 工作台规格（2026-05-15）**先标为暂缓**：研究仍然有效，0.2 不要半成品 GUI。0.3 优先无头 Chen → 结构化 MCP 结果，再考虑 schema 树。

---

## 3. 建议版本切分

### 0.2.0 — 产品化已有能力（优先）

目标：装上这个构建后，人能搜到资产、选对账号、断线能点重连、Agent 不会双执行、文档与安全承诺和代码一致。

**发布与安全（必须和 perf 同发）**

- 升到 **0.2.0**：CHANGELOG、`docs/releases/0.2.0.md`、README「本版支持/不支持」、cookie 持久化披露（存什么、存在哪、如何清）。
- `deleteBastion` 同时删除 `jumpserver.webSession.<id>`（今日只删密码，见 `JumpServerConfigManager.ts`）。
- 测试里不要写死 `expect(version).toBe('0.1.9')`。
- 五个 settings 补 `%…%` 描述（现在 Settings 里是光秃秃的 key）。
- `publisher: "local"`、缺 license/repository：先做**分发决策**（仅 VSIX / OpenVSX / Marketplace），再补清单字段。

**人机 P0**

- **搜索资产 QuickPick**（只读缓存，选中即连）——树没有搜索，MCP 却有。
- **多账号 QuickPick**；仅一个带密钥账号时仍自动选。`@INPUT` 资产提示输入，而不是空 `input_secret` 失败。
- 终端断线状态显示 **Reconnect**（命令 `jumpserverManager.reconnect` 已存在，webview 没有入口）。
- SFTP：**上传前覆盖确认**；补 **Go to Path**、**New File**（manager 已有 `changeDirectory` / `createFile`）。
- SFTP：`ensureSession` 发现 `!isConnected()` 则丢掉重建（死会话是 Files 上的真故障）。
- 登录失败分类：MFA / 仅 SSO / captcha 给出可读原因，而不是泛 API 错误。
- 错误 toast：失败不要 3 秒消失；带「打开日志」。

**Agent P0**

- 确认耗时 + 命令耗时之和不得超过 hub 120s，否则会换窗口重试（**双执行**）。今日确认 100s、执行上限 110s，**两段相加仍可超过 120s**。
- 确认结果写入本地审计（通过 / 拒绝 / 超时）；修错误文案 `jumpserver_sftp_stat` → `jumpserver_sftp_stat_path`。
- `terminalId` 在本窗口找不到时明确说「可能属于另一个窗口」，并在 context 里带 `bridgeId`。

### 0.3 — 组织适配与 Agent 真正闭环

- MFA/OTP（REST + KoKo 表单两条登录都要覆盖，需真环境）。
- 收藏 / 最近连接 / 每资产上次账号。
- 切换组织命令（已有 `listAccessibleOrgs`）。
- 自定义 CA；`verifyTls: false` 时堡垒根上给警告。
- 不支持的协议：弱化图标 + 「在浏览器打开 Luna」。
- REST 侧 AccessKey HMAC（`Date` 头已发；终端仍可能需要密码，文档写清）。
- 会话级 Always-allow（按资产 + 风险类别，**不落盘**）；只读 shell 白名单（无 metachar 才免确认）。
- **`jumpserver_connect_asset` / disconnect / open_sftp / cancel_command`** —— 否则每次对话都卡在「请先在 IDE 里点连接」。
- 拖拽上传、传输可取消、冲突时 `vscode.diff`。
- `@at-series/command-policy` 对齐 AT Terminal 的信任档。
- 无头 Chen：MCP SQL 返回 `{ fields, rows }`。

### 更后

- PostgreSQL `db_client`（先 probe，路径与 MySQL 类似）。
- K8s web 终端。
- AccessKey 无密码开终端（取决于 KoKo 版本是否接受非 Cookie 握手）。
- 浏览器 SSO 回跳。
- MySQL 工作台 GUI、Redis 键浏览器。
- 多窗口 globalState 按堡垒拆 key。

---

## 4. 分领域摘要

### 4.1 认证、账号、树、协议

对照 Luna：账号选择器、组织切换、资产搜索、收藏是日常；本扩展都缺。

| 缺口 | 级别 | 说明 |
|---|---|---|
| 静默 `resolveFirstUsableAccount` | P0 | `JumpServerClient.ts`；多账号无法选低权限；`@INPUT` 必失败 |
| 树内搜索 | P0 | UI 无；MCP `list_assets` 已有 search |
| 登录失败分类 | P0 | MFA/SSO 用户现在只看到 REST 错 |
| Cookie 持久化 vs 规格「仅内存」 | P0 | 功能保留，必须改文档 + 删除时清理 |
| 组织切换 | P1 | 保存后只能改 UUID 文本框 |
| MFA OTP | P1 | 企业堡垒刚需；KoKo 表单是第二条登录 |
| AccessKey HMAC | P1 REST / P2 终端 | 签名半成品（已有 Date 头） |
| 最近/收藏/上次账号 | P1 | 纯 globalState |
| PostgreSQL | P1（probe 后） | 复用 `db_client` |
| RDP/VNC | WONT | 浏览器深链 |
| 自定义 CA / 关闭 TLS 警告 | P1 | 内网自签是目标客户常态 |
| `connectTimeout` 设置 | P2 | 规格有，代码写死 15s/60s/15s |

### 4.2 终端、SFTP、MySQL、Redis

| 缺口 | 级别 | 说明 |
|---|---|---|
| 断线 Reconnect 按钮 | P0 | 命令已有 |
| 终端内查找 | P0 | 无 SearchAddon |
| Settings 无 description | P0 | 含 idle disconnect，用户找不到「0 = 关闭」 |
| SFTP 上传覆盖 | P0 | 编辑流有冲突框，普通上传没有 |
| `sftp.goToPath` / `sftp.newFile` | P0 | 规格有，manager 有，命令未挂 |
| SFTP 死会话 | P0 | `closeActive` 几乎不被调用；ensure 不重建 |
| 「Connected」早于资产 SSH | P1 | `JumpServerSession` 在 `TERMINAL_INIT` 就标 Connected |
| 同资产重复开面板 | P1 | 应询问聚焦已有 / 新开 |
| 符号链接当文件渲染 | P1 | 链到目录进不去 |
| 传输不可取消、下载无进度 | P1 | |
| 1MB 编辑上限不可配 | P1 | |
| Redis `FLUSHALL` 与 `SET` 同一档确认 | P1 | |
| Redis Cluster | P1 先 probe | |
| WebGL | P1 | 与 CSS zebra 冲突，需回退 |
| Chen GUI | 0.3+ | 0.2 保持 CLI |
| chmod | WONT | KoKo 协议无此命令 |

状态文案 `'Connected'` / `'Disconnected'` 被当协议用（`startsWith`），一做 i18n 就会坏。0.2 中后期应改成结构化 `state` 枚举，展示层再翻译。

### 4.3 MCP / Agent

14 个工具已与 `SKILL.md` 对齐。P0c 规格仍写 15 个工具（`mysql_get_context` 等），属文档漂移。

| 缺口 | 级别 | 说明 |
|---|---|---|
| hub 120s failover 双执行 | P0 | 上游应对 `exec`/`write` 禁用换 bridge；本仓先做剩余预算 |
| 确认无审计 | P0 | |
| 错误里写错工具名 | P0 | `jumpserver_sftp_stat` |
| 跨窗口 terminalId | P0 先响亮失败；P1 让 hub 按 terminalId 路由 | capabilities 目前只有 connectedTargets 计数 |
| 只读 `ls` 也弹窗 | P1 | 对照 SQL/Redis 白名单 |
| 每个 SFTP 写一弹 | P1 | 会话 Always-allow |
| Agent 不能 connect | P1（0.3 头条） | 现在只能操作已打开会话 |
| `cancel` / 下到工作区 | P1 / P2 | |
| VS Code 原生 MCP 安装目标 | P2 | 安装器目前跳过纯 VS Code |
| 全局免确认 | WONT | |

上游 `@at-series/mcp-hub` 应单独立项：`callTool` 免全量 refresh、exec 不 failover、按 terminalId 选 bridge。

### 4.4 产品化与工程

| 缺口 | 级别 | 说明 |
|---|---|---|
| version/README 落后 perf 分支 | P0 | |
| 命令面板露出无参会空操作的命令 | P1 | `connect`、SFTP 文件命令等 `if (!item) return` |
| `viewsWelcome` 空态 | P1 | 现在只有「添加堡垒」树节点 |
| MCP 确认句英文 | P1 | `commandPreview.ts` 与 AgentService 模板字符串 |
| 用户可修复错误未走 `t()` | P1 | 「JumpServer is not configured.」等 |
| `webSessionStore` 单测 | P1 | 新安全路径 |
| CI 不跑 `npm run build` / vsce | P1 | |
| `tools/probe-jumpserver-sftp.mjs` | P1 | README 指向它，仓库 gitignore 了 `tools/` |
| `skills/` 打进 VSIX | P1 | AT Terminal 用 `npx skills add`；应对齐 `.vscodeignore` |
| 多窗口 globalState 整表覆盖 | P1 文档 / P2 拆 key | |
| 错误 3 秒消失 | P1 无障碍 | `TIMED_NOTIFICATION_MS = 3000` |
| `@vscode/test-electron` 未用 | P2 | |
| 遥测 | WONT | |

---

## 5. 建议落地顺序（0.2 内部）

按「用户每天是否碰到」而不是按模块：

1. **发布卫生 + 删堡垒清 cookie + settings 描述**（不然后面每条都在错误版本号上讨论）。
2. **搜索资产、账号选择、Reconnect 按钮**（人机三条最短路径）。
3. **SFTP 覆盖确认、goToPath、newFile、死会话重建**。
4. **Agent 双执行预算、确认审计、工具名、跨窗口报错**。
5. **错误持久 toast + 打开日志；命令面板隐藏无参命令；viewsWelcome**。
6. **终端查找、状态枚举（为 i18n 和「尚未 SSH 完成」打底）**。
7. 再开 0.3：MFA、connect 工具、Always-allow、Chen 无头结果。

每批：先补失败测试，再改代码。连接日志仍禁止打印 token URL、Cookie、密码。

---

## 6. 验收信号（0.2 人工）

- 万级缓存下命令面板「搜索资产」能按 IP/名连上，不发新的全量 REST。
- 一资产两账号时弹出选择；选过的可在 0.3 记住。
- 拔网线或 idle 断开后，面板上能一键重连，不必找命令面板。
- 上传已存在的远程文件会问覆盖。
- 关掉 SFTP 套接字后再点 Refresh，Files 会重建而不是一直报错。
- 删除堡垒后 SecretStorage 里不再残留 `jumpserver.webSession.*`。
- README 写明：会话 cookie 在 SecretStorage；reload 后可跳过 Django 表单。
- Agent：`ls` 仍确认（0.2 可不做白名单），但确认+执行不会触发第二窗口再跑一条 `rm`。
- Output「AT JumpServer Terminal」在 Debug 下能看到分步 `connect timings`，且无 cookie/token 原文。

---

## 7. 证据索引（实现时从这些文件进）

- 账号选择：`src/jumpserver/JumpServerClient.ts` `resolveFirstUsableAccount`
- 会话 cookie：`src/jumpserver/webSessionStore.ts`；删除缺口：`JumpServerConfigManager.deleteBastion`
- 过早 Connected：`src/jumpserver/JumpServerSession.ts` `TERMINAL_INIT`
- SFTP 死会话：`src/sftp/JumpServerSftpManager.ts` `ensureSession` / `closeActive`
- MCP 确认超时：`src/mcp/confirmTimeout.ts` vs hub `INVOKE_TIMEOUT_MS = 120000`
- 工具名笔误：`src/agent/JumpServerAgentToolService.ts` 大文件错误文案
- 空态：`src/tree/BastionTreeItem.ts` `EmptyBastionTreeItem`
- 3 秒错误：`src/utils/notifications.ts` + `runCommand`
- 规格漂移：`docs/superpowers/specs/2026-05-15-jumpserver-mysql-gui.md`（Chen）、`2026-07-28-p0c-jumpserver-hub-design.md`（15 tools）、`2026-05-13`「cookie 仅内存」
