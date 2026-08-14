# JumpServer MCP Design

Date: 2026-05-28
Status: Approved for implementation planning

## Goal

Add MCP support to AT JumpServer Terminal while keeping the implementation aligned with the companion `ssh-plugins` project. The MCP feature must expose JumpServer SSH terminal, SFTP, and MySQL CLI capabilities through the connections that already exist in this extension. It must not conflict with the MCP service implemented by `C:\Users\alan\Desktop\ssh-plugins`.

## Decisions

- Use the same broad architecture as `ssh-plugins`: VS Code extension bridge, stdio MCP sidecar, bridge client, agent tool service, installer, tests, documentation, and skill file.
- Use JumpServer-specific MCP names, tool names, discovery files, and bridge authentication so this service can coexist with `ssh-plugins`.
- Do not read VS Code secrets, JumpServer passwords, cookies, or tokens from the MCP sidecar.
- Do not create a second direct SSH, SFTP, or MySQL implementation for MCP.
- Base all tools on the existing extension runtime:
  - SSH/MySQL terminal sessions use `TerminalPanel`, `JumpServerSession`, and `TerminalContextRegistry`.
  - SFTP uses `JumpServerSftpManager` and `JumpServerSftpSession`.
  - MySQL SQL execution uses the existing JumpServer MySQL CLI terminal session.
- Implement both MySQL terminal-level interaction and an agent-friendly SQL execution tool.
- Keep SQL output as bounded MySQL CLI text in the first release. Structured table parsing, schema browsing, and result grids are out of scope.

## Coexistence With `ssh-plugins`

The two MCP services must run side by side without sharing runtime resources.

AT Terminal from `ssh-plugins` currently uses names and resources such as:

- MCP/server identity around `AT Terminal`.
- Tool names such as `list_ssh_servers`, `get_terminal_context`, `run_remote_command`, and `sftp_read_file`.
- Discovery file `~/.at-terminal/mcp-bridge.json`.
- Bridge header `x-at-terminal-token`.
- A localhost dynamic bridge port.

AT JumpServer Terminal will use distinct equivalents:

- MCP/server identity: `AT JumpServer Terminal` / `at-jumpserver-terminal`.
- Tool names prefixed with `jumpserver_`.
- Discovery file `~/.at-jumpserver-terminal/mcp-bridge.json`.
- Bridge header `x-at-jumpserver-terminal-token`.
- A localhost dynamic bridge port allocated with `listen(0)`.

Because both bridges allocate dynamic ports and use separate discovery files and headers, the services can run in the same IDE session or separate IDE sessions without port, token, or tool-name collisions.

## Architecture

### Extension Bridge

Add `src/mcp/BridgeServer.ts`, `src/mcp/BridgeClient.ts`, `src/mcp/BridgeDiscovery.ts`, and `src/mcp/BridgeProtocol.ts`, following the structure of `ssh-plugins` but using JumpServer-specific names.

The extension host starts a bridge server on activation:

1. Generate a random bridge token.
2. Listen on `127.0.0.1` with port `0`.
3. Write `~/.at-jumpserver-terminal/mcp-bridge.json` with `{ port, token, pid, updatedAt }`.
4. Route bridge HTTP requests to `JumpServerAgentToolService`.
5. Remove the discovery file on dispose, but only if the file still belongs to the current bridge instance.

### MCP Stdio Server

Add `src/mcp/server.ts` and build it to `dist/mcp-server.js`.

The MCP server:

- Registers all `jumpserver_` tools.
- Reads the JumpServer bridge discovery file.
- Calls the local bridge over HTTP with the bridge token header.
- Returns JSON as text MCP content, matching the style of `ssh-plugins`.
- Fails clearly when the bridge is not running.

### Agent Tool Service

Add `src/agent/JumpServerAgentToolService.ts` and related helpers.

The service owns tool behavior and delegates to existing runtime objects:

- `JumpServerConfigManager` lists cached assets without secrets.
- `TerminalContextRegistry` lists active, connected, and known terminal contexts.
- `JumpServerSftpManager` performs SFTP operations.
- New terminal output capture helpers collect bounded output from existing KoKo terminal sessions.
- New SQL and command executors send marker-wrapped input to active JumpServer terminal sessions and collect output.

## Tool Set

All tool names use the `jumpserver_` prefix.

### Assets And Context

#### `jumpserver_list_assets`

Lists cached JumpServer assets. Each asset includes:

- `assetId`
- `name`
- `address`
- `platform`
- `category`
- `type`
- `protocolNames`
- `connectionKind`
- `nodePath`

The response must not include JumpServer password, auth token, cookies, connection token, or unsanitized raw fields.

