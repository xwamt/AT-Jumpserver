# AT JumpServer Terminal

AT JumpServer Terminal is a VS Code extension for opening browser-style JumpServer SSH terminal sessions from the editor.

## Supported In This Version

- Username and password login to JumpServer
- Listing the current user's permitted assets
- SSH protocol assets
- xterm.js terminal UI
- JumpServer KoKo WebSocket terminal sessions

## Not Supported In This Version

- Ahell backend integration
- Direct SSH through ssh2
- SFTP or remote file editing
- MCP and Agent tools
- RDP, database, Kubernetes, or non-SSH JumpServer assets
- SSO, MFA, captcha, private token, or access key login

## Setup

1. Open the AT JumpServer activity bar.
2. Run `JumpServer: Configure`.
3. Enter JumpServer base URL, username, password, optional org ID, TLS verification, and timeout.
4. Run `JumpServer: Validate Account`.
5. Run `JumpServer: Refresh Assets`.
6. Click an asset to connect.

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
- Resize the terminal.
- Disconnect and reconnect.
- Verify bad password and non-SSH assets show clear errors.
