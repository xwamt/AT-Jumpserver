# AT JumpServer Terminal

AT JumpServer Terminal is a VS Code / Cursor extension for opening browser-style JumpServer SSH, MySQL, and Redis terminal sessions from the editor.

**Current version: 0.2.2**

## Supported In This Version

- Username and password login to JumpServer with inline **Test Connection** validation in the bastion config panel
- Multiple JumpServer bastions in one asset tree with per-bastion Refresh, Edit, Remove, and Validate actions
- Reused REST Bearer token and KoKo web session across connects, plus JumpServer 5.0 alignment:
  - Dynamic `connect-methods` negotiation (`web_cli`, `db_client`, `web_sftp`)
  - KoKo 5.0 capability probe & cookie-less handshake (with opt-in `jumpserverManager.kokoBearerHandshake` and automatic ticket fallback on HTTP 401)
  - Alias account modes (`@USER`, interactive `@INPUT` credential prompt, `@ANON`, `@ALL`, `@SPEC`) and per-asset remembered account preference
  - Reusable terminal-to-SFTP connection token sharing with fallback when token reuse fails
- Listing permitted assets with per-bastion group-tree indexing cache, distinct protocol icons, and Command Palette `JumpServer: Connect` global QuickPick search
- Asset command trust levels (`Untrusted`, `Limited trust` via `@at-series/command-policy`, and `Full trust`)
- SSH, MySQL / MariaDB (via JumpServer `db_client`), and Redis (via JumpServer `db_client`) protocol terminals
- Right-click **Connect Asset** (or **连接资产** in Chinese UI) on multi-account assets to pick or switch accounts, while single-click auto-reuses the remembered preferred account
- SFTP lazy loading on explicit Files interaction (click the pending Files placeholder or Refresh to open)
- SFTP WebSocket heartbeat (20s/15s) and automatic reconnect/rebuild after disconnect
- SFTP upload (streaming 4 MiB chunked transfer from disk without buffering whole files in memory), download, new folder, new file, rename, delete, copy path, go to path, and **Open in Terminal** (`cd` active SSH terminal to directory)
- Single-click SFTP file preview and managed remote edit sessions with first-save sync confirmation and conflict detection
- Copy Host IP from the asset list context menu
- xterm.js terminal UI with initial viewport sizing matched on first open and reconnect, structured localized status bar with host/protocol label and **Reconnect** action (header button & editor title bar), and live configuration hot-reload (font size, font family, scrollback, semantic highlight, idle disconnect)
- JumpServer KoKo WebSocket terminal sessions
- MCP tools for JumpServer assets, terminal context, SFTP, SSH terminal commands, MySQL CLI SQL execution, and Redis CLI command execution (via AT Series hub)

## Not Supported In This Version

- Ahell backend integration
- Direct SSH through ssh2
- Editing files larger than 1 MB or binary files through the preview/edit workflow
- MySQL GUI/workbench, Chen SQL editor, schema browser, or result grid
- Redis GUI / key browser (Redis uses the shared xterm CLI terminal only)
- RDP, PostgreSQL, Oracle, SQL Server, Kubernetes, or other non-SSH/non-MySQL/non-Redis assets
- SSO, MFA, captcha, private token, or access key login

## Setup

1. Open the AT JumpServer activity bar.
2. Run `JumpServer: Configure`.
3. Run `JumpServer: Add Bastion` (or Configure) for each JumpServer URL, username, password, and TLS setting. Display name may stay empty, and Org ID may stay empty until Validate. Use **Test Connection** in the panel to verify connectivity before saving.
4. Run `JumpServer: Validate Account` and pick the bastion if more than one is saved. If the account can see more than one organization, pick one; the Default organization is saved automatically only on a reserved single-org deployment. An empty org ID with more than one organization prompts on Validate and Refresh rather than silently mixing inventories.
5. Run `JumpServer: Refresh Assets` to refresh every bastion, or right-click a bastion root to refresh only that one.
6. Click an SSH, MySQL / MariaDB, or Redis asset in the tree—or run `JumpServer: Connect` from the Command Palette to search cached assets via QuickPick—to open a terminal. For multi-account assets, use right-click **Connect Asset** to pick or switch accounts.
7. After connecting to an SSH asset, click the pending item in the Files view (or click Refresh) to lazily open the SFTP session.
8. Optional: run `Install/Repair AT Series MCP Config` to expose JumpServer tools to MCP-capable agents.

## Configuration

Settings under `jumpserverManager.*` (terminal settings update open panels immediately):

