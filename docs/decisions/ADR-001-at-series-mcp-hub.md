# ADR-001: AT Series Hub adaptation for at-jumpserver-series

## Status
Accepted

## Date
2026-07-28

## Context

AT JumpServer Terminal historically shipped a per-plugin stdio MCP entry (`dist/mcp-server.js`) and VS Code `languageModelTools`. The shared **AT Series MCP Hub** (Protocol v1) replaces that packaging model so multiple AT-family plugins share one IDE MCP entry and one hub process.

This repository (`at-jumpserver-series`) is the adapted product line for that hub migration.

## Decision

1. **Copied from `jumpserver-plugins`, original untouched.**  
   `at-jumpserver-series` was imported as an independent git history. Adaptation work happens only in this repo. The original `jumpserver-plugins` tree remains the untouched source product line.

2. **Consume `@at-series/mcp-hub` Protocol v1.**  
   Bridge HTTP exposes `health` / `tools` / `invoke`, authenticates with the series token header, publishes registry records under `~/.at-series/bridges/<hostApp>/`, and syncs/elects packaged `dist/hub.js` into `~/.at-series/mcp/hub.js`.

3. **Remove LM tools and per-plugin mcp-server.**  
   Product MCP packaging no longer contributes `languageModelTools` and no longer builds or ships `dist/mcp-server.js`. IDE MCP clients install a single **AT Series** entry that runs `node ~/.at-series/mcp/hub.js`. Installer migration removes legacy per-plugin `AT JumpServer Terminal` MCP entries. Default `autoApprove` includes only hub builtins and `read`-risk tools (excludes `exec` / `write`).

4. **Keep extension-host authority.**  
   `JumpServerAgentToolService` remains the execution and confirmation authority (remote-command confirmations, SFTP write authorization, `send_input` confirms).

## Related

- Canonical hub ADR: [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) — see `docs/decisions/ADR-001-at-series-mcp-hub.md` in the hub package repository
- Sibling adaptation: [at-terminal-series ADR-005](https://github.com/xwamt/At-Terminal/blob/main/docs/decisions/ADR-005-at-series-hub-adaptation.md)
- Design: [P0c design spec](../superpowers/specs/2026-07-28-p0c-jumpserver-hub-design.md)
- Implementation plan: [P0c plan](../superpowers/plans/2026-07-28-p0c-jumpserver-hub.md)

## Consequences

- Agents and IDEs target **AT Series**, not a per-plugin MCP server binary.
- `jumpserver-plugins` can continue independently; this repo does not require modifying it to ship hub adaptation.
- Docs and installer copy must keep describing AT Series-only MCP entry and hub paths under `~/.at-series`.