#### `jumpserver_get_terminal_context`

Returns terminal context for JumpServer sessions:

- `activeTerminal`
- `connectedTerminals`
- `knownTerminals`

Each terminal includes:

- `terminalId`
- `assetId`
- `assetName`
- `address`
- `connectionKind: "ssh" | "mysql" | "unsupported"`
- `connected`

### SSH And Generic Terminal Tools

#### `jumpserver_send_terminal_input`

Sends raw input to a JumpServer terminal. Inputs:

- `terminalId`, or `"active"` to target the active terminal.
- `input`

This tool is intended for interactive use. It does not try to parse command output.

#### `jumpserver_run_terminal_command`

Runs a non-interactive shell command through an existing connected JumpServer SSH terminal. It does not create a direct SSH connection.

Inputs:

- `terminalId` or `"active"`
- `command`
- optional `cwd`
- optional `timeoutMs`
- optional `maxOutputBytes`

The command executor sends a shell wrapper with unique start and end markers, captures the output between markers, and returns:

- `terminalId`
- `assetId`
- `assetName`
- `command`
- optional `cwd`
- `stdout`
- `exitCode`
- `durationMs`
- `timedOut`
- `truncated`

Dangerous commands or commands without trusted auto-approval require a VS Code modal confirmation before execution.

### SFTP Tools

SFTP tools call the existing `JumpServerSftpManager` and use the active SFTP connection by default. They may also accept a `connectionKey` or `terminalId` to target a specific terminal-backed SFTP session.

Read tools:

- `jumpserver_sftp_list_directory`
- `jumpserver_sftp_stat_path`
- `jumpserver_sftp_read_file`

Write tools:

- `jumpserver_sftp_write_file`
- `jumpserver_sftp_create_file`
- `jumpserver_sftp_create_directory`
- `jumpserver_sftp_rename`
- `jumpserver_sftp_delete`

`jumpserver_sftp_read_file` returns bounded UTF-8 text and rejects binary-looking content. Write, create, rename, and delete tools require VS Code modal confirmation.

### MySQL Tools

#### `jumpserver_mysql_get_context`

Returns known and connected MySQL terminal contexts only. This helps agents choose a MySQL target without scanning all terminal sessions.

#### `jumpserver_mysql_send_input`

Sends raw input to a connected JumpServer MySQL CLI terminal. Inputs:

- `terminalId` or `"active"`
- `input`

This is the MySQL equivalent of raw terminal input and is intended for interactive workflows.

#### `jumpserver_mysql_execute_sql`

Executes SQL through an existing connected JumpServer MySQL CLI terminal.

Inputs:

- `terminalId` or `"active"`
- `sql`
- optional `timeoutMs`
- optional `maxOutputBytes`

The SQL executor sends marker-wrapped SQL:

```sql
SELECT '__JMS_SQL_START_<id>__';
<user sql>;
SELECT '__JMS_SQL_END_<id>__';
```

It captures bounded CLI output between the start and end markers and returns:

- `terminalId`
- `assetId`
- `assetName`
- `sql`
- `output`
- `durationMs`
- `timedOut`
- `truncated`

Clearly read-only SQL can run without a modal confirmation. SQL that may write data or change database state requires VS Code modal confirmation.

## Terminal Output Capture

`TerminalContextRegistry` currently tracks terminal contexts. For MCP command and SQL execution, it must retain all known contexts and expose a bounded output capture mechanism.

Each context should keep:

- `terminalId`
- asset metadata
- `connected`
- `write(data)`
- connection kind
- recent output buffer or an event stream suitable for bounded collection

`TerminalPanel` should publish terminal output to the registry before posting it to the webview. The buffer must be bounded to avoid unbounded memory growth.

Command and SQL executors use unique markers to avoid relying on arbitrary prompt text. They must collect only output that arrives after their command starts and stop on the matching end marker, timeout, disconnect, or output limit.

## Safety Model

### Allowed Without Modal Confirmation

