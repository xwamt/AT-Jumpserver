# P0c: AT JumpServer Series Hub 接入 Design

**Date:** 2026-07-28  
**Status:** Approved — implementation plan: `docs/superpowers/plans/2026-07-28-p0c-jumpserver-hub.md`  
**Source (read-only):** `C:\Users\alan\Desktop\jumpserver-plugins`  
**Work tree:** `C:\Users\alan\Desktop\at-jumpserver-series`  
**Hub package:** `@at-series/mcp-hub@^0.1.1`（已发布 npm；默认不修改 mcp-hub 源码）

**Anchors:**

- `C:\Users\alan\Desktop\at-series-mcp-hub\docs\requirements.md`（P0c / A1–A2 / D30）
- `C:\Users\alan\Desktop\at-series-mcp-hub\AGENTS.md` §8.1 / §8.3
- `C:\Users\alan\Desktop\at-series-mcp-hub\docs\protocol\v1.md`
- `C:\Users\alan\Desktop\at-series-mcp-hub\docs\guides\plugin-integration.md`
- P0b 参考实现：`C:\Users\alan\Desktop\at-terminal-series`

---

## 1. Goal

在**新项目** `at-jumpserver-series` 中，将 AT JumpServer Terminal 的 MCP 面迁到 AT Series Hub Protocol v1：扩展宿主跑 Bridge、向 Hub 注册工具；IDE 只保留一条 MCP 入口 **`AT Series`**。同时补齐 P0c 明确要求的 exec 确认：`jumpserver_send_terminal_input`、`jumpserver_mysql_send_input`。

## 2. Decisions (grill)

| # | Decision |
|---|----------|
| D1 | 新路径：`C:\Users\alan\Desktop\at-jumpserver-series`；原 `jumpserver-plugins` 只读不改 |
| D2 | 依赖：`"@at-series/mcp-hub": "^0.1.1"` |
| D3 | 改造路径：对齐 P0b（整层 MCP 重接 Protocol v1），不贴旧 `/tools/<name>` 适配层 |
| D4 | 两个 `send_input`：每次 VS Code 确认框；文案含资产名 + 输入预览（过长截断） |
| D5 | `jumpserver_mysql_execute_sql`：保持现状——只读 SQL 免确认，变更类确认；工具仍标 `risk=exec` |
| D6 | **禁止**修改 mcp-hub，除非用户事先确认；若修改须在回复中加重加粗标明 |
| D7 | 本阶段不修 SFTP `connectionKey` 既有产品债（不改工具语义） |

## 3. Architecture

```text
IDE MCP Client
  └─ "AT Series" → ~/.at-series/mcp/hub.js
       └─ ~/.at-series/bridges/<hostApp>/<bridgeId>.json
            └─ Bridge 127.0.0.1  GET /health | GET /tools | POST /invoke
                 └─ JumpServerAgentToolService（凭据 + 确认仍在此）
```

**Identities:**

- `pluginId`: `at.jumpserver`（稳定不变）
- 工具名 v1：保持 `jumpserver_*`（15 个）
- `hostApp`: 运行时探测（cursor / kiro / vscode / …）

**Lifecycle (MCP-capable build — JumpServer 整包即 MCP 能力):**

1. activate → `syncHubBundle`
2. start Bridge → `FsBridgePublisher.publish` + heartbeat ≤30s
3. `ensureAtSeriesMcpConfig`（写/迁移 **`AT Series`**；不删第三方）
4. deactivate → `unpublish` only（不删 `hub.js`，不卸 MCP 配置）

**Out of scope:**

- 修改 `at-series-mcp-hub` / `@at-series/mcp-hub` 源码（默认）
- 修改原 `jumpserver-plugins`
- P1 系列 skill、P2 工具改名前缀
- 把确认 UI 搬进 Hub
- 通用 Bridge HTTP 框架抽回 Hub

## 4. Tool risk matrix + confirmation

单一真源：`src/mcp/toolCatalog.ts`（供 `/tools`、registry、installer autoApprove）。

| Tool | risk | Plugin confirmation |
|------|------|---------------------|
| `jumpserver_list_assets` | read | no |
| `jumpserver_get_terminal_context` | read | no |
| `jumpserver_sftp_list_directory` | read | no |
| `jumpserver_sftp_stat_path` | read | no |
| `jumpserver_sftp_read_file` | read | no |
| `jumpserver_mysql_get_context` | read | no |
| `jumpserver_sftp_write_file` | write | existing `requireConfirm` |
| `jumpserver_sftp_create_file` | write | existing |
| `jumpserver_sftp_create_directory` | write | existing |
| `jumpserver_sftp_rename` | write | existing |
| `jumpserver_sftp_delete` | write | existing |
| `jumpserver_send_terminal_input` | exec | **new** — every call |
| `jumpserver_run_terminal_command` | exec | existing |
| `jumpserver_mysql_send_input` | exec | **new** — every call |
| `jumpserver_mysql_execute_sql` | exec | keep: confirm only non-read-only SQL |

**autoApprove:** only `risk=read` tools + Hub built-in `at_list_providers` via `defaultAutoApproveToolNames`.

**Cancel behavior:** throw (same style as existing `was cancelled` / `operation was cancelled`); never silent success.

**send_input prompt shape:** include asset name + truncated input preview (align with `runTerminalCommand` tone).

