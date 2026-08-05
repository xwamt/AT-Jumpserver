---
name: at-jumpserver-terminal-mcp
description: Use when an agent needs to work through AT JumpServer Terminal MCP for JumpServer SSH terminals, SFTP files, MySQL CLI sessions, Redis CLI sessions, or SQL/Redis command execution.
---

# AT JumpServer Terminal MCP

Use AT JumpServer Terminal MCP as the bridge between an agent and the user's already-configured JumpServer extension runtime. The MCP sidecar never reads passwords, cookies, JumpServer tokens, or VS Code secret storage.

## Preconditions

Keep the IDE window with AT JumpServer Terminal running and activated so the extension can publish its bridge into `~/.at-series`. MCP clients configure a single **AT Series** entry that runs `node ~/.at-series/mcp/hub.js`; the hub routes invokes to the extension bridge. The hub never reads passwords, cookies, JumpServer tokens, or VS Code secret storage.

Prefer the command palette action `Install/Repair AT Series MCP Config` for Kiro, Cursor, and Continue. If `hub.js` is missing, reload the IDE window so hub sync can elect the packaged `dist/hub.js`.

## Tool Selection

| Need | Use |
| --- | --- |
| List JumpServer assets | `jumpserver_list_assets` |
| Resolve current terminal (SSH, MySQL, Redis) | `jumpserver_get_terminal_context` |
| Send interactive terminal input (SSH, MySQL, Redis) | `jumpserver_send_terminal_input` |
| Run non-interactive SSH command | `jumpserver_run_terminal_command` |
| Browse remote files | `jumpserver_sftp_list_directory` |
| Inspect remote file metadata | `jumpserver_sftp_stat_path` |
| Read remote text | `jumpserver_sftp_read_file` |
| Write remote files | `jumpserver_sftp_write_file`, `jumpserver_sftp_create_file`, `jumpserver_sftp_create_directory`, `jumpserver_sftp_rename`, `jumpserver_sftp_delete` |
| Execute SQL | `jumpserver_mysql_execute_sql` |
| Execute Redis command | `jumpserver_redis_execute_command` |

## Payload Discipline

Keep tool results small so they fit agent context:

- **Commands / SQL / Redis:** default capture is **64KB** (hard max **256KB**). Prefer narrow commands (`grep`/`head`/`tail`), SQL with **`LIMIT`**, and targeted Redis keys (`GET`, `HGET`, `SCAN` with a pattern). If `truncated: true`, tighten the query — do **not** only raise `maxOutputBytes`.
- **Redis keys:** avoid `KEYS *`; prefer `SCAN` with a narrow pattern and small `COUNT`.
- **SFTP read:** default **64KB** / hard max **256KB**; oversized text returns truncated content (`truncated: true`) without buffering the whole remote file. Prefer `jumpserver_sftp_stat_path` first for large files.
- **SFTP list:** default **`maxEntries` 500**; if `truncated: true`, narrow the path or page deliberately.
- **Assets:** use `search` / `limit` / `offset` on `jumpserver_list_assets` instead of dumping the full cache.

## Workflow

1. Use `jumpserver_get_terminal_context` before targeting active terminals; filter by `connectionKind` (`ssh`, `mysql`, or `redis`) when you need a specific protocol.
2. Use `jumpserver_list_assets` to discover JumpServer asset IDs.
3. Prefer `jumpserver_run_terminal_command` for bounded non-interactive SSH work.
4. Prefer `jumpserver_mysql_execute_sql` for SQL with `LIMIT`; use `jumpserver_send_terminal_input` only for interactive MySQL CLI cases.
5. Prefer `jumpserver_redis_execute_command` for a single non-blocking Redis command; use `jumpserver_send_terminal_input` for interactive or blocking Redis CLI work (`SUBSCRIBE`, `MONITOR`, `BLPOP`, and similar).
6. Use SFTP read/stat before write.
7. Do not read local VS Code secret storage.
8. Do not confuse `AT Terminal MCP` with `AT JumpServer Terminal MCP`; their bridge files and tool names are intentionally different.