| Setting | Default | Description |
| --- | --- | --- |
| `jumpserverManager.terminalFontSize` | `14` | Terminal font size in pixels (minimum `8`). |
| `jumpserverManager.terminalFontFamily` | `"Cascadia Code, Menlo, monospace"` | CSS font family list for xterm.js. |
| `jumpserverManager.scrollback` | `5000` | Terminal scrollback buffer line count (minimum `100`). |
| `jumpserverManager.semanticHighlight` | `true` | Enable semantic highlighting on terminal output. |
| `jumpserverManager.idleDisconnectMinutes` | `60` | Disconnect inactive terminals after N minutes (`0` disables idle timeout). |
| `jumpserverManager.kokoBearerHandshake` | `false` | Directly attach `Authorization: Bearer` on KoKo 5.0 WebSocket handshake (experimental, falls back to ticket on HTTP 401). |

## AT Series MCP (split-out hub)

Starting with the AT Series Hub adaptation, **the MCP server is no longer shipped as a per-plugin `mcp-server.js` / Language Model Tools entry inside this extension**.

The shared MCP runtime was extracted into the npm package **[`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub)** and is introduced as a normal dependency:

```json
"dependencies": {
  "@at-series/mcp-hub": "^0.3.4"
}
```

How it fits together:

| Piece | Role |
|-------|------|
| `@at-series/mcp-hub` (npm) | Shared hub process Protocol v2 → one IDE MCP server named **AT Series** → `node ~/.at-series/mcp/hub.js` |
| This extension | Local Bridge on `127.0.0.1` (`GET /health`, `GET /tools`, `POST /invoke`), registry publish under `~/.at-series/bridges/<hostApp>/`, syncs packaged `dist/hub.js` on activate |
| IDE config | `Install/Repair AT Series MCP Config` (Kiro, Cursor, Continue) |

Credentials stay in the extension host; the hub and MCP client never read JumpServer passwords or VS Code secret storage.

Architecture: [ADR-001](docs/decisions/ADR-001-at-series-mcp-hub.md). Sibling reference: [at-terminal-series hub adaptation](https://github.com/xwamt/At-Terminal/blob/main/docs/decisions/ADR-005-at-series-hub-adaptation.md).

Agent skill: [`at-jumpserver-terminal-mcp`](skills/at-jumpserver-terminal-mcp/SKILL.md).

## SFTP Development Probe

Before changing the SFTP implementation, validate a real JumpServer instance with `npm run probe:sftp`. The probe reads `JUMPSERVER_BASE_URL`, `JUMPSERVER_USERNAME`, `JUMPSERVER_PASSWORD`, and `JUMPSERVER_ASSET_ID` from the environment.

JumpServer KoKo SFTP is constrained by the asset platform's configured SFTP root. On the tested instance, `/` and `/tmp` resolve to the same file area and paths such as `/home` or `/etc` do not expose the server filesystem. Change the platform SFTP root in JumpServer if a different managed root is required.

## SFTP Preview And Edit

Use `Preview` on a file to open a read-only cached copy. Use `Edit` on a file to open an extension-owned local cache file; the first save asks whether to enable automatic sync for that edit session, and later saves upload automatically after sync is enabled.

Before each upload, the extension compares the current remote stat with the stat captured when the edit session opened. If the remote file changed, choose whether to overwrite the remote file or cancel the upload. Files larger than 1 MB and binary-like files are blocked from preview/edit; use `Download` for those files.

## Development

```powershell
npm install
npm test
npm run typecheck
npm run build
```

## Manual Verification

- Configure a real JumpServer account.
- Refresh assets and verify node or zone grouping.
- Connect to an SSH asset.
- Connect a second SSH asset on the same bastion and confirm the Output channel logs `REST bearer reused` rather than a second login.
- After SSH connect, confirm Files shows a pending placeholder until Refresh.
- Run `whoami`, `pwd`, and `ls`.
- Connect to a MySQL asset.
- Run `select 1;` at the MySQL prompt.
- Connect to a Redis asset.
- Run `PING` at the Redis prompt.
- Open files for an SFTP-capable SSH asset.
- Navigate into a directory and back up.
- Upload a small text file.
- Download the file and compare content.
- Rename and delete the test file.
- Create and delete a test directory.
- Preview a small text file and confirm it opens read-only.
- Edit a small text file, save once, and confirm the sync prompt appears.
- Enable sync and confirm the file uploads after save.
- Modify the remote file externally and confirm the conflict prompt appears on the next save.
- Try preview/edit on a binary or over-1 MB file and confirm it suggests Download.
- Verify an asset without SFTP shows a clear unsupported message.
- Resize the terminal.
- Disconnect and reconnect.
- Verify bad password and non-SSH assets show clear errors.
- Verify unsupported database assets show clear errors and do not open a GUI.
- Verify MCP `jumpserver_run_terminal_command` returns command stdout (not only echoes) after confirmation.
- Verify MCP `jumpserver_redis_execute_command` runs `PING` and rejects `SUBSCRIBE`.
- Verify asset context menu includes **Copy Host IP**.
