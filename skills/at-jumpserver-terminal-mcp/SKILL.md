---
name: at-jumpserver-terminal-mcp
description: Use when an agent needs to work through AT JumpServer Terminal MCP for JumpServer SSH terminals, SFTP files, MySQL CLI sessions, or SQL execution.
---

# AT JumpServer Terminal MCP

Use AT JumpServer Terminal MCP as the bridge between an agent and the user's already-configured JumpServer extension runtime. The MCP sidecar never reads passwords, cookies, JumpServer tokens, or VS Code secret storage.

## Preconditions

Keep the IDE window with AT JumpServer Terminal running and activated. The MCP client starts `node dist/mcp-server.js`, and that sidecar connects back to the local bridge hosted by the extension.

Prefer the command palette action `JumpServer: Install MCP Config` for Kiro, Cursor, and Continue.

## Tool Selection

| Need | Use |
| --- | --- |
| List JumpServer assets | `jumpserver_list_assets` |
| Resolve current terminal | `jumpserver_get_terminal_context` |
| Send interactive terminal input | `jumpserver_send_terminal_input` |
| Run non-interactive SSH command | `jumpserver_run_terminal_command` |
| Browse remote files | `jumpserver_sftp_list_directory` |
| Inspect remote file metadata | `jumpserver_sftp_stat_path` |
| Read remote text | `jumpserver_sftp_read_file` |
| Write remote files | `jumpserver_sftp_write_file`, `jumpserver_sftp_create_file`, `jumpserver_sftp_create_directory`, `jumpserver_sftp_rename`, `jumpserver_sftp_delete` |
| Resolve MySQL terminals | `jumpserver_mysql_get_context` |
| Execute SQL | `jumpserver_mysql_execute_sql` |
| Interact with MySQL CLI manually | `jumpserver_mysql_send_input` |

## Workflow

1. Use `jumpserver_get_terminal_context` before targeting active terminals.
2. Use `jumpserver_list_assets` to discover JumpServer asset IDs.
3. Use SFTP read/stat before write.
4. Use `jumpserver_mysql_execute_sql` for SQL and `jumpserver_mysql_send_input` only for interactive cases.
5. Do not read local VS Code secret storage.
6. Do not confuse `AT Terminal MCP` with `AT JumpServer Terminal MCP`; their bridge files and tool names are intentionally different.
