# AT JumpServer Terminal

AT JumpServer Terminal is a VS Code extension for opening browser-style JumpServer SSH and MySQL terminal sessions from the editor.

## Supported In This Version

- Username and password login to JumpServer
- Listing the current user's permitted assets
- SSH protocol assets
- MySQL protocol assets through JumpServer `db_client`
- SFTP file tree for permitted assets
- SFTP upload, download, new folder, rename, delete, copy path, and directory navigation through JumpServer KoKo
- xterm.js terminal UI
- JumpServer KoKo WebSocket terminal sessions

## Not Supported In This Version

- Ahell backend integration
- Direct SSH through ssh2
- Remote file editing and save-to-upload sync
- MCP and Agent tools
- MySQL GUI/workbench, Chen SQL editor, schema browser, or result grid
- RDP, PostgreSQL, Redis, Oracle, SQL Server, Kubernetes, or other non-SSH/non-MySQL assets
- SSO, MFA, captcha, private token, or access key login

## Setup

1. Open the AT JumpServer activity bar.
2. Run `JumpServer: Configure`.
3. Enter JumpServer base URL, username, password, optional org ID, and TLS verification.
4. Run `JumpServer: Validate Account`.
5. Run `JumpServer: Refresh Assets`.
6. Click an SSH or MySQL asset to connect in a terminal.
7. Use `JumpServer: Open Files` on an SFTP-capable asset to browse and manage files.

## SFTP Development Probe

Before changing the SFTP implementation, validate a real JumpServer instance with `npm run probe:sftp`. The probe reads `JUMPSERVER_BASE_URL`, `JUMPSERVER_USERNAME`, `JUMPSERVER_PASSWORD`, and `JUMPSERVER_ASSET_ID` from the environment.

JumpServer KoKo SFTP is constrained by the asset platform's configured SFTP root. On the tested instance, `/` and `/tmp` resolve to the same file area and paths such as `/home` or `/etc` do not expose the server filesystem. Change the platform SFTP root in JumpServer if a different managed root is required.

## Phase Two Direction

Remote file editing is intentionally reserved for a later phase. The current SFTP layer already exposes `stat`, `readFile`, `writeFile`, and `createFile` interfaces so a future edit workflow can download into an extension-owned cache, detect remote changes before upload, and sync saved files back through KoKo without reshaping the first-phase file manager.

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
- Open files for an SFTP-capable SSH asset.
- Navigate into a directory and back up.
- Upload a small text file.
- Download the file and compare content.
- Rename and delete the test file.
- Create and delete a test directory.
- Verify an asset without SFTP shows a clear unsupported message.
- Resize the terminal.
- Disconnect and reconnect.
- Verify bad password and non-SSH assets show clear errors.
- Verify unsupported database assets show clear errors and do not open a GUI.
