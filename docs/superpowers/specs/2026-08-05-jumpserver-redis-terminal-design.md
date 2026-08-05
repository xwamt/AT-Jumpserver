# JumpServer Redis Terminal And MCP Design

Date: 2026-08-05
Status: Approved for implementation planning

## Goal

Add Redis asset connection support to AT JumpServer Terminal using the same terminal-client path as MySQL, and expose an agent-friendly Redis command execution tool through MCP. In the same delivery, converge MCP list/send tools so JumpServer does not grow one context/input tool per protocol.

## Decisions

- Reuse the existing xterm.js `TerminalPanel` and KoKo WebSocket session path. Do not add a Redis GUI, key browser, TTL editor, or workbench.
- Connect Redis assets with JumpServer `protocol: "redis"` and `connect_method: "db_client"`. Do not launch a local `redis-cli` binary. Do not fall back to `web_gui`.
- Keep a single Assets tree. Route by asset metadata: SSH, MySQL, Redis, or unsupported.
- Do not expose account or Redis DB-index selection in the extension. JumpServer permissions and returned account data decide whether the asset can connect. Session-level `SELECT n` stays in the redis-cli session.
- Structure protocol handling as a minimal symmetric extension of the MySQL terminal path (`connectionKinds`, token builder, executor, safety). Do not invent a generic database framework in this release.
- MCP list/context uses one tool: `jumpserver_get_terminal_context` (already returns all sessions with `connectionKind`).
- MCP send-input uses one tool: `jumpserver_send_terminal_input` for every connection kind.
- MCP execute remains protocol-specific: SSH `jumpserver_run_terminal_command`, MySQL `jumpserver_mysql_execute_sql`, Redis `jumpserver_redis_execute_command`.
- Delete `jumpserver_mysql_get_context` and `jumpserver_mysql_send_input` in the same delivery (breaking change). Do not leave deprecated aliases.
- Redis execute supports one non-blocking command per call. Blocking/subscription commands are rejected before any terminal write.
- Capture Redis CLI output with ECHO start/end markers, mirroring MySQL/SSH marker executors.
- Confirm policy mirrors MySQL: read-only heuristic commands skip confirm; other commands require confirm; unified send-input always confirms.
- Ship Redis connection, Redis execute tool, and MySQL list/send removal in one delivery.
- Before implementation coding of the connection path, run Task 0 against a real JumpServer Redis asset and record verified token/`connect_options`/ECHO behavior in the implementation plan or an addendum to this spec.

## Non-Goals

- Redis GUI / key tree / value editor / TTL visualization.
- Valkey / KeyDB special-case recognition (unless JumpServer metadata already looks like `redis`).
- Unified fat `jumpserver_execute` that branches shell/SQL/redis internally.
- Dedicated MCP tools for `MONITOR` / pub-sub.
- SFTP for Redis assets.
- Local `redis-cli` execution.
- Account picker or connect-time DB index UI.
- Pipeline / multi-command batches in one `redis_execute_command` call.
- PostgreSQL, Oracle, SQL Server, or other database protocols beyond Redis.

## Relationship To Existing Specs

- Extends [2026-05-27 MySQL terminal connection design](2026-05-27-mysql-terminal-connection-design.md): same terminal-client model; Redis was previously listed as unsupported and is now in scope.
- Amends [2026-05-28 JumpServer MCP design](2026-05-28-jumpserver-mcp-design.md) tool set: remove MySQL-specific get-context/send-input; add Redis execute; keep unified terminal context/send-input.
- Does not revive [2026-05-15 MySQL GUI](2026-05-15-jumpserver-mysql-gui.md).

## Architecture

```
Assets tree
  → getAssetConnectionKind() ∈ {ssh, mysql, redis, unsupported}
  → TerminalPanel (title: JumpServer Redis: <name>)
  → JumpServerSession
       detail check (redis protocol)
       account resolve (alias || id)
       token: protocol=redis, connect_method=db_client
       smart endpoint → KoKo WS (JMS-KOKO)
  → TerminalContextRegistry (connectionKind: redis)

MCP (AT Series Hub → bridge → JumpServerAgentToolService)
  → jumpserver_get_terminal_context     (all kinds)
  → jumpserver_send_terminal_input      (all kinds, always confirm)
  → jumpserver_redis_execute_command    (redis only → RedisCliExecutor)
```

