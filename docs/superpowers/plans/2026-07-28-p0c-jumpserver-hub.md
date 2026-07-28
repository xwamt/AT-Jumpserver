# P0c AT JumpServer Series Hub Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish P0c in `C:\Users\alan\Desktop\at-jumpserver-series`: adapt JumpServer MCP to AT Series Hub Protocol v1 via `@at-series/mcp-hub@^0.1.1`, and add confirmations for `jumpserver_send_terminal_input` / `jumpserver_mysql_send_input`.

**Architecture:** Credentials and confirms stay in `JumpServerAgentToolService`. Extension host runs Bridge `GET /health|GET /tools|POST /invoke` on `127.0.0.1`, publishes `~/.at-series/bridges/<hostApp>/<bridgeId>.json` via `FsBridgePublisher`, syncs `hub.js` via `syncHubBundle`, installs single IDE entry **`AT Series`**. Remove product surfaces: per-plugin `mcp-server.js` and `languageModelTools`.

**Tech Stack:** Existing JumpServer VS Code extension (esbuild, vitest, zod) + `@at-series/mcp-hub@^0.1.1`. Mirror patterns from `C:\Users\alan\Desktop\at-terminal-series` (P0b).

**Hard constraints:**

1. **Do not edit** `C:\Users\alan\Desktop\jumpserver-plugins` (read-only source).
2. **Do not edit** `at-series-mcp-hub` / mcp-hub package sources unless user pre-approves; if approved and done, call out in **bold** in the reply.
3. Work only under `C:\Users\alan\Desktop\at-jumpserver-series`.
4. Independent git repo (`git init`); do not set origin to old jumpserver remotes unless user asks.
5. Consume Protocol v1 only — no Hub contract changes in this plan.

**Spec:** `docs/superpowers/specs/2026-07-28-p0c-jumpserver-hub-design.md`

**Out of scope:** SFTP `connectionKey` product debt, P1 series skill, P2 tool rename, Hub source changes.

**Note:** Tree copy from `jumpserver-plugins` is **already done** (excluding `.git` / `node_modules` / `dist` / `*.vsix`). Task 1 starts from git init + baseline install.

---

## File map

| Path | Action |
|------|--------|
| `package.json` | Add `@at-series/mcp-hub@^0.1.1`; remove `languageModelTools` + `onLanguageModelTool:*`; scripts `copy:hub` / update `build` |
| `scripts/copy-hub.mjs` | **Create** (from P0b) |
| `esbuild.config.mjs` | Remove `mcp-server.js` entry |
| `src/mcp/toolCatalog.ts` | **Create** |
| `src/mcp/hostApp.ts` | **Create** |
| `src/mcp/hubSync.ts` | **Create** |
| `src/mcp/bridgeSchemas.ts` | **Create** |
| `src/mcp/BridgeProtocol.ts` | Rewrite headers/types for series |
| `src/mcp/BridgeServer.ts` | Rewrite Protocol v1 + publisher |
| `src/mcp/McpConfigInstaller.ts` | Rewrite to hub helpers |
| `src/mcp/BridgeDiscovery.ts` | Delete |
| `src/mcp/BridgeClient.ts` | Delete |
| `src/mcp/server.ts` | Delete |
| `src/agent/JumpServerAgentToolService.ts` | Add send_input confirms + preview helper |
| `src/agent/AgentTools.ts` | Stop exporting LM registration (or delete call sites) |
| `src/extension.ts` | Wire hub sync / hostApp / bridge / ensure; remove LM tools |
| `test/mcp/**` | Rewrite |
| `test/agent/JumpServerAgentToolService.test.ts` | Add send_input confirm cases |
| `README.md` / docs | Point to AT Series; drop per-plugin mcp-server install as product path |
| `docs/decisions/ADR-001-at-series-mcp-hub.md` | **Create** pointer ADR |

---

### Task 1: Independent git + baseline install

**Files / dirs:**
- Create: `.git` in `at-jumpserver-series` only
- Ensure: `.gitignore` has `node_modules/`, `dist/`, `*.vsix`

- [ ] **Step 1: Verify source untouched**

