# JumpServer MySQL GUI Workbench Spec

## Status
Approved for implementation planning.

## Date
2026-05-15

## Objective
Add MySQL database asset support to the existing AT JumpServer VS Code extension.

Users should be able to select a JumpServer-authorized MySQL database asset from the asset tree and open a VS Code-native query workbench. The extension must not ask for or store direct database credentials. It must connect through JumpServer's authorized WebDB flow using Chen.

Success means:

- MySQL database assets are shown in the tree alongside existing SSH assets.
- SSH assets continue to open the current terminal panel.
- MySQL database assets open a database workbench panel.
- The workbench can list schemas/tables and execute SQL through JumpServer Chen.
- A basic `select 1` query returns result rows through the JumpServer connection path.

## Research Result
The JumpServer API and Chen flow were verified against `https://jms.intimfy.com` on 2026-05-15 with scripts in `tools/research`.

Verified behavior:

- JumpServer advertises MySQL `web_gui` via component `chen`.
- The user asset API returns database assets with `category=database` and `type=mysql`.
- A `web_gui` connection token can be created for a MySQL asset.
- Chen `/chen/api/auth` accepts the JumpServer connection token id and returns a Chen session token.
- Chen requires `Accept-Language`; without it, `/chen/api/auth` can return `HTTP 200` with an empty body because its exception resolver swallows non-Chen exceptions.
- Chen session must be activated by keeping `/chen/ws/session` open until `set_ready`; before that `/chen/api/profile` returns `401`.
- After session activation, `/chen/api/resources/children` returns schema tree data.
- `/chen/ws/console` can run `select 1` and returns `update_data_view` with rows.

Working SQL proof:

```json
{
  "fields": ["1"],
  "rows": [{"1": "1"}]
}
```

Primary source references inspected locally:

- Chen frontend auth call: `chen/frontend/src/api/app.js`
- Chen controller flow: `chen/backend/web/src/main/java/org/jumpserver/chen/web/controller/AuthController.java`
- Chen session interceptor: `chen/backend/web/src/main/java/org/jumpserver/chen/web/interceptor/SessionInterceptor.java`
- Chen session websocket: `chen/backend/framework/src/main/java/org/jumpserver/chen/framework/ws/SessionWebSocketHandler.java`
- Chen console websocket: `chen/backend/framework/src/main/java/org/jumpserver/chen/framework/ws/ConsoleWebSocketHandler.java`
- Chen query packets: `chen/backend/framework/src/main/java/org/jumpserver/chen/framework/console/QueryConsole.java`
- Luna Chen iframe URL: `luna/src/app/elements/content/content-window/default/default.component.ts`
- JumpServer connect methods: `jumpserver/apps/terminal/connect_methods.py`

## Tech Stack
Existing extension stack:

- TypeScript
- VS Code Extension API
- Webviews
- Monaco Editor for the MySQL SQL editor
- Vitest
- esbuild
- `ws` for extension-host WebSocket clients
- `zod` for validation

No database driver dependency should be added for v1. MySQL access is mediated by JumpServer Chen HTTP/WebSocket APIs.

## Commands
Run from repository root:

```powershell
npm test
npm run typecheck
npm run build
python -m py_compile tools\research\probe_jumpserver_mysql_webgui.py tools\research\inspect_jumpserver_database_methods.py
```

