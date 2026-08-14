# AT JumpServer Terminal VS Code Plugin Design

## Status
Approved for implementation planning.

## Date
2026-05-13

## Goal
Build a standalone VS Code plugin in the same product family as `C:\Users\alan\Desktop\ssh-plugins`. The frontend terminal UI must stay effectively unchanged, while the backend terminal transport is replaced with a Node.js implementation of Ahell's JumpServer connection method.

The plugin must not depend on the Ahell backend. It connects directly to JumpServer from the VS Code extension host.

## Decisions

- Product name: `AT JumpServer Terminal`.
- Project shape: create a new standalone plugin directory at `C:\Users\alan\Desktop\jumpserver-plugins`.
- Implementation baseline: copy the `ssh-plugins` structure and keep the existing terminal webview UI.
- First version scope: terminal-only.
- Authentication: JumpServer username and password only.
- Asset source: fetch the logged-in user's permitted JumpServer assets.
- Asset protocol: SSH assets only.
- User connection flow: the user selects only an asset; no target account picker is shown.
- Technical account handling: use the current JumpServer login account for product semantics. If JumpServer's connection-token API requires an account field, the connection layer automatically uses the first usable account returned by the asset detail API. The code should leave room to probe account-less token creation later.

## Non-Goals

- No Ahell backend integration.
- No direct SSH connection through `ssh2`.
- No SFTP, remote file tree, remote file editing, MCP, or Agent tools in the first version.
- No RDP, database, Kubernetes, or non-SSH JumpServer asset support.
- No SSO, MFA, captcha, private token, access key, or session-cookie login in the first version.
- No visible UI for selecting target asset accounts.

## Architecture

Reuse the existing terminal UI and message protocol from `ssh-plugins`:

- Keep `webview/terminal/*`.
- Keep the terminal webview shape currently represented by `TerminalPanel`.
- Replace the SSH session implementation with a JumpServer session implementation.

Core modules:

- `src/jumpserver/JumpServerClient.ts`: REST login, asset APIs, connection-token creation, smart endpoint lookup, web login warmup, KoKo WebSocket connection.
- `src/jumpserver/JumpServerSession.ts`: terminal session adapter with `connect`, `write`, `resize`, and `dispose`.
- `src/config/JumpServerConfigManager.ts`: stores base URL, org ID, TLS and timeout settings in VS Code global state; stores password in SecretStorage.
- `src/tree/JumpServerTreeProvider.ts`: renders permitted assets grouped by JumpServer node path or zone.
- `src/webview/JumpServerConfigPanel.ts`: built-in configuration form for JumpServer settings.
- `src/webview/TerminalPanel.ts`: reused terminal panel with a session factory that creates `JumpServerSession`.

The `TerminalPanel` should continue talking to sessions through this minimal shape:

```ts
interface TerminalSessionLike {
  connect(): Promise<void>;
  write(data: string): void;
  resize(rows: number, cols: number): void;
  dispose(): void;
}
```

## Configuration

The plugin provides a built-in configuration form. Fields:

- `baseUrl`: JumpServer base URL, such as `https://jumpserver.example.com`.
- `orgId`: optional JumpServer organization header value.
- `username`: JumpServer username.
- `password`: JumpServer password, stored only in VS Code SecretStorage.
- `verifyTls`: default `true`.
- `connectTimeout`: REST and connection timeout.

Storage rules:

- Non-secret settings are stored in VS Code global state.
- Password is stored in SecretStorage under a plugin-specific key.
- Bearer tokens, cookies, and connection tokens are kept in memory only.
- Logs and user-facing errors must redact passwords, Bearer tokens, cookies, and connection-token IDs before display or persistence.

## Asset Sync And Tree

The plugin fetches assets with:

```text
GET /api/v1/perms/users/self/assets/?limit=200&offset=0
```

Requests include:

```text
Authorization: Bearer <token>
Accept: application/json
X-JMS-ORG: <orgId>  # only when configured
```

Assets are normalized into:

- `id`
- `name`
- `address`
- `platform`
- `category`
- `type`
- `zoneName`
- `nodePath`
- `protocolNames`
- sanitized raw metadata for detail caching

Tree grouping:

1. Use `nodePath` when present.
2. Use `zoneName` when `nodePath` is absent.
3. Fall back to `Default`.

Asset node display:

- Label: asset name.
- Description: address, or platform when address is missing.
- Connect command appears on asset nodes.

The plugin caches sanitized asset metadata in global state for fast startup. Refresh overwrites the cache.

## Connection Flow

When the user connects to an asset:

1. Authenticate to JumpServer REST:

   ```text
   POST /api/v1/authentication/auth/
   body: {"username":"...","password":"..."}
   ```

2. Fetch asset detail:

   ```text
   GET /api/v1/perms/users/self/assets/{assetId}/
   ```

3. Confirm the asset exposes SSH through `permed_protocols` or `protocols`.

