# MySQL Terminal Connection Design

Date: 2026-05-27
Status: Approved for implementation planning

## Goal

Add MySQL asset connection support to the JumpServer VS Code extension while keeping the client experience terminal-based. MySQL must not use the existing GUI/workbench experience. Users should connect from the existing JumpServer assets tree, open an xterm.js terminal panel, and interact with the JumpServer-provided MySQL terminal client.

## Decisions

- Keep a single `Assets` tree. Do not add a separate database view.
- Route assets by their JumpServer asset type/protocol. SSH assets open SSH terminals; MySQL assets open MySQL terminals.
- Reuse the existing xterm.js terminal panel for MySQL. Do not add a MySQL workbench or SQL GUI panel.
- Use JumpServer's MySQL `db_client` connection method for terminal client sessions.
- Do not launch a local `mysql` binary from the extension.
- Do not expose account selection in the extension. JumpServer permissions and returned account data decide whether the asset can connect.
- Structure protocol handling so other database protocols can be added later, but only MySQL is implemented in the first release.

## Reference Implementation Boundary

The worktree at `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-mysql-gui` contains a previously tested MySQL connection implementation. Implementation must inspect that worktree for connection facts, especially:

- MySQL/database asset detection behavior.
- Account reference fields such as `id`, `alias`, `username`, `name`, and `has_secret`.
- Connection token payload shape and minimal `connect_options`.

Only connection facts should be reused. The GUI/workbench implementation, Chen panel behavior, SQL result rendering, and database browser UX are out of scope for this terminal-client feature.

Note: the existing worktree contains a GUI-oriented `web_gui` path. This feature targets terminal-based MySQL and must use the verified `db_client` route or confirm the exact terminal-client payload before implementation.

## Asset Recognition And Tree Behavior

The extension keeps the existing JumpServer `Assets` tree and cached asset model. Refresh continues to load permitted assets and store `protocolNames`, `category`, `type`, `platform`, `name`, and other metadata.

Routing rules:

- MySQL asset: asset detail or cached metadata indicates `mysql`, such as `protocolNames` containing `mysql`, `type/platform` containing MySQL or MariaDB, or a database asset whose name clearly identifies MySQL.
- SSH asset: asset exposes `ssh` and is not recognized as MySQL.
- Unsupported asset: any other protocol or database type, including PostgreSQL, Redis, Oracle, SQL Server, or unknown assets.

MySQL and SSH assets are different JumpServer assets even when they have the same IP address, so the extension does not need a protocol chooser when opening an asset.

Tree item behavior:

- Continue using the same `JumpServer: Connect` command.
- MySQL tree items should be visibly distinguishable through description, tooltip, or context value.
- Unsupported assets remain visible. Connecting them shows a clear unsupported message.

Panel title behavior:

- SSH: `JumpServer SSH: <asset name>` or equivalent existing SSH title.
- MySQL: `JumpServer MySQL: <asset name>`.

## Connection Flow

The existing `jumpserverManager.connect` command remains the entry point.

1. Resolve the asset connection kind from the asset metadata.
2. Create the unified terminal panel.
3. `JumpServerSession.connect()` loads fresh asset detail with `getAssetDetail(asset.id)`.
4. The session validates the expected protocol:
   - SSH requires `ssh`.
   - MySQL requires `mysql`.
5. The session resolves a usable JumpServer account from `permed_accounts` or `accounts`.
6. The session creates a connection token:
   - SSH: `protocol: "ssh"`, `connect_method: "web_cli"`.
   - MySQL: `protocol: "mysql"`, `connect_method: "db_client"`.
7. The session gets the smart endpoint for the token.
8. The session opens the KoKo terminal WebSocket.
9. Terminal initialization, input, resize, ping/pong, output, disconnect, and reconnect reuse the current xterm.js flow.

The extension does not fall back from MySQL `db_client` to Chen/Web GUI. If `db_client` is not available, connection fails with a targeted message.

## Account Resolution

The extension does not ask the user to choose a database account. JumpServer controls whether the logged-in user can connect.

Account resolution should support the fields observed in the existing tested worktree:

- Prefer an account with `has_secret === true` when available.
- Prefer non-virtual aliases when the API returns aliases.
- Use `account.alias` for MySQL token account value when present, falling back to `account.id`.
- Use `username`, `name`, or `alias` for `input_username`, in that order.

If no usable account is returned, keep the existing failure behavior with a clear message that no usable JumpServer account was returned for the asset.

## MySQL Token Payload

MySQL terminal-client connection token payload should be:

```json
{
  "asset": "<asset id>",
  "account": "<account alias or id>",
  "protocol": "mysql",
  "input_username": "<account username/name/alias>",
  "input_secret": "",
  "connect_method": "db_client",
  "connect_options": {
    "token_reusable": false,
    "disableautohash": false
  }
}
```

Before implementation, verify the final `db_client` payload against the tested connection path in `.worktrees\jumpserver-mysql-gui` and JumpServer behavior. If JumpServer requires additional `connect_options` for `db_client`, document and test those additions.

## Error Handling

Expected user-facing failures:

- MySQL asset detail does not expose `mysql`: `Selected asset does not expose MySQL protocol.`
- SSH asset detail does not expose `ssh`: `Selected asset does not expose SSH protocol.`
- MySQL `db_client` token creation fails: `MySQL terminal client connection is not available for this asset.`
- Unsupported database assets: `Asset type is not supported yet: <asset name>.`
- No usable account: keep the existing no-account error wording.

The terminal panel should surface connection failures through existing status and terminal notice behavior.

## Testing Plan

Unit tests should cover:

- MySQL asset detection from `protocolNames`, `category`, `type`, `platform`, and database asset name markers.
- SSH asset detection still routes SSH assets normally.
- Unsupported database assets remain visible but do not open a terminal connection.
- Tree item context/description distinguishes MySQL from SSH.
- Connection token payloads:
  - SSH uses `web_cli`.
  - MySQL uses `db_client`.
  - MySQL account value prefers alias over id.
- `JumpServerSession` validates the selected protocol and sends the expected token request.
- MySQL terminal sessions still send `TERMINAL_INIT`, `TERMINAL_DATA`, `TERMINAL_RESIZE`, and PING/PONG messages using the existing KoKo terminal WebSocket path.
- `TerminalPanel` title and status metadata distinguish MySQL from SSH.

Manual verification should cover:

- Refresh assets with real JumpServer credentials.
- Confirm MySQL and SSH assets both appear in the same tree.
- Connect to an SSH asset and run a shell command.
- Connect to a MySQL asset and run `select 1;` in the terminal prompt.
- Resize, disconnect, and reconnect the MySQL terminal.
- Confirm unsupported database assets show a clear message and do not open a GUI.

## Out Of Scope

- MySQL GUI/workbench panel.
- Chen Web GUI connection flow.
- Schema browser, table browser, SQL editor, SQL history, result grid, autocomplete, or export.
- Local `mysql` binary execution.
- PostgreSQL, Redis, Oracle, SQL Server, and other database protocols.
- Account selection UI.

## Open Implementation Check

Implementation planning must begin by reading the MySQL connection code in `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-mysql-gui` and confirming the terminal-client `db_client` connection details. If the worktree only verifies `web_gui`, implementation must validate `db_client` with JumpServer before claiming MySQL terminal support is complete.
