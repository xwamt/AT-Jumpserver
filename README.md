# AT JumpServer Terminal

AT JumpServer Terminal is a VS Code / Cursor extension for opening browser-style JumpServer SSH, MySQL, and Redis terminal sessions from the editor.

**Current version: 0.1.8**

## Supported In This Version

- Username and password login to JumpServer
- Listing the current user's permitted assets
- SSH protocol assets
- MySQL protocol assets through JumpServer `db_client`
- Redis protocol assets through JumpServer `db_client`
- SFTP file tree for permitted assets
- SFTP upload, download, new folder, rename, delete, copy path, and directory navigation through JumpServer KoKo
- SFTP preview for small text files
- SFTP edit sessions with first-save sync confirmation and conflict prompts
- Copy Host IP from the asset list context menu
- xterm.js terminal UI
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
3. Enter JumpServer base URL, username, password, and TLS verification. Org ID can stay empty.
4. Run `JumpServer: Validate Account`. If the account can see more than one organization, pick one; the Default organization is saved automatically only on a reserved single-org deployment. An empty org ID with more than one organization prompts on Validate and Refresh rather than silently mixing inventories.
5. Run `JumpServer: Refresh Assets`.
6. Click an SSH, MySQL, or Redis asset to connect in a terminal.
7. Connect to an SSH asset, then use the Files view for the terminal-backed SFTP session.
8. Optional: run `Install/Repair AT Series MCP Config` to expose JumpServer tools to MCP-capable agents.

## AT Series MCP (split-out hub)

Starting with the AT Series Hub adaptation, **the MCP server is no longer shipped as a per-plugin `mcp-server.js` / Language Model Tools entry inside this extension**.

The shared MCP runtime was extracted into the npm package **[`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub)** and is introduced as a normal dependency:

```json
"dependencies": {
  "@at-series/mcp-hub": "^0.1.1"
}
```

How it fits together:

| Piece | Role |
|-------|------|
| `@at-series/mcp-hub` (npm) | Shared hub process Protocol v1 → one IDE MCP server named **AT Series** → `node ~/.at-series/mcp/hub.js` |
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