MCP never creates Redis connections. The IDE terminal must already be connected.

## Asset Recognition And Tree Behavior

Extend `src/jumpserver/connectionTypes.ts`:

- `JumpServerConnectionKind = 'ssh' | 'mysql' | 'redis' | 'unsupported'`
- `JumpServerConnectionProtocol = 'ssh' | 'mysql' | 'redis'`
- `isRedisAsset(asset)` mirrors `isMysqlAsset`:
  - `protocolNames` / `type` / `platform` / `category` contain `redis`, or
  - asset is a database asset and its **name** clearly contains `redis`
- `getAssetConnectionKind` order: MySQL → Redis → SSH → unsupported
- Redis remains inside `isDatabaseAsset` so it is never treated as an SSH host candidate
- Other databases (PostgreSQL, Oracle, SQL Server, etc.) stay `unsupported`

Tree item behavior:

- Same `JumpServer: Connect` command
- Distinct `contextValue`: `jumpserverRedisAsset`
- Description / tooltip identify Redis
- Panel title: `JumpServer Redis: <asset name>`
- Unsupported assets remain visible; connecting them keeps the existing unsupported message

SFTP:

- Redis assets must not open SFTP automatically
- Existing `assetMaySupportSftp` logic should continue to exclude redis-only protocol sets

## Connection Flow

Entry point remains `jumpserverManager.connect`.

1. Resolve connection kind from cached asset metadata.
2. Open unified `TerminalPanel`.
3. `JumpServerSession.connect()` loads fresh `getAssetDetail(asset.id)`.
4. Validate expected protocol: Redis requires `redis` in asset detail protocols.
5. Resolve usable account from `permed_accounts` / `accounts` using the same preferences as MySQL (prefer `has_secret`, prefer usable alias, account token value `alias || id`, `input_username` from username/name/alias).
6. Create connection token via a Redis-specific payload builder branched from the MySQL `db_client` template.
7. Resolve smart endpoint, warm up KoKo page if required, open KoKo terminal WebSocket.
8. Reuse existing TERMINAL_INIT / DATA / RESIZE / PING behavior.

### Redis Token Payload (starting point; Task 0 may adjust `connect_options`)

```json
{
  "asset": "<asset id>",
  "account": "<account alias or id>",
  "protocol": "redis",
  "input_username": "<account username/name/alias>",
  "input_secret": "",
  "connect_method": "db_client",
  "connect_options": {
    "token_reusable": false,
    "disableautohash": false
  }
}
```

If JumpServer rejects or ignores parts of `connect_options`, keep the minimal set proven by Task 0 and document the final payload in the implementation plan.

Failure policy:

- Missing redis protocol: `Selected asset does not expose Redis protocol.`
- `db_client` unavailable / token creation fails for Redis terminal client: `Redis terminal client connection is not available for this asset.`
- No usable account: existing no-account wording
- Never fall back to Chen / `web_gui`

## MCP Tool Surface

### Keep / extend

| Tool | Role |
| --- | --- |
| `jumpserver_list_assets` | Unchanged; `connectionKind` may be `redis` |
| `jumpserver_get_terminal_context` | Single list/context tool for SSH, MySQL, and Redis. Snapshot already includes `connectionKind`. |
| `jumpserver_send_terminal_input` | Single send-input tool for every kind. Always confirm. Target by `terminalId` or active connected terminal. |
| `jumpserver_run_terminal_command` | SSH only |
| `jumpserver_mysql_execute_sql` | MySQL only |
| `jumpserver_redis_execute_command` | **New.** Redis only |
| SFTP tools | Unchanged; still SSH-oriented |

### Delete (breaking)

| Tool | Replacement |
| --- | --- |
| `jumpserver_mysql_get_context` | `jumpserver_get_terminal_context` (filter client-side by `connectionKind === "mysql"` if needed) |
| `jumpserver_mysql_send_input` | `jumpserver_send_terminal_input` |

