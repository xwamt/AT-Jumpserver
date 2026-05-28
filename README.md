# AT JumpServer Terminal

AT JumpServer Terminal is a VS Code extension for opening browser-style JumpServer SSH and MySQL terminal sessions from the editor.

## Supported In This Version

- Username and password login to JumpServer
- Listing the current user's permitted assets
- SSH protocol assets
- MySQL protocol assets through JumpServer `db_client`
- xterm.js terminal UI
- JumpServer KoKo WebSocket terminal sessions

## Not Supported In This Version

- Ahell backend integration
- Direct SSH through ssh2
- SFTP or remote file editing
- MCP and Agent tools
- MySQL GUI/workbench, Chen SQL editor, schema browser, or result grid
- RDP, PostgreSQL, Redis, Oracle, SQL Server, Kubernetes, or other non-SSH/non-MySQL assets
- SSO, MFA, captcha, private token, or access key login

## Setup

1. Open the AT JumpServer activity bar.
2. Run `JumpServer: Configure`.
3. Enter JumpServer base URL, username, password, optional org ID, TLS verification, and timeout.
4. Run `JumpServer: Validate Account`.
5. Run `JumpServer: Refresh Assets`.
6. Click an SSH or MySQL asset to connect in a terminal.

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
- Resize the terminal.
- Disconnect and reconnect.
- Verify bad password and non-SSH assets show clear errors.
- Verify unsupported database assets show clear errors and do not open a GUI.