## 5. File map (in `at-jumpserver-series`)

| Path | Action |
|------|--------|
| *(tree)* | Copied from `jumpserver-plugins` (exclude `.git`, `node_modules`, `dist`, `*.vsix`) |
| `package.json` | Add `@at-series/mcp-hub@^0.1.1`; remove `languageModelTools` + `onLanguageModelTool:*` |
| `esbuild.config.mjs` | Stop bundling `src/mcp/server.ts` → `dist/mcp-server.js` |
| `src/mcp/toolCatalog.ts` | **Create** |
| `src/mcp/hostApp.ts` | **Create** (mirror P0b) |
| `src/mcp/hubSync.ts` | **Create** (mirror P0b) |
| `src/mcp/bridgeSchemas.ts` | **Create** — Zod for invoke args |
| `src/mcp/BridgeServer.ts` | **Rewrite** — Protocol v1 + `FsBridgePublisher` + heartbeat |
| `src/mcp/BridgeProtocol.ts` | **Rewrite** — primary `x-at-series-token`; optional legacy header during migrate |
| `src/mcp/McpConfigInstaller.ts` | **Rewrite** — `ensureAtSeriesMcpConfig` / uninstall helpers |
| `src/mcp/BridgeDiscovery.ts` | Delete or stop using (no `~/.at-jumpserver-terminal` as Hub path) |
| `src/mcp/BridgeClient.ts` | Delete or stop using |
| `src/mcp/server.ts` | Delete or leave unbuilt |
| `src/agent/JumpServerAgentToolService.ts` | Add confirms for both `send_input` methods |
| `src/agent/AgentTools.ts` | Stop registering `vscode.lm` tools |
| `src/extension.ts` | Wire hub sync → bridge → ensure config; dispose unpublish only |
| `test/mcp/**` | Rewrite for health/tools/invoke + publisher paths |
| `test/agent/**` | Cover new send_input confirms; keep existing green |
| README / ADR pointer | Point to Hub; do not recommend per-plugin mcp-server |

## 6. Bridge HTTP contract (consume Protocol v1 only)

- Listen: `127.0.0.1` ephemeral port
- Auth header: `x-at-series-token` (legacy JumpServer header may be accepted temporarily)
- Body limit: `BRIDGE_MAX_BODY_BYTES` from `@at-series/mcp-hub`
- `GET /health` → 200 + identity / ok
- `GET /tools` → `{ protocolVersion: 1, tools: [...] }` matching catalog
- `POST /invoke` body: `{ name, arguments }`
- Success: `{ ok: true, name, result }`
- Error: `{ error: { code, message, details? } }`  
  Codes: `UNAUTHORIZED`, `VALIDATION_ERROR`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`, plus domain failures as appropriate

Hub contract changes are **out of scope**; if a gap is found, stop and ask before touching mcp-hub.

## 7. Testing & acceptance

### Automated

- Catalog: 15 names; risk matches §4
- Bridge: auth, validation, body limit, invoke routing to `JumpServerAgentToolService`
- Publisher: writes `~/.at-series/bridges/<hostApp>/<uuid>.json`; dispose removes file only
- Installer: writes `AT Series`; migrates `AT JumpServer Terminal`; preserves third-party
- Confirms: cancel/approve for both `send_input`; existing run/sftp/mysql-change tests stay green
- Build: no product dependency on `dist/mcp-server.js`

### Manual smoke

1. Extension host → `~/.at-series/mcp/hub.js` exists  
2. Bridge registry under `~/.at-series/bridges/<hostApp>/`  
3. IDE MCP only **`AT Series`** + `AT_SERIES_HOST_APP`  
4. Tools appear while window alive; disappear when extension disabled  
5. Coexist with `at-terminal-series` without a second AT MCP entry  
6. Both `send_input` tools always prompt  

### Definition of Done

- [ ] Original `jumpserver-plugins` unmodified by this work  
- [ ] `at-jumpserver-series` independent git (no old origin unless user requests)  
- [ ] **mcp-hub not modified** (unless pre-approved and called out in bold)  
- [ ] No `languageModelTools`; no per-plugin mcp-server product entry  
- [ ] write/exec not in default autoApprove; both `send_input` confirms shipped  
- [ ] AGENTS §8.1 + §8.3 checklist satisfiable with evidence  

## 8. Risks / non-goals

| Risk | Mitigation |
|------|------------|
| Accidental mcp-hub edit breaks P0b | Hard rule: adapt plugin only; ask before hub changes |
| Dual protocol leftover | Delete product paths for old discovery / mcp-server / LM tools |
| Over-scoping SFTP connectionKey | Explicitly deferred |
| Confirm UX fatigue on send_input | Accepted (D4); no session trust in P0c |

---

## Spec self-review

1. **Placeholders:** none intentional; open items resolved via grill (path, dep, confirm UX, mysql execute policy, approach A).  
2. **Consistency:** architecture, file map, risk matrix, and DoD all assume Protocol v1 + plugin-local confirms + no hub edits.  
3. **Scope:** single subsystem (JumpServer plugin adaptation); Hub/P1/P2 excluded.  
4. **Ambiguity:** JumpServer has no base/mcp dual variant — whole package contributes Hub (unlike AT Terminal MCP-only variant); stated in §3 / §5.
