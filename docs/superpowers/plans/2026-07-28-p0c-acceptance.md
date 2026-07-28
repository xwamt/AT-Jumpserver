# P0c Acceptance Checklist — AT JumpServer Series Hub Adaptation

**Date:** 2026-07-28  
**Worktree:** `C:\Users\alan\Desktop\at-jumpserver-series\.worktrees\p0c-hub`  
**Branch:** `feature/p0c-hub`  
**HEAD (pre-report):** `020113420259577204278649b2ac278cd45e63e5`  
**Verifier:** automated checklist run (Task 12)

## Status: DONE_WITH_CONCERNS

All P0c product criteria pass. Concerns are limited to pre-existing `mcp-hub` working-tree dirt (out of scope) and optional Extension Host smoke (not run).

---

## Checklist

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | `jumpserver-plugins` unmodified | **PASS** | `git -C C:\Users\alan\Desktop\jumpserver-plugins status` → `nothing to commit, working tree clean` (branch `main`, HEAD `d923e5e`) |
| 2 | `at-jumpserver-series` independent git; no old remote | **PASS** | `git rev-parse --show-toplevel` → worktree root; `git remote -v` → empty; `git config remote.origin.url` → none |
| 3 | `mcp-hub` sources not modified by this work | **PASS (out-of-scope dirt noted)** | P0c commits touch only `at-jumpserver-series` (no mcp-hub source paths). Separate repo `C:\Users\alan\Desktop\at-series-mcp-hub\packages\mcp-hub` has **pre-existing** local modifications (`README.md`, `docs/guides/plugin-integration.md`, `packages/mcp-hub/*`) — not introduced by `feature/p0c-hub`; not restored per scope |
| 4 | No `languageModelTools` in `package.json` | **PASS** | `package.json` `contributes` has no `languageModelTools`; `test/package.manifest.test.ts` asserts `manifest.contributes.languageModelTools` is `undefined` |
| 5 | Build has no product dependency on `dist/mcp-server.js` | **PASS** | `esbuild.config.mjs` entry points: `src/extension.ts`, webview bundles only — no `mcp-server` entry. `npm run build` exit 0. After deleting stale `dist/mcp-server.js`, rebuild does **not** recreate it (`CREATED_BY_BUILD: no`). Outputs: `dist/extension.js`, `dist/hub.js`, `dist/hub-version.json` |
| 6 | Bridge serves `/health`, `/tools`, `/invoke` | **PASS** | `src/mcp/BridgeServer.ts` routes at L219–231. `test/mcp/BridgeServer.test.ts`: 12 tests including `/health`, `/tools`, `POST /invoke` |
| 7 | Registry under `~/.at-series/bridges` | **PASS** | `test/mcp/bridgePublish.test.ts` L56–101: publishes to `join(home, '.at-series', 'bridges', hostApp)`, removes on dispose |
| 8 | Installer writes **AT Series**; migrates **AT JumpServer Terminal** | **PASS** | `test/mcp/McpConfigInstaller.test.ts` L32–76: removes legacy `AT JumpServer Terminal` mcp-server entry, writes `MCP_SERVER_DISPLAY_NAME` with `hubJsPath`, keeps `other-server` |
| 9 | `autoApprove` excludes write/exec incl. both send_inputs | **PASS** | `test/mcp/McpConfigInstaller.test.ts` L78–106: excludes `jumpserver_send_terminal_input`, `jumpserver_mysql_send_input`, all catalog `exec`/`write` tools |
| 10 | `sendTerminalInput` / `mysqlSendInput` confirm tests green | **PASS** | `test/agent/JumpServerAgentToolService.test.ts` L74–145: confirm required when cancelled; succeeds after confirm. Targeted run: 8/8 pass |
| 11 | `mysqlExecuteSql` skips confirm for read-only SQL | **PASS** | `src/agent/JumpServerAgentToolService.ts` L184–189: confirm only when `!isReadOnlySql(sql)`. `test/agent/SqlSafety.test.ts`: 14/14 pass (SELECT/SHOW/DESC/EXPLAIN safe). Dangerous SQL confirm: `JumpServerAgentToolService.test.ts` L53–60 |
| 12 | Full `npm test` + `typecheck` + `build` pass | **PASS** | `npm run typecheck` exit 0; `npm test` 34 files / 211 tests pass; `npm run build` exit 0 |

### Optional (not run)

| Criterion | Result | Notes |
|-----------|--------|-------|
| Extension Host manual smoke | **NOT RUN** | No VS Code Extension Host session exercised in this verification |

---

## Command transcript (summary)

```text
# jumpserver-plugins
git -C C:\Users\alan\Desktop\jumpserver-plugins status
→ working tree clean

# at-jumpserver-series worktree
git remote -v                          → (empty)
git rev-parse HEAD                     → 0201134...
npm run typecheck                      → exit 0
npm test                               → 34 passed, 211 tests
npm run build                          → exit 0; hub.js copied (0.1.1)

# esbuild entries (no mcp-server)
rg entryPoints esbuild.config.mjs
→ src/extension.ts, webview/* only

# stale artifact check
Remove-Item dist/mcp-server.js; npm run build
→ CREATED_BY_BUILD: no

# targeted P0c tests
npx vitest run test/agent/JumpServerAgentToolService.test.ts \
  test/agent/SqlSafety.test.ts test/mcp/McpConfigInstaller.test.ts \
  test/mcp/bridgePublish.test.ts test/mcp/BridgeServer.test.ts
→ 5 files, 39 tests passed

# mcp-hub (separate repo, out of scope)
git -C C:\Users\alan\Desktop\at-series-mcp-hub\packages\mcp-hub status --porcelain
→ pre-existing M/?? on README, docs, package.json, LICENSE
```

---

## Code citations

**Bridge routes** (`src/mcp/BridgeServer.ts`):

```219:231:src/mcp/BridgeServer.ts
      if (path === '/health' && (method === 'GET' || method === 'POST')) {
        return json(200, await buildHealthResponse(dependencies, pluginDisplayName));
      }

      if (path === '/tools' && method === 'GET') {
        return json(200, {
          protocolVersion: AT_SERIES_PROTOCOL_VERSION,
          tools: AT_JUMPSERVER_TOOL_CATALOG
        });
      }

      if (path === '/invoke' && method === 'POST') {
        return await handleInvoke(dependencies, request.body);
      }
```

**Read-only SQL policy** (`src/agent/JumpServerAgentToolService.ts`):

```184:189:src/agent/JumpServerAgentToolService.ts
    if (!isReadOnlySql(sql)) {
      const ok = await this.dependencies.confirm(`Run state-changing MySQL SQL on ${target.asset.name}?\n\n${sql}`);
      if (!ok) {
        throw new Error('MySQL SQL execution was cancelled.');
      }
    }
```

---

## Concerns (non-blocking)

1. **`@at-series/mcp-hub` source repo** has unrelated local dirt; P0c branch did not modify it.
2. **Stale `dist/mcp-server.js`** may linger from pre-P0c builds until cleaned; current build pipeline does not produce it.
3. **Extension Host smoke** deferred — unit/integration tests only.

---

## Commit

This report is committed on `feature/p0c-hub` with message:

`docs: record P0c acceptance checklist evidence`

Post-commit SHA recorded below after commit.