```powershell
# Original must still exist; do not commit there
Test-Path "C:\Users\alan\Desktop\jumpserver-plugins\src\extension.ts"
```

- [ ] **Step 2: Init git + first commit**

```powershell
cd C:\Users\alan\Desktop\at-jumpserver-series
git init
# Ensure .gitignore contains node_modules, dist, *.vsix
git add -A
git commit -m "chore: import JumpServer snapshot for AT Series Hub adaptation"
```

Do **not** `git remote add` pointing at old jumpserver remotes.

- [ ] **Step 3: Install + baseline tests**

```powershell
cd C:\Users\alan\Desktop\at-jumpserver-series
npm install
npm test
```

Record baseline. Failures from missing env: fix setup only, not Hub adaptation yet.

- [ ] **Step 4: Commit ignore/setup fixes if any**

```powershell
git add -A
git commit -m "chore: normalize ignore rules after import"
```

---

### Task 2: Depend on `@at-series/mcp-hub@^0.1.1`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add dependency**

In `package.json` `dependencies`:

```json
"@at-series/mcp-hub": "^0.1.1"
```

- [ ] **Step 2: Install and resolve**

```powershell
cd C:\Users\alan\Desktop\at-jumpserver-series
npm install
node -e "console.log(require.resolve('@at-series/mcp-hub'))"
node -e "console.log(require.resolve('@at-series/mcp-hub/hub'))"
```

Expected: paths resolve under `node_modules/@at-series/mcp-hub`.

- [ ] **Step 3: Commit**

```powershell
git add package.json package-lock.json
git commit -m "build: depend on @at-series/mcp-hub ^0.1.1"
```

---

### Task 3: Tool catalog with `risk`

**Files:**
- Create: `src/mcp/toolCatalog.ts`
- Create: `test/mcp/toolCatalog.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { AT_JUMPSERVER_PLUGIN_ID, AT_JUMPSERVER_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

describe('toolCatalog', () => {
  it('uses stable pluginId', () => {
    expect(AT_JUMPSERVER_PLUGIN_ID).toBe('at.jumpserver');
  });

  it('declares risk for all fifteen tools', () => {
    expect(AT_JUMPSERVER_TOOL_CATALOG).toHaveLength(15);
    const byName = Object.fromEntries(AT_JUMPSERVER_TOOL_CATALOG.map((t) => [t.name, t.risk]));
    expect(byName.jumpserver_list_assets).toBe('read');
    expect(byName.jumpserver_get_terminal_context).toBe('read');
    expect(byName.jumpserver_sftp_list_directory).toBe('read');
    expect(byName.jumpserver_sftp_stat_path).toBe('read');
    expect(byName.jumpserver_sftp_read_file).toBe('read');
    expect(byName.jumpserver_mysql_get_context).toBe('read');
    expect(byName.jumpserver_sftp_write_file).toBe('write');
    expect(byName.jumpserver_sftp_create_file).toBe('write');
    expect(byName.jumpserver_sftp_create_directory).toBe('write');
    expect(byName.jumpserver_sftp_rename).toBe('write');
    expect(byName.jumpserver_sftp_delete).toBe('write');
    expect(byName.jumpserver_send_terminal_input).toBe('exec');
    expect(byName.jumpserver_run_terminal_command).toBe('exec');
    expect(byName.jumpserver_mysql_send_input).toBe('exec');
    expect(byName.jumpserver_mysql_execute_sql).toBe('exec');
  });
});
```

- [ ] **Step 2: Run fail**

```powershell
npx vitest run test/mcp/toolCatalog.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement catalog**

Create `src/mcp/toolCatalog.ts` with `ToolCatalogEntry[]` from `@at-series/mcp-hub`. Titles/descriptions/schemas must match current `src/mcp/server.ts` / `package.json` languageModelTools input shapes (including optional `connectionKey` / `terminalId` on SFTP tools). Use JSON Schema objects (not zod) for `inputSchema`.

```ts
import type { ToolCatalogEntry } from '@at-series/mcp-hub';