Update in lockstep: `toolCatalog.ts`, `BridgeProtocol.ts`, `bridgeSchemas.ts`, `BridgeServer.ts`, `JumpServerAgentToolService`, skill `skills/at-jumpserver-terminal-mcp/SKILL.md`, Hub/docs contract tests, and e2e coverage.

### `jumpserver_redis_execute_command`

Request:

- `terminalId?` — omit or `"active"` resolves active terminal; must be connected Redis
- `command` — required, single non-blocking Redis command string
- `timeoutMs?` — default aligned with MySQL/SSH execute (30s; hard max 120s)
- `maxOutputBytes?` — default 64KB; hard max 256KB

Response:

- `terminalId`, `assetId`, `assetName`, `command`, `output`, `durationMs`, `timedOut`, `truncated`

Runtime:

1. Resolve connected Redis terminal (kind check).
2. Reject blocking/subscription commands before write.
3. Confirm when command is not read-only.
4. Enqueue per-terminal so parallel MCP calls cannot interleave markers.
5. `RedisCliExecutor` wraps with ECHO markers and collects bounded output.

## Safety

### Blocking / session-poisoning commands (hard reject)

Match the first command verb (case-insensitive). If matched, throw a clear error and **do not write** to the terminal. Suggest using the open Redis terminal with `jumpserver_send_terminal_input`.

Initial reject set:

- `SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE`, `UNSUBSCRIBE`, `PUNSUBSCRIBE`, `SUNSUBSCRIBE`
- `MONITOR`
- `BLPOP`, `BRPOP`, `BRPOPLPUSH`, `BLMOVE`, `BRMOVE`
- `BZPOPMIN`, `BZPOPMAX`
- `XREAD` / `XREADGROUP` when arguments include `BLOCK` (heuristic)
- `SUBSCRIBE`-family and `MONITOR` take priority even if followed by other tokens

Exact matcher details belong in `RedisSafety` unit tests. Prefer false positives (reject) over poisoning the shared session.

### Read-only commands (skip confirm)

Treat as read-only when the command verb (and safe subcommand where relevant) is in a whitelist. Initial whitelist:

- String/key: `GET`, `MGET`, `EXISTS`, `TTL`, `PTTL`, `TYPE`, `STRLEN`, `DUMP`, `OBJECT`, `MEMORY USAGE` (and other `MEMORY` read subcommands if clearly read-only)
- Hash: `HGET`, `HMGET`, `HGETALL`, `HEXISTS`, `HLEN`, `HKEYS`, `HVALS`, `HSTRLEN`, `HSCAN`
- List: `LRANGE`, `LLEN`, `LINDEX`, `LPOS`
- Set: `SMEMBERS`, `SCARD`, `SISMEMBER`, `SMISMEMBER`, `SRANDMEMBER`, `SSCAN`
- ZSet: `ZRANGE`, `ZRANGEBYSCORE`, `ZRANGEBYLEX`, `ZREVRANGE`, `ZREVRANGEBYSCORE`, `ZCARD`, `ZSCORE`, `ZRANK`, `ZREVRANK`, `ZCOUNT`, `ZLEXCOUNT`, `ZSCAN`
- Stream read-meta: `XLEN`, `XINFO`, `XRANGE`, `XREVRANGE` (not blocking `XREAD`)
- Server introspect: `PING`, `ECHO`, `INFO`, `DBSIZE`, `TIME`, `ROLE`, `LASTSAVE`
- Scan: `SCAN`

Explicitly **not** read-only (require confirm), even if “mostly observational”:

- `KEYS` (can stress production)
- `SET`, `DEL`, `FLUSHDB`, `FLUSHALL`, `CONFIG`, `SHUTDOWN`, `DEBUG`, `MIGRATE`, `RESTORE`, `REPLICAOF`, `SLAVEOF`, `SCRIPT`, `EVAL`, `FUNCTION`, ACL mutations, etc.

Anything not on the read-only whitelist requires confirm.

### Unified send-input

`jumpserver_send_terminal_input` always confirms for every connection kind, matching today’s SSH/MySQL send-input behavior.

## RedisCliExecutor

Mirror `MysqlCliExecutor` / `ShellTerminalExecutor`:

```text
ECHO __JMS_REDIS_START_<id>__
<user command>
ECHO __JMS_REDIS_END_<id>__
```

- Collect output between markers via existing terminal output buffer helpers
- Honor `timeoutMs` / `maxOutputBytes`
- Internal marker `ECHO` commands are executor plumbing, not user-facing MCP commands, and do not go through the user confirm path separately from the user command decision already made

Task 0 must verify ECHO marker visibility in JumpServer’s redis-cli. If ECHO is unsuitable, replace the marker command in implementation without changing the MCP tool contract, and document the substitute in the plan.

## Error Handling

| Condition | Behavior |
| --- | --- |
| Asset detail lacks redis | `Selected asset does not expose Redis protocol.` |
| Redis `db_client` unavailable | `Redis terminal client connection is not available for this asset.` |
| Unsupported DB asset connect | Existing unsupported message |
| MCP execute without connected Redis | Clear error: connect a Redis asset first |
| MCP execute targeting wrong kind | Clear error requiring a Redis terminal |
| Blocking command via execute | Hard reject; no terminal write |
| User cancels confirm | Cancelled error, no write |
| Timed out / truncated capture | Return flags `timedOut` / `truncated` as with MySQL |

Terminal panel surfaces connection failures through existing status/notice behavior.

## Testing Plan

### Unit

- Redis asset detection from protocols/type/platform/category/name; MySQL and SSH routing unchanged; other DBs remain unsupported
- Tree context/description/title distinguish Redis
- Token payload uses `protocol: "redis"` and `connect_method: "db_client"`; account prefers alias
- Session protocol validation for redis
- `RedisSafety` read-only / confirm / hard-reject cases (including `KEYS` confirm and `SUBSCRIBE` reject)
- `RedisCliExecutor` marker wrapping and output collection
- Tool catalog / protocol unions: Redis execute present; MySQL get-context/send-input absent
- Agent service: unified context includes redis kind; send-input works for redis; execute enforces kind

### Docs / skill / Hub contract

- Update JumpServer MCP skill tables and workflows
- Update docs tests that assert tool names and confirm policy

### Manual / Task 0

1. Verify Redis `db_client` token creation and KoKo terminal against a real asset; record final payload
2. Verify ECHO markers in that redis-cli
3. Connect from Assets tree; run `PING` / simple `GET`/`SET` in the panel
4. Resize, disconnect, reconnect
5. MCP: read-only execute without confirm friction appropriate to policy; write command confirms; `SUBSCRIBE` rejected
6. Confirm `tools/list` no longer exposes deleted MySQL list/send tools
7. Confirm SSH and MySQL still work after the tool-surface change

## Implementation Touchpoints

Expected primary files:

- `src/jumpserver/connectionTypes.ts`
- `src/jumpserver/types.ts`
- `src/jumpserver/JumpServerClient.ts`
- `src/jumpserver/JumpServerSession.ts`
- `src/tree/TreeItems.ts`
- `src/extension.ts` / `package.json` (menus `when` clauses if needed)
- `src/agent/TerminalExecutors.ts`
- `src/agent/RedisSafety.ts` (new)
- `src/agent/JumpServerAgentToolService.ts`
- `src/mcp/toolCatalog.ts`
- `src/mcp/BridgeProtocol.ts`
- `src/mcp/bridgeSchemas.ts`
- `src/mcp/BridgeServer.ts`
- `skills/at-jumpserver-terminal-mcp/SKILL.md`
- Corresponding unit/e2e/docs tests under `test/`

## Open Implementation Check (Task 0)

Implementation planning must start with a real JumpServer Redis asset probe:

1. Confirm asset metadata shape (`category`/`type`/`platform`/`protocolNames`)
2. Confirm connection-token accepts `protocol: "redis"` + `connect_method: "db_client"`
3. Confirm minimal `connect_options`
4. Confirm interactive redis-cli over KoKo behaves like MySQL CLI sessions for input/output
5. Confirm `ECHO` markers (or document a replacement marker command)

If Task 0 fails, stop and revise this design before claiming Redis terminal support is implementable as specified. Do not silently switch to GUI fallback.