Manual JumpServer probe:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins\tools\research
$env:JMS_BASE_URL='https://jms.example.com'
$env:JMS_USERNAME='<username>'
$env:JMS_PASSWORD='<password>'
$env:JMS_ASSET_ID='<mysql-asset-id>'
$env:JMS_SQL='select 1'
python probe_jumpserver_mysql_webgui.py
```

## Scope
V1 includes:

- MySQL asset detection from JumpServer permitted assets.
- MySQL connection method discovery or hardening around advertised `chen/web_gui`.
- Database session lifecycle through Chen:
  - create JumpServer connection token
  - call `/chen/api/auth`
  - keep `/chen/ws/session` open
  - load `/chen/api/profile`
  - load `/chen/api/resources/children`
  - open `/chen/ws/console`
  - execute SQL with `query_console_action/run_sql`
- Workbench webview:
  - top connection/status bar
  - left database/schema/table tree
  - Monaco SQL editor
  - execute button
  - result table
  - error/message area
- Read/write SQL execution is allowed. The extension does not block writes; JumpServer ACLs remain the source of truth.
- Redaction for JumpServer tokens, Chen tokens, cookies, and passwords.

V1 excludes:

- Direct MySQL TCP connections.
- Asking the user for DB username/password.
- Visual row editing.
- Multiple query tabs.
- Custom SQL autocomplete beyond Monaco's built-in SQL editing support.
- Query history.
- CSV export.
- Transaction UI.
- Explain plan.
- Local password/key storage for database credentials.
- Redis/PostgreSQL/Oracle/SQL Server workbench support.

## Project Structure
Expected new or modified areas:

- `src/jumpserver/JumpServerClient.ts`: extend existing REST client for database assets and Chen auth/token helpers.
- `src/jumpserver/JumpServerDatabaseSession.ts`: Chen HTTP/WebSocket session lifecycle and SQL execution API.
- `src/jumpserver/databaseTypes.ts`: typed contracts for Chen resources, console packets, query results, and session status.
- `src/tree/JumpServerTreeProvider.ts`: allow database assets and route protocol-specific connect behavior.
- `src/webview/MysqlWorkbenchPanel.ts`: VS Code webview panel wrapper for MySQL workbench.
- `webview/mysql-workbench/index.ts`: workbench frontend message handling and rendering.
- `webview/mysql-workbench/index.css`: workbench styling.
- `test/jumpserver/JumpServerDatabaseSession.test.ts`: session packet and lifecycle tests.
- `test/webview/MysqlWorkbenchPanel.test.ts`: panel rendering and message tests.
- `tools/research/*.py`: keep as research probes, not production code.

## Interface Design
The extension-host database API should be narrow and explicit:

```ts
export interface DatabaseSession {
  connect(): Promise<DatabaseProfile>;
  listChildren(parentKey?: string): Promise<DatabaseResourceNode[]>;
  executeSql(sql: string, contextKey?: string): Promise<QueryResult>;
  dispose(): void;
}

export interface QueryResult {
  fields: QueryField[];
  rows: Record<string, unknown>[];
  title: string;
  messages: QueryMessage[];
}
```

The webview should not know JumpServer token details. It sends UI commands such as:

- `ready`
- `refreshTree`
- `expandNode`
- `executeSql`
- `changeContext`
- `dispose`

The extension host sends view models such as:

- `statusChanged`
- `treeLoaded`
- `queryStarted`
- `queryResult`
- `queryError`

## Chen Flow
For MySQL assets, the production flow must follow the verified sequence:

1. Authenticate to JumpServer REST if needed.
2. Fetch asset detail.
3. Select a permitted account. For normal user `connection-token`, send the account alias. Luna uses `account.alias`; admin direct mode is the path that sends account id.
4. Create connection token:

```json
{
  "asset": "<assetId>",
  "account": "<accountAlias>",
  "protocol": "mysql",
  "input_username": "<accountUsername>",
  "input_secret": "",
  "connect_method": "web_gui",
  "connect_options": {
    "token_reusable": false,
    "disableautohash": false
  }
}
```

5. Call:

```text
POST /chen/api/auth
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
body: {"token":"<connectionToken.id>","disableAutoHash":false}
```

6. Keep `/chen/ws/session` open with the Chen token as WebSocket subprotocol.
7. Wait for `set_ready`.
8. Call `/chen/api/profile` and `/chen/api/resources/children` with header `token: <chenToken>`.
9. Open `/chen/ws/console` with the same Chen token as WebSocket subprotocol.
10. Send:

```json
{"type":"connect","data":{"nodeKey":"datasource:root","type":"query"}}
```

11. After `init`, execute:

```json
{"type":"query_console_action","data":{"action":"run_sql","data":"select 1"}}
```

12. Parse `new_data_view`, `update_data_view`, `message`, `log`, and `update_state`.

## Code Style
Follow existing extension style:

- TypeScript modules use focused classes and exported interfaces.
- Extension host owns credentials and tokens.
- Webviews receive sanitized view models only.
- Third-party API responses are parsed defensively before use.
- Errors crossing UI boundaries are redacted.

Example:

```ts
const packet = parseChenPacket(raw);
if (packet.type === 'update_data_view') {
  return toQueryResult(packet.data);
}
if (packet.type === 'message') {
  throw new JumpServerDatabaseError(redactChenMessage(packet.data));
}
```

## Testing Strategy
Unit tests should not require a real JumpServer.

Required tests:

- Detect MySQL assets from `category/type/platform` even when `protocols` is empty.
- Build MySQL `web_gui` connection-token payload with account alias.
- Send `Accept-Language` for Chen auth.
- Require session websocket `set_ready` before profile/resource calls.
- Parse Chen schema tree.
- Parse `update_data_view` into fields and rows.
- Surface Chen `message` packets as query errors.
- Keep SSH terminal routing unchanged.
- Route MySQL assets to `MysqlWorkbenchPanel`.
- Redact connection token id/value, Chen token, Bearer token, cookies, and password.

Manual tests:

- Refresh assets and confirm MySQL database assets appear.
- Open a MySQL asset and see schemas.
- Run `select 1`; verify one row returns.
- Run a schema-qualified simple query.
- Disconnect and confirm both session and console websockets close.
- SSH assets still open terminal and work as before.

## Boundaries
Always:

- Use JumpServer authorization as the source of truth.
- Keep database credentials inside JumpServer/Chen only.
- Keep `/chen/ws/session` open while the workbench is active.
- Redact all tokens and passwords in logs/errors.
- Preserve existing SSH terminal behavior.

Ask first:

- Adding support for non-MySQL database types.
- Adding direct database TCP drivers.
- Adding write-safety blocks or SQL allow/deny rules in the extension.
- Persisting query history or result data.

Never:

- Store direct database passwords.
- Print real tokens, cookies, or passwords.
- Bypass JumpServer ACLs.
- Reuse expired connection tokens.
- Revert unrelated user changes in the worktree.

## Success Criteria
- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- Existing terminal tests continue to pass.
- MySQL database asset opens a workbench.
- Non-MySQL database assets remain visible but show a clear unsupported message until implemented.
- Workbench can list schemas from Chen resources.
- Workbench can run `select 1` and display rows.
- Workbench cleans up Chen session and console websockets on close.
- README no longer says database assets are unsupported after feature implementation.

## Resolved Decisions
- SQL editor: use Monaco in v1.
- Asset tree: keep all assets returned by JumpServer visible. SSH assets open the terminal, MySQL database assets open the workbench, unsupported asset types show a clear unsupported message.
- Query timeout: use Chen's default `30s` in v1; do not add a user setting yet.