export const AT_JUMPSERVER_PLUGIN_ID = 'at.jumpserver' as const;
export const AT_JUMPSERVER_PLUGIN_DISPLAY_NAME = 'AT JumpServer Terminal' as const;

const terminalTargetProperties = {
  terminalId: {
    type: 'string',
    description: 'JumpServer terminal id, or active for the active terminal.'
  }
} as const;

const sftpTargetProperties = {
  connectionKey: {
    type: 'string',
    description: 'JumpServer SFTP connection key.'
  },
  terminalId: {
    type: 'string',
    description: 'JumpServer terminal id.'
  }
} as const;

export const AT_JUMPSERVER_TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'jumpserver_list_assets',
    title: 'JumpServer List Assets',
    description: 'List cached AT JumpServer Terminal assets without exposing credentials.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'jumpserver_get_terminal_context',
    title: 'JumpServer Terminal Context',
    description: 'Return active, connected, and known AT JumpServer Terminal contexts.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'jumpserver_send_terminal_input',
    title: 'JumpServer Send Terminal Input',
    description: 'Send raw input to a connected JumpServer terminal after confirmation.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalTargetProperties,
        input: { type: 'string', description: 'Raw terminal input to send.' }
      },
      required: ['input']
    }
  },
  {
    name: 'jumpserver_run_terminal_command',
    title: 'JumpServer Run SSH Command',
    description: 'Run a non-interactive command through an existing connected JumpServer SSH terminal.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalTargetProperties,
        command: { type: 'string', description: 'Non-interactive shell command to run.' },
        cwd: { type: 'string', description: 'Optional POSIX working directory.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        maxOutputBytes: { type: 'number', description: 'Optional max bytes of output to capture.' }
      },
      required: ['command']
    }
  },
  {
    name: 'jumpserver_sftp_list_directory',
    title: 'JumpServer SFTP List Directory',
    description: 'List a remote directory through the active JumpServer SFTP session.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' }
      }
    }
  },
  {
    name: 'jumpserver_sftp_stat_path',
    title: 'JumpServer SFTP Stat Path',
    description: 'Return metadata for a remote path through JumpServer SFTP.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_read_file',
    title: 'JumpServer SFTP Read File',
    description: 'Read bounded UTF-8 text from a remote file through JumpServer SFTP.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' },
        maxBytes: { type: 'number', description: 'Optional max bytes to read.' }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_write_file',
    title: 'JumpServer SFTP Write File',
    description: 'Write UTF-8 text to a remote file through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' },
        content: { type: 'string', description: 'UTF-8 file content.' },
        overwrite: { type: 'boolean', description: 'Set true to replace an existing file.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'jumpserver_sftp_create_file',
    title: 'JumpServer SFTP Create File',
    description: 'Create a remote file through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' },
        content: { type: 'string', description: 'Optional UTF-8 file content.' }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_create_directory',
    title: 'JumpServer SFTP Create Directory',
    description: 'Create a remote directory through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_rename',
    title: 'JumpServer SFTP Rename',
    description: 'Rename a remote file or directory through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        oldPath: { type: 'string', description: 'Existing remote POSIX path.' },
        newPath: { type: 'string', description: 'New remote POSIX path.' }
      },
      required: ['oldPath', 'newPath']
    }
  },
  {
    name: 'jumpserver_sftp_delete',
    title: 'JumpServer SFTP Delete',
    description: 'Delete a remote file or directory through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: { type: 'string', description: 'Remote POSIX path.' },
        type: { type: 'string', description: 'Optional entry type hint: file or directory.' }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_mysql_get_context',
    title: 'JumpServer MySQL Context',
    description: 'Return active, connected, and known JumpServer MySQL terminal contexts.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'jumpserver_mysql_send_input',
    title: 'JumpServer MySQL Send Input',
    description: 'Send raw input to a connected JumpServer MySQL CLI terminal after confirmation.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalTargetProperties,
        input: { type: 'string', description: 'Raw MySQL CLI input to send.' }
      },
      required: ['input']
    }
  },
  {
    name: 'jumpserver_mysql_execute_sql',
    title: 'JumpServer MySQL Execute SQL',
    description: 'Execute SQL through an existing connected JumpServer MySQL CLI terminal.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalTargetProperties,
        sql: { type: 'string', description: 'SQL to execute.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        maxOutputBytes: { type: 'number', description: 'Optional max bytes of output to capture.' }
      },
      required: ['sql']
    }
  }
];
```

- [ ] **Step 4: Pass + commit**

```powershell
npx vitest run test/mcp/toolCatalog.test.ts
git add src/mcp/toolCatalog.ts test/mcp/toolCatalog.test.ts
git commit -m "feat: centralize JumpServer MCP tool catalog with risk"
```

---

### Task 4: `hostApp` detection helper

**Files:**
- Create: `src/mcp/hostApp.ts`
- Create: `test/mcp/hostApp.test.ts`

- [ ] **Step 1: Failing tests** for cursor/kiro/vscode/qoder/windsurf/continue → canonical `HostApp`; else `unknown`

- [ ] **Step 2: Implement** by copying `at-terminal-series/src/mcp/hostApp.ts` into this repo (same pure function API).

```ts
import type { HostApp } from '@at-series/mcp-hub';

