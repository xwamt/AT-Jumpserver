---
name: at-jumpserver-terminal-mcp
description: >-
  Use when an agent needs JumpServer SSH terminals, SFTP, MySQL CLI, or SQL
  through AT Series MCP (pluginId at.jumpserver), including progressive
  discover → select → first-class call.
---

# AT JumpServer Terminal (via AT Series)

Entry is the MCP server **AT Series**, not a per-plugin MCP. Prefer the series skill `super-ops` (SuperOps) for Hub discovery; this skill adds JumpServer-specific tool choice.

## Discover → select → call

1. `at_list_providers` — confirm healthy `at.jumpserver`.
2. `at_select_tools` with `{ "mode": "replace", "pluginIds": ["at.jumpserver"] }`.
3. Refresh `tools/list` after `list_changed`, then call `jumpserver_*` tools.
4. `at_clear_tool_selection` (or `replace`) when the JumpServer task ends.

Keep the JumpServer IDE window open so the bridge stays published under `~/.at-series`.

## Tool selection

| Need | Use |
| --- | --- |
| List JumpServer assets | `jumpserver_list_assets` |
| Resolve current terminal | `jumpserver_get_terminal_context` |
| Send interactive terminal input | `jumpserver_send_terminal_input` |
| Run non-interactive SSH command | `jumpserver_run_terminal_command` |
| Browse remote files | `jumpserver_sftp_list_directory` |
| Inspect remote file metadata | `jumpserver_sftp_stat_path` |
| Read remote text | `jumpserver_sftp_read_file` |
| Write / mutate remote files | `jumpserver_sftp_write_file`, `jumpserver_sftp_create_file`, `jumpserver_sftp_create_directory`, `jumpserver_sftp_rename`, `jumpserver_sftp_delete` |
| Resolve MySQL terminals | `jumpserver_mysql_get_context` |
| Execute SQL | `jumpserver_mysql_execute_sql` |
| Interact with MySQL CLI manually | `jumpserver_mysql_send_input` |

## Payload discipline

Keep tool results small so they fit agent context:

- **Commands / SQL:** default capture is **64KB** (hard max **256KB**). Prefer narrow commands (`grep`/`head`/`tail`) and SQL with **`LIMIT`**. If `truncated: true`, tighten the query — do **not** only raise `maxOutputBytes`.
- **SFTP read:** default **64KB** / hard max **256KB**; oversized text returns truncated content (`truncated: true`) without buffering the whole remote file. Prefer `jumpserver_sftp_stat_path` first for large files.
- **SFTP list:** default **`maxEntries` 500**; if `truncated: true`, narrow the path or page deliberately.
- **Assets:** use `search` / `limit` / `offset` on `jumpserver_list_assets` instead of dumping the full cache.

## Workflow

1. Use `jumpserver_get_terminal_context` before targeting active terminals.
2. Use `jumpserver_list_assets` (with search/pagination when needed) to discover asset IDs.
3. Prefer `jumpserver_run_terminal_command` for bounded non-interactive work; use send-input only when interactivity is required.
4. Use SFTP read/stat before write/delete/rename.
5. Use `jumpserver_mysql_execute_sql` for SQL with LIMIT; `jumpserver_mysql_send_input` only for interactive cases.
6. Never read local IDE secret storage, cookies, or JumpServer tokens.
7. Do not confuse AT Terminal short names (`list_ssh_servers`, …) with `jumpserver_*`.