4. Create a connection token using the Ahell-proven shape:

   ```json
   {
     "asset": "<assetId>",
     "account": "<autoAccountId>",
     "protocol": "ssh",
     "input_username": "<autoAccountUsername>",
     "input_secret": "",
     "connect_method": "web_cli",
     "connect_options": {
       "charset": "default",
       "disableautohash": false,
       "token_reusable": false,
       "resolution": "auto",
       "backspaceAsCtrlH": false,
       "appletConnectMethod": "web",
       "virtualappConnectMethod": "web",
       "reusable": false,
       "rdp_connection_speed": "auto"
     }
   }
   ```

   The account is selected internally from the first usable `permed_accounts` or `accounts` entry. This is an implementation detail and is not shown to users.

5. Fetch smart endpoint:

   ```text
   GET /api/v1/terminal/endpoints/smart/?protocol=https&token=<tokenId>
   ```

6. Bootstrap the authenticated KoKo web session:

   - `GET /core/auth/login/?next=/koko/connect/`
   - parse `csrfmiddlewaretoken`
   - `POST /core/auth/login/?next=/koko/connect/`
   - follow a bounded number of redirects
   - `GET /api/v1/users/profile/`
   - `GET /koko/connect/?disableautohash=false&token=<tokenId>&_=<timestamp>`

7. Open KoKo WebSocket:

   ```text
   wss://<endpointHost>:<httpsPort>/koko/ws/terminal/?disableautohash=false&token=<tokenId>&_=<timestamp>
   ```

   Required behavior:

   - Subprotocol: `JMS-KOKO`.
   - Origin: JumpServer browser origin.
   - Include authenticated cookies from the web login flow.
   - Respect `verifyTls`.

8. Initialize terminal after KoKo sends `CONNECT`:

   ```json
   {
     "id": "<messageId>",
     "type": "TERMINAL_INIT",
     "data": "{\"cols\":80,\"rows\":24,\"code\":\"\"}"
   }
   ```

9. Forward terminal traffic:

   - Webview `input` -> KoKo `TERMINAL_DATA`.
   - Webview `resize` -> KoKo `TERMINAL_RESIZE`.
   - KoKo terminal bytes/data -> existing webview `outputBytes` or `output` messages.

## Status And Errors

The terminal status model keeps the existing UI but uses JumpServer-specific stages:

- `Authenticating`
- `Loading asset`
- `Creating connection token`
- `Opening KoKo terminal`
- `Connected`
- `Disconnected`

Expected error behavior:

- Missing config: prompt the user to configure JumpServer.
- Login failure: show an authentication failure without exposing credentials.
- TLS or network errors: show a concise readable error and mention TLS verification when relevant.
- No assets: show an empty asset tree with a non-fatal message.
- Non-SSH asset: block connection and explain that SSH protocol is unavailable.
- No usable account in asset detail: show a connection error. Do not ask the user to pick an account.
- Token creation failure: surface a redacted JumpServer API error summary.
- KoKo warmup redirect: report that KoKo web session authentication failed.
- WebSocket close: mark disconnected and write a red terminal notice.
- User disconnect: close the KoKo WebSocket and write `Connection disconnected`.

Reconnect should run a fresh connection-token flow. The first version does not perform infinite automatic reconnect.

## Testing

Unit tests should avoid requiring a real JumpServer.

Test areas:

- REST login request and Bearer header handling.
- Asset pagination and normalization.
- Asset tree grouping by `nodePath`, `zoneName`, and `Default`.
- Asset detail SSH protocol detection.
- Connection-token payload matches the Ahell-proven shape.
- Smart endpoint request parameters.
- KoKo URL construction for `wss` and `ws`.
- CSRF token parsing from login HTML.
- KoKo `CONNECT` causes `TERMINAL_INIT`.
- Webview input maps to `TERMINAL_DATA`.
- Webview resize maps to `TERMINAL_RESIZE`.
- Upstream terminal bytes map to unchanged terminal output UI messages.
- ConfigManager stores password only in SecretStorage.
- Redaction hides passwords, tokens, cookies, and connection-token IDs in logs/errors.

Manual verification with a real JumpServer:

- Configure JumpServer and validate credentials.
- Refresh asset tree.
- Connect to an SSH asset.
- Run interactive commands such as `whoami`, `pwd`, and `ls`.
- Resize the terminal and confirm output remains usable.
- Disconnect and reconnect.
- Verify bad password, no assets, and non-SSH asset cases show clear messages.

## Open Implementation Notes

- The first implementation should prioritize the account-included connection-token payload because it matches the current Ahell implementation.
- The code should isolate connection-token payload construction so account-less probing can be added without changing UI flows.
- Sanitized asset cache must avoid storing secrets or credential material from JumpServer raw payloads.
- The old SSH/SFTP/MCP code should be removed or left unregistered in the new plugin so users do not see unsupported commands.
