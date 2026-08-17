# Task 0 Notes: Redis `db_client` Connection Facts

Date: 2026-08-05  
Branch: `feature/jumpserver-redis-terminal`  
Status: Probe not run — credentials unavailable

## Starting Payload (assumed from approved spec)

The Redis token payload mirrors the MySQL `db_client` template in `src/jumpserver/JumpServerClient.ts`:

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

Account field rule matches MySQL: `account.alias || account.id` (see `buildMysqlConnectionTokenPayload`).

MySQL reference (`DEFAULT_MYSQL_CONNECT_OPTIONS`):

```ts
export const DEFAULT_MYSQL_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;
```

No deviation from the starting payload is recorded because the live probe was not executed.

## Probe Not Run

Attempted to locate JumpServer credentials used for prior manual testing in this repo:

| Source | Result |
| --- | --- |
| Shell env (`JUMPSERVER_BASE_URL`, `JUMPSERVER_USERNAME`, `JUMPSERVER_PASSWORD`) | Not set |
| Worktree `.env` | Not present |
| VS Code / Cursor `settings.json` | No `jumpserverManager.*` or `JUMPSERVER_*` entries |
| Extension globalStorage | No stored config found |

The worktree also lacks a `tools/` directory (main repo has `tools/probe-jumpserver-sftp.mjs`); a Redis probe script does not exist yet.

## Implications

- **Unit implementation may proceed** using the starting payload above.
- **Real Redis terminal verification is not complete.** Do not claim Task 0 live verification until:
  1. A Redis asset is identified in JumpServer (`category` / `type` / `platform` / `protocolNames`).
  2. Connection token creation succeeds with `protocol: "redis"` + `connect_method: "db_client"`.
  3. KoKo redis-cli accepts `PING` and ECHO marker commands.
- **Task 9 status (2026-08-05):** Manual acceptance still blocked — no JumpServer credentials in the environment. Unit/integration suite is green (264 tests). Live probe checklist below remains outstanding before claiming production Redis support.
- If live probing later shows `db_client` is rejected for Redis, stop connection-path work and revise the design (do not fall back to `web_gui`).

## Probe Checklist (for Task 9 or when credentials become available)

1. Set `JUMPSERVER_BASE_URL`, `JUMPSERVER_USERNAME`, `JUMPSERVER_PASSWORD` (and optional `JUMPSERVER_ORG_ID`).
2. List assets; pick one with Redis in `protocolNames` or database metadata.
3. POST `/api/v1/authentication/connection-token/` with the payload above.
4. Open KoKo terminal WebSocket; run `PING`, `ECHO __JMS_REDIS_START_probe__`, `ECHO __JMS_REDIS_END_probe__`.
5. Update this file if `connect_options` or account field rules differ from the starting payload.