- Listing assets and terminal context.
- SFTP list, stat, and bounded read.
- Clearly read-only SQL, such as `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, and `EXPLAIN`.

### Requires Modal Confirmation

- Raw terminal input when the tool is being used for non-obvious state-changing workflows.
- SSH shell commands unless a future trust setting explicitly allows auto-approval.
- Dangerous SSH commands, even if a future trust setting exists.
- SFTP write, create, rename, and delete.
- MySQL writes and database-changing SQL, including `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CALL`, `GRANT`, `REVOKE`, `SET`, `BEGIN`, `COMMIT`, `ROLLBACK`, `LOCK`, and `UNLOCK`.

The first release should not add a global setting that silently auto-approves write operations. It may reserve internal structure for future trust configuration.

## Error Handling

Expected errors should be specific and actionable:

- Bridge discovery missing: ask the user to open or reload VS Code with AT JumpServer Terminal MCP installed.
- Bridge unreachable: ask the user to reload the IDE window running AT JumpServer Terminal.
- JumpServer not configured: return the existing JumpServer configuration error.
- No matching terminal: ask the user to connect the relevant JumpServer asset first.
- No active SFTP connection: ask the user to open files from a JumpServer asset first.
- Non-SSH terminal used for shell command: explain that an SSH terminal is required.
- Non-MySQL terminal used for SQL: explain that a MySQL terminal is required.
- Command or SQL timeout: return partial output with `timedOut: true`.
- Output limit reached: return partial output with `truncated: true`.
- Binary SFTP content: reject with a text/binary guard error.

## Packaging And Installation

Add `@modelcontextprotocol/sdk` as a runtime dependency.

Update `esbuild.config.mjs` to build:

- `src/extension.ts -> dist/extension.js`
- `src/mcp/server.ts -> dist/mcp-server.js`
- existing webview bundles

Add a command:

- `jumpserverManager.installMcpConfig`
- Title: `JumpServer: Install MCP Config`

The installer should support the same client families as `ssh-plugins` where practical:

- Kiro
- Cursor
- Continue

Config server name:

- `AT JumpServer Terminal`

Config command:

- `node`

Config args:

- absolute path to this extension's `dist/mcp-server.js`

Auto-approval should include only read-oriented tools. The extension-side modal remains the final safety boundary for write or dangerous operations.

## Documentation And Skill

Update `README.md` to mention MCP support and the install command.

Add:

- `docs/mcp/continue-at-jumpserver-terminal-mcp.yaml`
- `skills/at-jumpserver-terminal-mcp/SKILL.md`

The skill should mirror the style of `ssh-plugins` `skills/at-terminal-mcp/SKILL.md`, but use JumpServer-specific names, config paths, and tools.

The skill must emphasize:

- Use `jumpserver_get_terminal_context` before targeting active terminals.
- Use `jumpserver_list_assets` to discover asset IDs.
- Use SFTP read/stat before write.
- Use MySQL `execute_sql` for SQL and `send_input` only for interactive cases.
- Do not read local VS Code secret storage.
- Do not confuse `AT Terminal MCP` with `AT JumpServer Terminal MCP`.

## Testing Plan

Unit tests:

- Bridge discovery reads and writes `~/.at-jumpserver-terminal/mcp-bridge.json`.
- Bridge discovery never reads or deletes `~/.at-terminal/mcp-bridge.json`.
- Bridge server listens on a dynamic port and routes all JumpServer endpoints.
- Bridge client reports missing or unreachable bridge clearly.
- MCP server registers all `jumpserver_` tools.
- MCP config installer writes `AT JumpServer Terminal` config and points to `dist/mcp-server.js`.
- Agent service lists assets without secrets.
- Terminal context returns active, connected, and known terminals with SSH/MySQL distinction.
- SSH command executor captures output between markers, handles exit code, timeout, and truncation.
- MySQL SQL classifier distinguishes read-only and state-changing SQL.
- MySQL SQL executor captures marker-bounded output, timeout, and truncation.
- SFTP tools route to `JumpServerSftpManager`.
- SFTP write/create/rename/delete require confirmation.
- SFTP read enforces max bytes and binary guards.

Verification commands:

```powershell
npm test
npm run typecheck
npm run build
```

Manual verification:

- Install the MCP build or local extension with `dist/mcp-server.js`.
- Install MCP config using `JumpServer: Install MCP Config`.
- Confirm `ssh-plugins` MCP and JumpServer MCP can both be configured and discovered.
- Call `jumpserver_list_assets`.
- Connect an SSH asset, then call `jumpserver_get_terminal_context`.
- Run a read-only SSH command through `jumpserver_run_terminal_command`.
- Open JumpServer SFTP files, then call SFTP list/stat/read tools.
- Try an SFTP write and confirm the VS Code modal appears.
- Connect a MySQL asset and run `jumpserver_mysql_execute_sql` with `select 1;`.
- Try a dangerous SQL statement and confirm the VS Code modal appears.

## Out Of Scope

- Independent MCP-side JumpServer login.
- Independent direct SSH, SFTP, or MySQL connections.
- Reading VS Code secrets from MCP.
- MySQL GUI/workbench.
- Schema browser, table browser, SQL autocomplete, result grid, export, or structured table parsing.
- PostgreSQL, Redis, Oracle, SQL Server, Kubernetes, or other non-SSH/non-MySQL protocol tools.
- Global auto-approval for write operations.