export function detectHostApp(input: {
  appName?: string;
  appRoot?: string;
  uriScheme?: string;
  extensionPath?: string;
}): HostApp
```

- [ ] **Step 3: Pass + commit**

```powershell
npx vitest run test/mcp/hostApp.test.ts
git add src/mcp/hostApp.ts test/mcp/hostApp.test.ts
git commit -m "feat: detect AT_SERIES hostApp for registry and MCP env"
```

---

### Task 5: Add exec confirm for both `send_input` tools

**Files:**
- Modify: `src/agent/JumpServerAgentToolService.ts`
- Modify: `test/agent/JumpServerAgentToolService.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('requires confirmation before sendTerminalInput', async () => {
  const write = vi.fn();
  const confirm = vi.fn(async () => false);
  const terminalContext = new TerminalContextRegistry();
  terminalContext.setActive({
    terminalId: 'terminal-1',
    asset: asset({ id: 'ssh-1', name: 'web-1', protocolNames: ['ssh'] }),
    connected: true,
    write
  });
  const service = serviceWith({ confirm, terminalContext });

  await expect(service.sendTerminalInput({ input: 'rm -rf /\n' })).rejects.toThrow(
    /cancelled/i
  );
  expect(confirm).toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('writes terminal input after confirmation', async () => {
  const write = vi.fn();
  const confirm = vi.fn(async () => true);
  const terminalContext = new TerminalContextRegistry();
  terminalContext.setActive({
    terminalId: 'terminal-1',
    asset: asset({ id: 'ssh-1', name: 'web-1', protocolNames: ['ssh'] }),
    connected: true,
    write
  });
  const service = serviceWith({ confirm, terminalContext });

  await expect(service.sendTerminalInput({ input: 'whoami\n' })).resolves.toMatchObject({
    terminalId: 'terminal-1',
    bytesWritten: expect.any(Number)
  });
  expect(write).toHaveBeenCalledWith('whoami\n');
});

it('requires confirmation before mysqlSendInput', async () => {
  const write = vi.fn();
  const confirm = vi.fn(async () => false);
  const service = serviceWith({ confirm });
  // default fixture is mysql terminal in serviceWith
  await expect(service.mysqlSendInput({ input: 'DROP TABLE t;\n' })).rejects.toThrow(/cancelled/i);
  expect(confirm).toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
```

Adjust `serviceWith` so mysql default terminal’s `write` is the spy when needed.

- [ ] **Step 2: Run fail**

```powershell
npx vitest run test/agent/JumpServerAgentToolService.test.ts
```

Expected: FAIL on send_input cases (currently no confirm).

- [ ] **Step 3: Implement confirms**

In `JumpServerAgentToolService.ts`:

```ts
async sendTerminalInput(input: { terminalId?: string; input?: string }) {
  const target = this.resolveTerminal(input.terminalId);
  const data = input.input ?? '';
  await this.requireConfirm(
    `Send input to JumpServer terminal on ${target.asset.name}?\n\n${previewInput(data)}`
  );
  target.write(data);
  return { terminalId: target.terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
}

async mysqlSendInput(input: { terminalId?: string; input?: string }) {
  const target = this.resolveTerminal(input.terminalId);
  if (getAssetConnectionKind(target.asset) !== 'mysql') {
    throw new Error('A connected JumpServer MySQL terminal is required.');
  }
  const data = input.input ?? '';
  await this.requireConfirm(
    `Send input to JumpServer MySQL terminal on ${target.asset.name}?\n\n${previewInput(data)}`
  );
  target.write(data);
  return { terminalId: target.terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
}

function previewInput(value: string, maxChars = 400): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n…(truncated)`;
}
```

Keep `mysqlExecuteSql` behavior unchanged (read-only skip confirm).

- [ ] **Step 4: Pass + commit**

```powershell
npx vitest run test/agent/JumpServerAgentToolService.test.ts
git add src/agent/JumpServerAgentToolService.ts test/agent/JumpServerAgentToolService.test.ts
git commit -m "feat: require confirmation for JumpServer send_input tools"
```

---

### Task 6: Bridge schemas + Protocol types

**Files:**
- Create: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/BridgeProtocol.ts`

- [ ] **Step 1: Create zod schemas** for all invoke argument shapes (strict), including:

```ts
import { z } from 'zod';

export const sendTerminalInputBridgeSchema = z
  .object({
    terminalId: z.string().min(1).optional(),
    input: z.string()
  })
  .strict();

export const runTerminalCommandBridgeSchema = z
  .object({
    terminalId: z.string().min(1).optional(),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional()
  })
  .strict();

// … sftp list/stat/read/write/create/rename/delete + mysql send/execute
```

SFTP schemas must keep optional `connectionKey` + `terminalId` fields to avoid changing tool semantics.

- [ ] **Step 2: Rewrite `BridgeProtocol.ts` exports**

```ts
export {
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES,
  AT_SERIES_PROTOCOL_VERSION
} from '@at-series/mcp-hub';

/** Legacy auth header accepted during migration. */
export const BRIDGE_TOKEN_HEADER = 'x-at-jumpserver-terminal-token';
```

Keep domain request/response TypeScript interfaces; change `BridgeErrorResponse` to structured `{ error: { code, message, details? } }`.

Re-export plugin display constants from `toolCatalog` or define `AT_JUMPSERVER_PLUGIN_DISPLAY_NAME` there only (single source).

- [ ] **Step 3: Commit**

```powershell
git add src/mcp/bridgeSchemas.ts src/mcp/BridgeProtocol.ts
git commit -m "feat: add JumpServer bridge schemas and series protocol headers"
```

---

### Task 7: Rewrite Bridge HTTP to Protocol v1 + publisher

**Files:**
- Rewrite: `src/mcp/BridgeServer.ts`
- Delete: `src/mcp/BridgeDiscovery.ts` (after no imports)
- Rewrite: `test/mcp/BridgeServer.test.ts`
- Create: `test/mcp/bridgePublish.test.ts`
- Delete or rewrite: `test/mcp/BridgeDiscovery.test.ts` (remove old path assertions)

**Behavior (mirror P0b BridgeServer):**

- Constructor options: `{ service, hostApp, pluginVersion?, home? }`
- `bridgeId = randomUUID()`; token = `randomBytes(32).toString('hex')`
- Listen `BRIDGE_HOST` port `0`
- Auth: accept `x-at-series-token` **or** legacy `x-at-jumpserver-terminal-token`
- Body limit via `BRIDGE_MAX_BODY_BYTES`
- `GET|POST /health` → rich health JSON
- `GET /tools` → `{ protocolVersion, tools: AT_JUMPSERVER_TOOL_CATALOG }`
- `POST /invoke` → dispatch 15 tools; success `{ ok:true, name, result }`; errors structured
- Map cancel messages containing `cancelled` → `USER_CANCELLED` (499)
- On start: `FsBridgePublisher.publish` full record + heartbeat ≤30s with `connectedTargets`
- On dispose: clear heartbeat, `unpublish`, close server — **never** delete hub.js / MCP config
- Stop writing `~/.at-jumpserver-terminal/mcp-bridge.json`

- [ ] **Step 1: Write BridgeServer tests** covering 401, health shape, tools risk, invoke `jumpserver_list_assets`, validation error, cancel → USER_CANCELLED

- [ ] **Step 2: Implement BridgeServer** (use `at-terminal-series/src/mcp/BridgeServer.ts` as structural template; swap catalog/service/dispatch names)

Invoke dispatch sketch:

```ts
switch (name) {
  case 'jumpserver_list_assets':
    return { ok: true, value: await service.listAssets() };
  case 'jumpserver_send_terminal_input': {
    const parsed = parseArgsWithSchema(args, sendTerminalInputBridgeSchema);
    if (!parsed.ok) {
      return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
    }
    return { ok: true, value: await service.sendTerminalInput(parsed.data) };
  }
  // … all 15
  default:
    return { ok: false, response: bridgeError(404, 'NOT_FOUND', `Unknown tool: ${name}`) };
}
```

- [ ] **Step 3: Publisher test** with temp `home` — assert file under `<home>/.at-series/bridges/<hostApp>/`; after dispose file gone; hub.js not required to exist.

- [ ] **Step 4: Pass + commit**

```powershell
npx vitest run test/mcp/BridgeServer.test.ts test/mcp/bridgePublish.test.ts
git add src/mcp/BridgeServer.ts test/mcp/
git add -u src/mcp/BridgeDiscovery.ts test/mcp/BridgeDiscovery.test.ts
git commit -m "feat: Bridge health/tools/invoke and ~/.at-series registry publish"
```

---

### Task 8: Hub sync + copy-hub build step

**Files:**
- Create: `src/mcp/hubSync.ts`
- Create: `scripts/copy-hub.mjs`
- Modify: `package.json` scripts
- Create: `test/mcp/hubSync.test.ts` (temp home + fake bundle)

- [ ] **Step 1: Add `scripts/copy-hub.mjs`** (same as P0b):

```js
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hubEntry = require.resolve('@at-series/mcp-hub/hub');
const hubPkgPath = join(dirname(hubEntry), '..', 'package.json');
const hubPkg = JSON.parse(readFileSync(hubPkgPath, 'utf8'));

mkdirSync('dist', { recursive: true });
copyFileSync(hubEntry, join('dist', 'hub.js'));
writeFileSync(
  join('dist', 'hub-version.json'),
  `${JSON.stringify({ version: hubPkg.version, protocolVersion: 1 }, null, 2)}\n`,
  'utf8'
);
console.log(`copied hub.js (${hubPkg.version}) + hub-version.json`);
```

- [ ] **Step 2: package.json scripts**

```json
"copy:hub": "node scripts/copy-hub.mjs",
"build": "node esbuild.config.mjs && npm run copy:hub"
```

- [ ] **Step 3: Implement `hubSync.ts`**

```ts
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { syncHubBundle } from '@at-series/mcp-hub';
import * as vscode from 'vscode';
import { AT_JUMPSERVER_PLUGIN_ID } from './toolCatalog';

const require = createRequire(__filename);

export async function syncPackagedHub(
  context: vscode.ExtensionContext
): Promise<{ updated: boolean; activeVersion: string }> {
  const bundlePath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'hub.js').fsPath;
  const hubVersion = await resolveHubPackageVersion(bundlePath);
  await access(bundlePath);
  return syncHubBundle({
    version: hubVersion,
    bundlePath,
    pluginId: AT_JUMPSERVER_PLUGIN_ID,
    pluginVersion: String(context.extension.packageJSON.version)
  });
}

async function resolveHubPackageVersion(bundlePath: string): Promise<string> {
  const sidecar = join(dirname(bundlePath), 'hub-version.json');
  try {
    const raw = await readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through
  }
  return require('@at-series/mcp-hub/package.json').version as string;
}
```

Also export a testable `syncPackagedHubAt(bundlePath, versions, home?)` like P0b if useful.

- [ ] **Step 4: `npm run build` copies hub.js**

```powershell
npm run build
Test-Path dist/hub.js
Test-Path dist/hub-version.json
Test-Path dist/mcp-server.js
```

Expected: `hub.js` / `hub-version.json` exist; `mcp-server.js` absent after Task 9 (for now may still exist until entry removed).

- [ ] **Step 5: Commit**

```powershell
git add scripts/copy-hub.mjs src/mcp/hubSync.ts package.json test/mcp/hubSync.test.ts
git commit -m "feat: package and sync AT Series hub.js on JumpServer builds"
```

---

### Task 9: Replace MCP installer + remove old product surfaces

**Files:**
- Rewrite: `src/mcp/McpConfigInstaller.ts`
- Rewrite: `test/mcp/McpConfigInstaller.test.ts`
- Modify: `esbuild.config.mjs` — remove mcp-server entry
- Delete: `src/mcp/server.ts`, `src/mcp/BridgeClient.ts`
- Delete/update: `test/mcp/BridgeClient.test.ts`, `test/mcp/McpServerTools.test.ts`
- Modify: `package.json` — remove entire `contributes.languageModelTools` and all `onLanguageModelTool:*` activationEvents; rename install command title to AT Series
- Modify: `src/agent/AgentTools.ts` / stop calling `registerAgentTools` from extension
- Update: `test/agent/AgentTools.test.ts`, `test/package.manifest.test.ts`, `test/docs/**` as needed

- [ ] **Step 1: Implement installer wrapper** (mirror P0b):

```ts
import {
  ensureAtSeriesMcpConfig,
  hubJsPath,
  uninstallAtSeriesMcpConfig,
  type HostApp,
  type McpInstallerTarget
} from '@at-series/mcp-hub';
import { detectHostApp } from './hostApp';
import { AT_JUMPSERVER_TOOL_CATALOG } from './toolCatalog';

export function resolveMcpInstallerTarget(
  hostApp: HostApp,
  workspaceFolder?: string
): McpInstallerTarget | undefined {
  if (hostApp === 'kiro') return 'kiro';
  if (hostApp === 'continue') return workspaceFolder ? 'continue' : undefined;
  if (hostApp === 'cursor') return 'cursor';
  return undefined;
}

export async function ensureAtSeriesConfigForCurrentIde(options: {
  appName?: string;
  appRoot?: string;
  uriScheme?: string;
  extensionPath?: string;
  workspaceFolder?: string;
  home?: string;
  hubJsAbsolutePath?: string;
}): Promise<{ updated: boolean } | undefined> {
  const hostApp = detectHostApp(options);
  const target = resolveMcpInstallerTarget(hostApp, options.workspaceFolder);
  if (!target) return undefined;
  return ensureAtSeriesMcpConfig({
    target,
    hostApp,
    hubJsAbsolutePath: options.hubJsAbsolutePath ?? hubJsPath(options.home),
    home: options.home,
    workspaceFolder: options.workspaceFolder,
    registryTools: AT_JUMPSERVER_TOOL_CATALOG
  });
}

export async function uninstallAtSeriesConfigForCurrentIde(/* same options */) { /* uninstallAtSeriesMcpConfig */ }
```

Installer tests (temp home): after ensure, Cursor mcp.json has **`AT Series`**; migrates away `AT JumpServer Terminal`; third-party preserved; autoApprove excludes all `risk=write|exec` names (especially both send_input + run + mysql execute + sftp writes).

- [ ] **Step 2: Remove LM tools from package.json + AgentTools registration**

- [ ] **Step 3: Remove mcp-server from esbuild; delete server.ts / BridgeClient.ts**

- [ ] **Step 4: Grep product references**

```powershell
rg "languageModelTools|mcp-server\.js|AT JumpServer Terminal|mcp-bridge\.json" package.json README.md docs src -g'!**/node_modules/**'
```

Allowed: migration mentions / historical ADR notes. Forbidden: contributes LM tools; installer writing per-plugin mcp-server path.

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: install AT Series MCP config; remove LM tools and mcp-server entry"
```

---

### Task 10: Wire `extension.ts` lifecycle

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/extension/ExtensionCommands.test.ts` if it asserts old installer

Activate order:

1. Build `JumpServerAgentToolService` (existing confirm modal)
2. `detectHostApp({ appName, appRoot, uriScheme, extensionPath })`
3. `await syncPackagedHub(context)` (catch + warn; don’t block UI forever — same UX spirit as current bridge start)
4. `new BridgeServer({ service, hostApp, pluginVersion: packageJSON.version })` → `start()`
5. `ensureAtSeriesConfigForCurrentIde(...)` (best-effort)
6. Commands: Install/Repair AT Series MCP Config; add Uninstall AT Series MCP Config
7. Dispose: `bridgeServer.dispose()` only (unpublish); **do not** uninstall MCP / delete hub.js
8. Remove `registerAgentTools(...)`

- [ ] **Step 1: Implement wiring**

- [ ] **Step 2: typecheck**

```powershell
npm run typecheck
```

- [ ] **Step 3: Commit**

```powershell
git add src/extension.ts test/extension/
git commit -m "feat: wire JumpServer activate to AT Series hub sync and bridge publish"
```

---

### Task 11: Full test suite + docs

**Files:**
- Fix remaining broken tests under `test/mcp/**`, `test/docs/**`, `test/package.manifest.test.ts`
- Update: `README.md` — AT Series only MCP entry; link hub docs
- Create: `docs/decisions/ADR-001-at-series-mcp-hub.md` pointing to hub ADR-001 + this design/plan; state original `jumpserver-plugins` unchanged
- Mark design status Approved in spec header if desired

- [ ] **Step 1: Run full suite**

```powershell
cd C:\Users\alan\Desktop\at-jumpserver-series
npm test
npm run build
npm run typecheck
```

Expected: all pass; `dist/extension.js` + `dist/hub.js` present; no product need for `dist/mcp-server.js`.

- [ ] **Step 2: Docs + ADR**

- [ ] **Step 3: Commit**

```powershell
git add -A
git commit -m "docs: document AT Series Hub adaptation for at-jumpserver-series"
```

---

### Task 12: P0c acceptance checklist

Verify with evidence (do not claim done without):

- [ ] `jumpserver-plugins` unmodified by this work (`git status` there clean / no new commits from us)
- [ ] `at-jumpserver-series` is its own `.git` without old remote
- [ ] **mcp-hub sources not modified**
- [ ] No `languageModelTools` in `package.json`
- [ ] Build has no product dependency on `dist/mcp-server.js`
- [ ] Bridge serves `/health` `/tools` `/invoke` with series token
- [ ] Registry under `~/.at-series/bridges/<hostApp>/` (or test home)
- [ ] Installer writes `AT Series`; migrates `AT JumpServer Terminal`; preserves third-party
- [ ] autoApprove excludes write/exec (both send_input, run, mysql execute, sftp mutating)
- [ ] `sendTerminalInput` / `mysqlSendInput` confirm tests green
- [ ] `mysqlExecuteSql` still skips confirm for read-only SQL
- [ ] Manual smoke (optional but recommended): Extension Host → hub.js + bridge json + tools list

Manual smoke:

1. `npm run build`
2. Launch Extension Development Host
3. Confirm `~/.at-series/mcp/hub.js`
4. Confirm bridge json under `~/.at-series/bridges/<hostApp>/`
5. IDE MCP has `AT Series` + `AT_SERIES_HOST_APP`
6. `tools/list` includes `jumpserver_*` while window alive
7. Invoke send_input → confirmation dialog appears

---

## Plan self-review

1. **Spec coverage:** Copy/new repo, hub dep, catalog+risk, hostApp, Bridge v1+publisher, hub sync, installer, remove LM/mcp-server, extension wire, send_input confirms, mysql execute policy unchanged, tests/docs/DoD — each has a task.
2. **Placeholders:** None intentional; code/commands included for critical steps.
3. **Type consistency:** `AT_JUMPSERVER_PLUGIN_ID`, catalog name, Bridge cancel → `USER_CANCELLED`, installer helpers named consistently.
4. **Hub untouched:** Explicit hard constraint; consume `@at-series/mcp-hub@^0.1.1` only.
