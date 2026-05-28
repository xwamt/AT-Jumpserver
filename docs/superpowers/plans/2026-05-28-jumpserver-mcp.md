# JumpServer MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP support to AT JumpServer Terminal for JumpServer assets, terminal context, SSH terminal commands, SFTP operations, and MySQL CLI SQL execution without conflicting with `ssh-plugins`.

**Architecture:** Follow the `ssh-plugins` MCP pattern: VS Code extension bridge, stdio MCP sidecar, bridge client, agent tool service, installer, docs, and skill. Use JumpServer-specific discovery files, headers, names, and `jumpserver_` tool names. All tools delegate to the existing JumpServer extension runtime instead of opening independent direct connections.

**Tech Stack:** TypeScript, VS Code extension API, `@modelcontextprotocol/sdk`, Node HTTP, Vitest, esbuild, existing JumpServer KoKo terminal and SFTP modules.

---

## File Structure

Create:

- `src/mcp/BridgeProtocol.ts`: shared bridge constants, request/response types, and tool name list.
- `src/mcp/BridgeDiscovery.ts`: read/write/remove `~/.at-jumpserver-terminal/mcp-bridge.json`.
- `src/mcp/BridgeClient.ts`: MCP sidecar client for calling the extension bridge.
- `src/mcp/BridgeServer.ts`: localhost dynamic-port HTTP bridge hosted inside the extension.
- `src/mcp/McpConfigInstaller.ts`: Kiro/Cursor/Continue MCP config installer.
- `src/mcp/server.ts`: stdio MCP server registering `jumpserver_` tools.
- `src/agent/TerminalOutputBuffer.ts`: bounded terminal output buffer and collectors.
- `src/agent/TerminalExecutors.ts`: SSH shell command and MySQL SQL marker execution.
- `src/agent/SqlSafety.ts`: read-only versus dangerous SQL classifier.
- `src/agent/JumpServerAgentToolService.ts`: user-facing tool service delegating to config, terminal, SFTP, and executors.
- `src/agent/AgentTools.ts`: VS Code Language Model tool registration.
- `test/mcp/BridgeDiscovery.test.ts`
- `test/mcp/BridgeClient.test.ts`
- `test/mcp/BridgeServer.test.ts`
- `test/mcp/McpConfigInstaller.test.ts`
- `test/mcp/McpServerTools.test.ts`
- `test/agent/TerminalOutputBuffer.test.ts`
- `test/agent/TerminalExecutors.test.ts`
- `test/agent/SqlSafety.test.ts`
- `test/agent/JumpServerAgentToolService.test.ts`
- `test/agent/AgentTools.test.ts`
- `docs/mcp/continue-at-jumpserver-terminal-mcp.yaml`
- `skills/at-jumpserver-terminal-mcp/SKILL.md`

Modify:

- `package.json`: dependency, activation events, contributed language model tools, install command, scripts if needed.
- `package-lock.json`: dependency lockfile.
- `esbuild.config.mjs`: add MCP sidecar bundle.
- `src/extension.ts`: instantiate agent service, bridge server, installer command, and LM tools.
- `src/terminal/TerminalContext.ts`: keep all known terminals and expose bounded output capture.
- `src/webview/TerminalPanel.ts`: publish terminal output to the terminal registry.
- `README.md`: document MCP support.
- `test/extension/ExtensionCommands.test.ts`: cover bridge and installer wiring.
- `test/package.manifest.test.ts`: cover MCP command, activation events, and tool manifest.
- Existing terminal tests as needed for `TerminalContextRegistry`.

---

### Task 1: Add MCP Dependency, Build Target, And Manifest Skeleton

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `esbuild.config.mjs`
- Test: `test/package.manifest.test.ts`

- [ ] **Step 1: Write the failing manifest test**

Add assertions to `test/package.manifest.test.ts`:

```ts
it('contributes JumpServer MCP tools and install command', () => {
  const tools = manifest.contributes.languageModelTools ?? [];
  const toolNames = tools.map((tool: { name: string }) => tool.name);
  expect(toolNames).toEqual(expect.arrayContaining([
    'jumpserver_list_assets',
    'jumpserver_get_terminal_context',
    'jumpserver_send_terminal_input',
    'jumpserver_run_terminal_command',
    'jumpserver_sftp_list_directory',
    'jumpserver_sftp_stat_path',
    'jumpserver_sftp_read_file',
    'jumpserver_sftp_write_file',
    'jumpserver_sftp_create_file',
    'jumpserver_sftp_create_directory',
    'jumpserver_sftp_rename',
    'jumpserver_sftp_delete',
    'jumpserver_mysql_get_context',
    'jumpserver_mysql_send_input',
    'jumpserver_mysql_execute_sql'
  ]));
  expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({
      command: 'jumpserverManager.installMcpConfig',
      title: 'JumpServer: Install MCP Config'
    })
  ]));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npx vitest run test/package.manifest.test.ts
```

Expected: FAIL because `languageModelTools` and `jumpserverManager.installMcpConfig` are missing.

- [ ] **Step 3: Add manifest entries and dependency**

Update `package.json`:

```json
"activationEvents": [
  "onStartupFinished",
  "onView:jumpserverManager.assets",
  "onView:jumpserverManager.sftpFiles",
  "onLanguageModelTool:jumpserver_list_assets",
  "onLanguageModelTool:jumpserver_get_terminal_context",
  "onLanguageModelTool:jumpserver_send_terminal_input",
  "onLanguageModelTool:jumpserver_run_terminal_command",
  "onLanguageModelTool:jumpserver_sftp_list_directory",
  "onLanguageModelTool:jumpserver_sftp_stat_path",
  "onLanguageModelTool:jumpserver_sftp_read_file",
  "onLanguageModelTool:jumpserver_sftp_write_file",
  "onLanguageModelTool:jumpserver_sftp_create_file",
  "onLanguageModelTool:jumpserver_sftp_create_directory",
  "onLanguageModelTool:jumpserver_sftp_rename",
  "onLanguageModelTool:jumpserver_sftp_delete",
  "onLanguageModelTool:jumpserver_mysql_get_context",
  "onLanguageModelTool:jumpserver_mysql_send_input",
  "onLanguageModelTool:jumpserver_mysql_execute_sql"
]
```

Add `contributes.languageModelTools` with the 15 tool entries. Use the same schema style as `ssh-plugins/package.json`, but all names and descriptions must be JumpServer-specific.

Add command:

```json
{
  "command": "jumpserverManager.installMcpConfig",
  "title": "JumpServer: Install MCP Config"
}
```

Add dependency:

```json
"@modelcontextprotocol/sdk": "^1.29.0"
```

- [ ] **Step 4: Update lockfile**

Run:

```powershell
npm install
```

Expected: `package-lock.json` changes and installs `@modelcontextprotocol/sdk`.

- [ ] **Step 5: Add MCP build target**

Modify `esbuild.config.mjs` by adding another context:

```js
esbuild.context({
  ...common,
  entryPoints: ['src/mcp/server.ts'],
  outfile: 'dist/mcp-server.js',
  platform: 'node',
  format: 'cjs'
})
```

This will fail until `src/mcp/server.ts` exists in a later task.

- [ ] **Step 6: Run test to verify manifest passes**

Run:

```powershell
npx vitest run test/package.manifest.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json esbuild.config.mjs test/package.manifest.test.ts
git commit -m "feat: add JumpServer MCP manifest skeleton"
```

---

### Task 2: Implement Bridge Protocol And Discovery

**Files:**
- Create: `src/mcp/BridgeProtocol.ts`
- Create: `src/mcp/BridgeDiscovery.ts`
- Test: `test/mcp/BridgeDiscovery.test.ts`

- [ ] **Step 1: Write failing discovery tests**

Create `test/mcp/BridgeDiscovery.test.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bridgeDiscoveryFile,
  readBridgeDiscovery,
  removeBridgeDiscovery,
  writeBridgeDiscovery
} from '../../src/mcp/BridgeDiscovery';

describe('JumpServer BridgeDiscovery', () => {
  it('uses a JumpServer-specific discovery file', () => {
    expect(bridgeDiscoveryFile('C:/Users/test').replaceAll('\\', '/')).toBe(
      'C:/Users/test/.at-jumpserver-terminal/mcp-bridge.json'
    );
  });

  it('writes and reads valid bridge discovery data', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-discovery-read');
    await writeBridgeDiscovery(home, { port: 39451, token: 'secret', pid: 123, updatedAt: 456 });
    await expect(readBridgeDiscovery(home)).resolves.toEqual({
      port: 39451,
      token: 'secret',
      pid: 123,
      updatedAt: 456
    });
  });

  it('ignores invalid discovery data', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-discovery-invalid');
    const file = bridgeDiscoveryFile(home);
    await mkdir(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(file, JSON.stringify({ port: 0, token: '', pid: 'bad', updatedAt: 1 }), 'utf8');
    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });

  it('removes discovery only when the owner matches', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-discovery-remove');
    await writeBridgeDiscovery(home, { port: 39451, token: 'secret', pid: 123, updatedAt: 456 });
    await removeBridgeDiscovery(home, { port: 39451, token: 'wrong', pid: 123 });
    await expect(readBridgeDiscovery(home)).resolves.toBeDefined();
    await removeBridgeDiscovery(home, { port: 39451, token: 'secret', pid: 123 });
    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });

  it('does not use the ssh-plugins discovery path', () => {
    expect(bridgeDiscoveryFile('C:/Users/test').replaceAll('\\', '/')).not.toContain('/.at-terminal/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run test/mcp/BridgeDiscovery.test.ts
```

Expected: FAIL because MCP discovery files do not exist.

- [ ] **Step 3: Create bridge protocol**

Create `src/mcp/BridgeProtocol.ts`:

```ts
import type { TerminalContextSnapshot } from '../terminal/TerminalContext';

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_TOKEN_HEADER = 'x-at-jumpserver-terminal-token';

export const JUMPSERVER_MCP_TOOL_NAMES = [
  'jumpserver_list_assets',
  'jumpserver_get_terminal_context',
  'jumpserver_send_terminal_input',
  'jumpserver_run_terminal_command',
  'jumpserver_sftp_list_directory',
  'jumpserver_sftp_stat_path',
  'jumpserver_sftp_read_file',
  'jumpserver_sftp_write_file',
  'jumpserver_sftp_create_file',
  'jumpserver_sftp_create_directory',
  'jumpserver_sftp_rename',
  'jumpserver_sftp_delete',
  'jumpserver_mysql_get_context',
  'jumpserver_mysql_send_input',
  'jumpserver_mysql_execute_sql'
] as const;

export type JumpServerMcpToolName = typeof JUMPSERVER_MCP_TOOL_NAMES[number];

export interface BridgeDiscovery {
  port: number;
  token: string;
  pid: number;
  updatedAt: number;
}

export interface RemoveBridgeDiscoveryOwner {
  port: number;
  token: string;
  pid: number;
}

export type GetTerminalContextBridgeResponse = TerminalContextSnapshot;

export interface TerminalTargetBridgeRequest {
  terminalId?: string;
}

export interface SendTerminalInputBridgeRequest extends TerminalTargetBridgeRequest {
  input: string;
}

export interface RunTerminalCommandBridgeRequest extends TerminalTargetBridgeRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SftpTargetBridgeRequest {
  connectionKey?: string;
  terminalId?: string;
}

export interface SftpPathBridgeRequest extends SftpTargetBridgeRequest {
  path: string;
}

export interface SftpListDirectoryBridgeRequest extends SftpTargetBridgeRequest {
  path?: string;
}

export interface SftpReadFileBridgeRequest extends SftpPathBridgeRequest {
  maxBytes?: number;
}

export interface SftpWriteFileBridgeRequest extends SftpPathBridgeRequest {
  content: string;
  overwrite?: boolean;
}

export interface SftpCreateFileBridgeRequest extends SftpPathBridgeRequest {
  content?: string;
}

export interface SftpRenameBridgeRequest extends SftpTargetBridgeRequest {
  oldPath: string;
  newPath: string;
}

export interface SftpDeleteBridgeRequest extends SftpPathBridgeRequest {
}

export interface MysqlExecuteSqlBridgeRequest extends TerminalTargetBridgeRequest {
  sql: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface BridgeErrorResponse {
  error: string;
}
```

If `TerminalContextSnapshot` does not exist yet, add it in Task 5; for now TypeScript may fail until the later task.

- [ ] **Step 4: Create bridge discovery implementation**

Create `src/mcp/BridgeDiscovery.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeDiscovery, RemoveBridgeDiscoveryOwner } from './BridgeProtocol';

export function bridgeDiscoveryFile(home = homedir()): string {
  return join(home, '.at-jumpserver-terminal', 'mcp-bridge.json');
}

export async function writeBridgeDiscovery(home: string, discovery: BridgeDiscovery): Promise<void> {
  const file = bridgeDiscoveryFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(discovery, null, 2), 'utf8');
}

export async function readBridgeDiscovery(home = homedir()): Promise<BridgeDiscovery | undefined> {
  try {
    const parsed = JSON.parse(await readFile(bridgeDiscoveryFile(home), 'utf8')) as Partial<BridgeDiscovery>;
    if (
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.updatedAt === 'number'
    ) {
      return {
        port: parsed.port,
        token: parsed.token,
        pid: parsed.pid,
        updatedAt: parsed.updatedAt
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function removeBridgeDiscovery(home = homedir(), owner?: RemoveBridgeDiscoveryOwner): Promise<void> {
  if (owner) {
    const current = await readBridgeDiscovery(home);
    if (!current || current.port !== owner.port || current.token !== owner.token || current.pid !== owner.pid) {
      return;
    }
  }
  await rm(bridgeDiscoveryFile(home), { force: true });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```powershell
npx vitest run test/mcp/BridgeDiscovery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/mcp/BridgeProtocol.ts src/mcp/BridgeDiscovery.ts test/mcp/BridgeDiscovery.test.ts
git commit -m "feat: add JumpServer MCP bridge discovery"
```

---

### Task 3: Implement Bridge Client

**Files:**
- Create: `src/mcp/BridgeClient.ts`
- Test: `test/mcp/BridgeClient.test.ts`

- [ ] **Step 1: Write failing BridgeClient tests**

Create `test/mcp/BridgeClient.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../../src/mcp/BridgeClient';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';
import { writeBridgeDiscovery } from '../../src/mcp/BridgeDiscovery';

describe('JumpServer BridgeClient', () => {
  it('throws a clear error when bridge discovery is missing', async () => {
    const client = new BridgeClient({ home: join(process.cwd(), '.tmp-missing-jumpserver-bridge') });
    await expect(client.listAssets()).rejects.toThrow('AT JumpServer Terminal MCP bridge is not running');
  });

  it('calls the JumpServer bridge with the discovery token', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-client');
    await writeBridgeDiscovery(home, { port: 34567, token: 'token-1', pid: 111, updatedAt: 222 });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ assets: [] })
    }));
    const client = new BridgeClient({ home, fetch: fetchImpl });

    await expect(client.listAssets()).resolves.toEqual({ assets: [] });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:34567/tools/jumpserver_list_assets', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BRIDGE_TOKEN_HEADER]: 'token-1'
      },
      body: '{}'
    });
  });

  it('surfaces bridge error responses', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-client-error');
    await writeBridgeDiscovery(home, { port: 34568, token: 'token-2', pid: 111, updatedAt: 222 });
    const client = new BridgeClient({
      home,
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'No matching JumpServer terminal.' })
      })
    });

    await expect(client.getTerminalContext()).rejects.toThrow('No matching JumpServer terminal.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run test/mcp/BridgeClient.test.ts
```

Expected: FAIL because `BridgeClient` does not exist.

- [ ] **Step 3: Create BridgeClient**

Create `src/mcp/BridgeClient.ts`:

```ts
import { homedir } from 'node:os';
import { readBridgeDiscovery } from './BridgeDiscovery';
import {
  BRIDGE_HOST,
  BRIDGE_TOKEN_HEADER,
  type MysqlExecuteSqlBridgeRequest,
  type RunTerminalCommandBridgeRequest,
  type SendTerminalInputBridgeRequest,
  type SftpCreateFileBridgeRequest,
  type SftpDeleteBridgeRequest,
  type SftpListDirectoryBridgeRequest,
  type SftpPathBridgeRequest,
  type SftpReadFileBridgeRequest,
  type SftpRenameBridgeRequest,
  type SftpWriteFileBridgeRequest
} from './BridgeProtocol';

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchLikeResponse>;

export class BridgeClient {
  constructor(
    private readonly options: {
      home?: string;
      fetch?: FetchLike;
    } = {}
  ) {}

  listAssets(): Promise<unknown> {
    return this.call('/tools/jumpserver_list_assets', {});
  }

  getTerminalContext(): Promise<unknown> {
    return this.call('/tools/jumpserver_get_terminal_context', {});
  }

  sendTerminalInput(input: SendTerminalInputBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_send_terminal_input', input);
  }

  runTerminalCommand(input: RunTerminalCommandBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_run_terminal_command', input);
  }

  sftpListDirectory(input: SftpListDirectoryBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_list_directory', input);
  }

  sftpStatPath(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_stat_path', input);
  }

  sftpReadFile(input: SftpReadFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_read_file', input);
  }

  sftpWriteFile(input: SftpWriteFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_write_file', input);
  }

  sftpCreateFile(input: SftpCreateFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_create_file', input);
  }

  sftpCreateDirectory(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_create_directory', input);
  }

  sftpRename(input: SftpRenameBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_rename', input);
  }

  sftpDelete(input: SftpDeleteBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_delete', input);
  }

  mysqlGetContext(): Promise<unknown> {
    return this.call('/tools/jumpserver_mysql_get_context', {});
  }

  mysqlSendInput(input: SendTerminalInputBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_mysql_send_input', input);
  }

  mysqlExecuteSql(input: MysqlExecuteSqlBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_mysql_execute_sql', input);
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const discovery = await readBridgeDiscovery(this.options.home ?? homedir());
    if (!discovery) {
      throw new Error(
        'AT JumpServer Terminal MCP bridge is not running. Open VS Code with AT JumpServer Terminal installed, then reload this MCP server.'
      );
    }

    const fetchImpl = this.options.fetch ?? fetch;
    let response: FetchLikeResponse;
    try {
      response = await fetchImpl(`http://${BRIDGE_HOST}:${discovery.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [BRIDGE_TOKEN_HEADER]: discovery.token
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error('AT JumpServer Terminal MCP bridge is not reachable. Reload VS Code with AT JumpServer Terminal running, then retry.');
    }

    const parsed = await parseJsonResponse(response);
    if (!response.ok) {
      const message =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String(parsed.error)
          : `Bridge request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    return parsed as T;
  }
}

async function parseJsonResponse(response: FetchLikeResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(`Bridge request failed with HTTP ${response.status}.`);
    }
    throw new Error('AT JumpServer Terminal MCP bridge returned an invalid JSON response.');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npx vitest run test/mcp/BridgeClient.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/mcp/BridgeClient.ts test/mcp/BridgeClient.test.ts
git commit -m "feat: add JumpServer MCP bridge client"
```

---

### Task 4: Implement Terminal Output Buffer And Registry Snapshot

**Files:**
- Create: `src/agent/TerminalOutputBuffer.ts`
- Modify: `src/terminal/TerminalContext.ts`
- Modify: `src/webview/TerminalPanel.ts`
- Test: `test/agent/TerminalOutputBuffer.test.ts`
- Test: `test/terminal/TerminalContext.test.ts`
- Test: `test/webview/TerminalPanel.test.ts`

- [ ] **Step 1: Write failing output buffer tests**

Create `test/agent/TerminalOutputBuffer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';

describe('TerminalOutputBuffer', () => {
  it('keeps bounded output text', () => {
    const buffer = new TerminalOutputBuffer(5);
    buffer.append(Buffer.from('hello'));
    buffer.append(Buffer.from(' world'));
    expect(buffer.text()).toBe('world');
  });

  it('collects text until a marker appears', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker: 'END-1',
      timeoutMs: 1000,
      maxOutputBytes: 1024
    });

    buffer.append(Buffer.from('before\n'));
    buffer.append(Buffer.from('payload\nEND-1\n'));

    await expect(collection).resolves.toMatchObject({
      output: 'before\npayload\n',
      timedOut: false,
      truncated: false
    });
  });

  it('reports timeout with partial output', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker: 'NEVER',
      timeoutMs: 5,
      maxOutputBytes: 1024
    });
    buffer.append(Buffer.from('partial'));
    await expect(collection).resolves.toMatchObject({
      output: 'partial',
      timedOut: true
    });
  });
});
```

- [ ] **Step 2: Write failing terminal context snapshot tests**

Extend `test/terminal/TerminalContext.test.ts`:

```ts
it('returns active connected and known terminal snapshots', () => {
  const registry = new TerminalContextRegistry();
  registry.setActive({
    terminalId: 'terminal-1',
    asset: asset({ id: 'ssh-1', name: 'ssh-1', protocolNames: ['ssh'] }),
    connected: true,
    write: vi.fn()
  });
  registry.setActive({
    terminalId: 'terminal-2',
    asset: asset({ id: 'mysql-1', name: 'mysql-1', protocolNames: ['mysql'], type: 'mysql' }),
    connected: false,
    write: vi.fn()
  });

  expect(registry.getSnapshot()).toEqual({
    activeTerminal: expect.objectContaining({ terminalId: 'terminal-2', assetId: 'mysql-1', connectionKind: 'mysql' }),
    connectedTerminals: [expect.objectContaining({ terminalId: 'terminal-1', connectionKind: 'ssh' })],
    knownTerminals: [
      expect.objectContaining({ terminalId: 'terminal-1', connectionKind: 'ssh' }),
      expect.objectContaining({ terminalId: 'terminal-2', connectionKind: 'mysql' })
    ]
  });
});
```

Use the existing asset helper in the test file, or add:

```ts
function asset(overrides: Partial<CachedJumpServerAsset>): CachedJumpServerAsset {
  return {
    id: 'asset-1',
    name: 'asset-1',
    address: '',
    platform: '',
    category: '',
    type: '',
    zoneName: '',
    nodePath: [],
    protocolNames: [],
    raw: {},
    ...overrides
  };
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npx vitest run test/agent/TerminalOutputBuffer.test.ts test/terminal/TerminalContext.test.ts
```

Expected: FAIL because `TerminalOutputBuffer`, `getSnapshot`, and output capture methods are missing.

- [ ] **Step 4: Implement TerminalOutputBuffer**

Create `src/agent/TerminalOutputBuffer.ts`:

```ts
import { EventEmitter } from 'node:events';

export interface CollectUntilOptions {
  marker: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CollectedTerminalOutput {
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export class TerminalOutputBuffer {
  private bytes = Buffer.alloc(0);
  private readonly events = new EventEmitter();

  constructor(private readonly maxBufferedBytes = 128 * 1024) {}

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.bytes = Buffer.concat([this.bytes, next]);
    if (this.bytes.byteLength > this.maxBufferedBytes) {
      this.bytes = this.bytes.subarray(this.bytes.byteLength - this.maxBufferedBytes);
    }
    this.events.emit('data', next);
  }

  text(): string {
    return this.bytes.toString('utf8');
  }

  collectUntil(options: CollectUntilOptions): Promise<CollectedTerminalOutput> {
    let collected = Buffer.alloc(0);
    let settled = false;
    let truncated = false;

    return new Promise((resolve) => {
      const finish = (timedOut: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.events.off('data', onData);
        const text = collected.toString('utf8');
        const index = text.indexOf(options.marker);
        resolve({
          output: index >= 0 ? text.slice(0, index) : text,
          timedOut,
          truncated
        });
      };

      const onData = (chunk: Buffer): void => {
        if (collected.byteLength < options.maxOutputBytes) {
          const remaining = options.maxOutputBytes - collected.byteLength;
          collected = Buffer.concat([collected, chunk.subarray(0, remaining)]);
          if (chunk.byteLength > remaining) {
            truncated = true;
          }
        } else {
          truncated = true;
        }
        if (collected.toString('utf8').includes(options.marker)) {
          finish(false);
        }
      };

      const timeout = setTimeout(() => finish(true), options.timeoutMs);
      this.events.on('data', onData);
    });
  }
}
```

- [ ] **Step 5: Extend TerminalContextRegistry**

Modify `src/terminal/TerminalContext.ts`:

```ts
import { TerminalOutputBuffer } from '../agent/TerminalOutputBuffer';
import { getAssetConnectionKind, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';
```

Add interfaces:

```ts
export interface TerminalContextSummary {
  terminalId: string;
  assetId: string;
  assetName: string;
  address: string;
  connectionKind: JumpServerConnectionKind;
  connected: boolean;
}

export interface TerminalContextSnapshot {
  activeTerminal?: TerminalContextSummary;
  connectedTerminals: TerminalContextSummary[];
  knownTerminals: TerminalContextSummary[];
}
```

Extend `ActiveTerminalContext`:

```ts
output?: TerminalOutputBuffer;
```

In `setActive`, ensure an output buffer exists:

```ts
const existing = this.contexts.get(context.terminalId);
const output = existing?.output ?? context.output ?? new TerminalOutputBuffer();
const next = { ...context, output };
this.contexts.set(next.terminalId, next);
this.active = next;
this.contextChanged.fire(next);
this.activeChanged.fire(this.active);
```

Add methods:

```ts
appendOutput(terminalId: string, data: Buffer | string): void {
  this.contexts.get(terminalId)?.output?.append(data);
}

getOutputBuffer(terminalId: string): TerminalOutputBuffer | undefined {
  return this.contexts.get(terminalId)?.output;
}

getSnapshot(): TerminalContextSnapshot {
  const knownTerminals = Array.from(this.contexts.values()).map(toSummary);
  return {
    activeTerminal: this.active ? toSummary(this.active) : undefined,
    connectedTerminals: knownTerminals.filter((terminal) => terminal.connected),
    knownTerminals
  };
}
```

Add helper:

```ts
function toSummary(context: ActiveTerminalContext): TerminalContextSummary {
  return {
    terminalId: context.terminalId,
    assetId: context.asset.id,
    assetName: context.asset.name,
    address: context.asset.address,
    connectionKind: getAssetConnectionKind(context.asset),
    connected: context.connected
  };
}
```

- [ ] **Step 6: Publish terminal output from TerminalPanel**

Modify `src/webview/TerminalPanel.ts` in `createSession()` output callback:

```ts
output: (data) => {
  this.terminalContext?.appendOutput(this.terminalId, data);
  this.postWebviewMessage({ type: 'outputBytes', payload: [...data] });
},
```

In any string output path, also append the string:

```ts
this.terminalContext?.appendOutput(this.terminalId, notice);
```

Add a public getter if missing:

```ts
getTerminalId(): string {
  return this.terminalId;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```powershell
npx vitest run test/agent/TerminalOutputBuffer.test.ts test/terminal/TerminalContext.test.ts test/webview/TerminalPanel.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/agent/TerminalOutputBuffer.ts src/terminal/TerminalContext.ts src/webview/TerminalPanel.ts test/agent/TerminalOutputBuffer.test.ts test/terminal/TerminalContext.test.ts test/webview/TerminalPanel.test.ts
git commit -m "feat: capture JumpServer terminal output"
```

---

### Task 5: Implement SQL Safety And Terminal Executors

**Files:**
- Create: `src/agent/SqlSafety.ts`
- Create: `src/agent/TerminalExecutors.ts`
- Test: `test/agent/SqlSafety.test.ts`
- Test: `test/agent/TerminalExecutors.test.ts`

- [ ] **Step 1: Write failing SQL safety tests**

Create `test/agent/SqlSafety.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isReadOnlySql } from '../../src/agent/SqlSafety';

describe('SqlSafety', () => {
  it.each([
    'select 1;',
    'SHOW DATABASES;',
    'describe users;',
    'desc users;',
    'EXPLAIN SELECT * FROM users;'
  ])('treats read-only SQL as safe: %s', (sql) => {
    expect(isReadOnlySql(sql)).toBe(true);
  });

  it.each([
    'insert into t values (1);',
    'update users set name = "x";',
    'delete from users;',
    'create table t(id int);',
    'alter table t add column name varchar(20);',
    'drop table t;',
    'truncate table t;',
    'call dangerous_proc();',
    'begin; select 1; commit;'
  ])('treats state-changing SQL as unsafe: %s', (sql) => {
    expect(isReadOnlySql(sql)).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing executor tests**

Create `test/agent/TerminalExecutors.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';
import { MysqlCliExecutor, ShellTerminalExecutor } from '../../src/agent/TerminalExecutors';

describe('TerminalExecutors', () => {
  it('runs shell commands with marker-bounded output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toContain('__JMS_CMD_START_');
      output.append('ignored echo\n');
      output.append('__JMS_CMD_START_abc__\nhello\n__JMS_CMD_END_abc__0\n');
    });
    const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

    await expect(executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'ssh-1',
      command: 'echo hello',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).resolves.toMatchObject({
      terminalId: 'terminal-1',
      stdout: '\nhello\n',
      exitCode: 0,
      timedOut: false,
      truncated: false
    });
  });

  it('runs MySQL SQL with marker-bounded output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toContain("SELECT '__JMS_SQL_START_abc__';");
      output.append("+-------------------------+\n");
      output.append("| __JMS_SQL_START_abc__ |\n");
      output.append("1 row in set\n");
      output.append("+---+\n| 1 |\n+---+\n");
      output.append("| __JMS_SQL_END_abc__ |\n");
    });
    const executor = new MysqlCliExecutor({ idFactory: () => 'abc' });

    await expect(executor.execute({
      terminalId: 'terminal-1',
      assetId: 'mysql-1',
      assetName: 'mysql-1',
      sql: 'select 1;',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).resolves.toMatchObject({
      terminalId: 'terminal-1',
      output: expect.stringContaining('| 1 |'),
      timedOut: false,
      truncated: false
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npx vitest run test/agent/SqlSafety.test.ts test/agent/TerminalExecutors.test.ts
```

Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement SQL classifier**

Create `src/agent/SqlSafety.ts`:

```ts
const READ_ONLY_START = /^(select|show|describe|desc|explain)\b/i;
const UNSAFE_KEYWORDS = /\b(insert|update|delete|replace|create|alter|drop|truncate|call|grant|revoke|set|begin|commit|rollback|lock|unlock|load|source)\b/i;

export function isReadOnlySql(sql: string): boolean {
  const stripped = stripSqlComments(sql).trim();
  if (!stripped) {
    return false;
  }
  if (UNSAFE_KEYWORDS.test(stripped)) {
    return false;
  }
  return READ_ONLY_START.test(stripped);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/#[^\n\r]*/g, ' ');
}
```

- [ ] **Step 5: Implement terminal executors**

Create `src/agent/TerminalExecutors.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { TerminalOutputBuffer } from './TerminalOutputBuffer';

export interface TerminalExecutionTarget {
  terminalId: string;
  assetId: string;
  assetName: string;
  write(data: string): void;
  output: TerminalOutputBuffer;
}

export interface ShellCommandExecutionInput extends TerminalExecutionTarget {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ShellCommandExecutionResult {
  terminalId: string;
  assetId: string;
  assetName: string;
  command: string;
  cwd?: string;
  stdout: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface MysqlSqlExecutionInput extends TerminalExecutionTarget {
  sql: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface MysqlSqlExecutionResult {
  terminalId: string;
  assetId: string;
  assetName: string;
  sql: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 256_000;

export class ShellTerminalExecutor {
  constructor(private readonly options: { idFactory?: () => string } = {}) {}

  async execute(input: ShellCommandExecutionInput): Promise<ShellCommandExecutionResult> {
    const id = this.options.idFactory?.() ?? randomUUID().replaceAll('-', '');
    const startMarker = `__JMS_CMD_START_${id}__`;
    const endMarker = `__JMS_CMD_END_${id}__`;
    const timeoutMs = clamp(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clamp(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();

    const command = wrapShellCommand(input.command, input.cwd, startMarker, endMarker);
    const collection = input.output.collectUntil({ marker: endMarker, timeoutMs, maxOutputBytes });
    input.write(command);
    const collected = await collection;
    const stdout = trimBeforeMarker(collected.output, startMarker);
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      command: input.command,
      cwd: input.cwd,
      stdout,
      exitCode: parseExitCode(collected.output, endMarker),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated
    };
  }
}

export class MysqlCliExecutor {
  constructor(private readonly options: { idFactory?: () => string } = {}) {}

  async execute(input: MysqlSqlExecutionInput): Promise<MysqlSqlExecutionResult> {
    const id = this.options.idFactory?.() ?? randomUUID().replaceAll('-', '');
    const startMarker = `__JMS_SQL_START_${id}__`;
    const endMarker = `__JMS_SQL_END_${id}__`;
    const timeoutMs = clamp(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clamp(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();
    const collection = input.output.collectUntil({ marker: endMarker, timeoutMs, maxOutputBytes });
    input.write(`SELECT '${startMarker}';\n${ensureSemicolon(input.sql)}\nSELECT '${endMarker}';\n`);
    const collected = await collection;
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      sql: input.sql,
      output: trimBeforeMarker(collected.output, startMarker),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated
    };
  }
}

function wrapShellCommand(command: string, cwd: string | undefined, startMarker: string, endMarker: string): string {
  const body = cwd?.trim()
    ? `cd ${quotePosix(cwd.trim())} && ${command}`
    : command;
  return `printf '\\n${startMarker}\\n'\n${body}\nprintf '\\n${endMarker}%s\\n' "$?"\n`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ensureSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function trimBeforeMarker(text: string, marker: string): string {
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

function parseExitCode(text: string, marker: string): number | null {
  const match = text.match(new RegExp(`${marker}(\\d+)`));
  return match ? Number(match[1]) : null;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```powershell
npx vitest run test/agent/SqlSafety.test.ts test/agent/TerminalExecutors.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/agent/SqlSafety.ts src/agent/TerminalExecutors.ts test/agent/SqlSafety.test.ts test/agent/TerminalExecutors.test.ts
git commit -m "feat: add JumpServer terminal executors"
```

---

### Task 6: Implement JumpServer Agent Tool Service

**Files:**
- Create: `src/agent/JumpServerAgentToolService.ts`
- Test: `test/agent/JumpServerAgentToolService.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `test/agent/JumpServerAgentToolService.test.ts` with tests for asset listing, terminal context, SQL safety confirmation, and SFTP routing:

```ts
import { describe, expect, it, vi } from 'vitest';
import { JumpServerAgentToolService } from '../../src/agent/JumpServerAgentToolService';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

describe('JumpServerAgentToolService', () => {
  it('lists cached assets without raw secrets', async () => {
    const service = serviceWith({
      configManager: {
        listCachedAssets: async () => [{
          id: 'asset-1',
          name: 'db',
          address: '10.0.0.1',
          platform: 'MySQL',
          category: 'database',
          type: 'mysql',
          zoneName: '',
          nodePath: ['Default'],
          protocolNames: ['mysql'],
          raw: { password: 'hidden', visible: 'ok' }
        }]
      }
    });
    await expect(service.listAssets()).resolves.toEqual({
      assets: [expect.objectContaining({
        assetId: 'asset-1',
        name: 'db',
        connectionKind: 'mysql'
      })]
    });
    expect(JSON.stringify(await service.listAssets())).not.toContain('hidden');
  });

  it('returns terminal context snapshots', async () => {
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      asset: asset({ id: 'ssh-1', name: 'ssh-1', protocolNames: ['ssh'] }),
      connected: true,
      write: vi.fn()
    });
    const service = serviceWith({ terminalContext });

    await expect(service.getTerminalContext()).resolves.toMatchObject({
      activeTerminal: { terminalId: 'terminal-1', connectionKind: 'ssh' },
      connectedTerminals: [{ terminalId: 'terminal-1', connectionKind: 'ssh' }]
    });
  });

  it('requires confirmation for dangerous SQL', async () => {
    const confirm = vi.fn(async () => false);
    const service = serviceWith({ confirm });
    await expect(service.mysqlExecuteSql({ terminalId: 'active', sql: 'drop table users;' })).rejects.toThrow(
      'MySQL SQL execution was cancelled.'
    );
    expect(confirm).toHaveBeenCalled();
  });

  it('routes SFTP list to the manager', async () => {
    const sftp = { listDirectory: vi.fn(async () => [{ name: 'app.txt', path: '/app.txt', type: 'file' }]) };
    const service = serviceWith({ sftp });
    await expect(service.sftpListDirectory({ path: '/' })).resolves.toEqual({
      entries: [{ name: 'app.txt', path: '/app.txt', type: 'file' }]
    });
  });
});

function serviceWith(overrides: Record<string, unknown>) {
  return new JumpServerAgentToolService({
    configManager: {
      listCachedAssets: async () => [],
      ...(overrides.configManager as object)
    } as never,
    terminalContext: (overrides.terminalContext as TerminalContextRegistry) ?? new TerminalContextRegistry(),
    sftp: (overrides.sftp as never) ?? {},
    confirm: (overrides.confirm as never) ?? vi.fn(async () => true)
  });
}

function asset(overrides: Record<string, unknown>) {
  return {
    id: 'asset-1',
    name: 'asset-1',
    address: '',
    platform: '',
    category: '',
    type: '',
    zoneName: '',
    nodePath: [],
    protocolNames: [],
    raw: {},
    ...overrides
  } as never;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npx vitest run test/agent/JumpServerAgentToolService.test.ts
```

Expected: FAIL because `JumpServerAgentToolService` does not exist.

- [ ] **Step 3: Implement service skeleton and read tools**

Create `src/agent/JumpServerAgentToolService.ts` with:

```ts
import type { JumpServerConfigManager } from '../config/JumpServerConfigManager';
import type { CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind } from '../jumpserver/connectionTypes';
import type { JumpServerSftpManager } from '../sftp/JumpServerSftpManager';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { isReadOnlySql } from './SqlSafety';
import { MysqlCliExecutor, ShellTerminalExecutor } from './TerminalExecutors';

export interface JumpServerAgentToolServiceDependencies {
  configManager: Pick<JumpServerConfigManager, 'listCachedAssets'>;
  terminalContext: TerminalContextRegistry;
  sftp: Pick<JumpServerSftpManager,
    'listDirectory' | 'stat' | 'readFile' | 'writeFile' | 'createFile' | 'mkdir' | 'rename' | 'deleteEntry'
  >;
  confirm(message: string): Promise<boolean>;
  shellExecutor?: ShellTerminalExecutor;
  mysqlExecutor?: MysqlCliExecutor;
}

export class JumpServerAgentToolService {
  private readonly shellExecutor: ShellTerminalExecutor;
  private readonly mysqlExecutor: MysqlCliExecutor;

  constructor(private readonly dependencies: JumpServerAgentToolServiceDependencies) {
    this.shellExecutor = dependencies.shellExecutor ?? new ShellTerminalExecutor();
    this.mysqlExecutor = dependencies.mysqlExecutor ?? new MysqlCliExecutor();
  }

  async listAssets() {
    const assets = await this.dependencies.configManager.listCachedAssets();
    return { assets: assets.map(assetSummary) };
  }

  async getTerminalContext() {
    return this.dependencies.terminalContext.getSnapshot();
  }

  async mysqlGetContext() {
    const snapshot = this.dependencies.terminalContext.getSnapshot();
    return {
      activeTerminal: snapshot.activeTerminal?.connectionKind === 'mysql' ? snapshot.activeTerminal : undefined,
      connectedTerminals: snapshot.connectedTerminals.filter((terminal) => terminal.connectionKind === 'mysql'),
      knownTerminals: snapshot.knownTerminals.filter((terminal) => terminal.connectionKind === 'mysql')
    };
  }
}

function assetSummary(asset: CachedJumpServerAsset) {
  return {
    assetId: asset.id,
    name: asset.name,
    address: asset.address,
    platform: asset.platform,
    category: asset.category,
    type: asset.type,
    protocolNames: asset.protocolNames,
    connectionKind: getAssetConnectionKind(asset),
    nodePath: asset.nodePath
  };
}
```

- [ ] **Step 4: Add terminal target resolution and terminal tools**

Add methods:

```ts
async sendTerminalInput(input: { terminalId?: string; input?: string }) {
  const target = this.resolveTerminal(input.terminalId);
  const data = input.input ?? '';
  target.write(data);
  return { terminalId: target.terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
}

async runTerminalCommand(input: { terminalId?: string; command?: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number }) {
  const command = input.command?.trim();
  if (!command) {
    throw new Error('Terminal command cannot be empty.');
  }
  const target = this.resolveTerminal(input.terminalId);
  if (getAssetConnectionKind(target.asset) !== 'ssh') {
    throw new Error('A connected JumpServer SSH terminal is required.');
  }
  if (!await this.dependencies.confirm(`Run JumpServer SSH command on ${target.asset.name}?\n\n${command}`)) {
    throw new Error('Terminal command was cancelled.');
  }
  const output = this.dependencies.terminalContext.getOutputBuffer(target.terminalId);
  if (!output) {
    throw new Error('Terminal output capture is not available.');
  }
  return await this.shellExecutor.execute({
    terminalId: target.terminalId,
    assetId: target.asset.id,
    assetName: target.asset.name,
    command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    write: target.write,
    output
  });
}
```

Add helper:

```ts
private resolveTerminal(terminalId: string | undefined) {
  const targetId = terminalId === 'active' ? undefined : terminalId;
  const context = targetId
    ? this.dependencies.terminalContext.getContext(targetId)
    : this.dependencies.terminalContext.getActive();
  if (!context || !context.connected) {
    throw new Error('No matching connected JumpServer terminal is available. Connect a JumpServer asset first.');
  }
  return context;
}
```

- [ ] **Step 5: Add MySQL tools**

Add:

```ts
async mysqlSendInput(input: { terminalId?: string; input?: string }) {
  const target = this.resolveTerminal(input.terminalId);
  if (getAssetConnectionKind(target.asset) !== 'mysql') {
    throw new Error('A connected JumpServer MySQL terminal is required.');
  }
  const data = input.input ?? '';
  target.write(data);
  return { terminalId: target.terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
}

async mysqlExecuteSql(input: { terminalId?: string; sql?: string; timeoutMs?: number; maxOutputBytes?: number }) {
  const sql = input.sql?.trim();
  if (!sql) {
    throw new Error('MySQL SQL cannot be empty.');
  }
  const target = this.resolveTerminal(input.terminalId);
  if (getAssetConnectionKind(target.asset) !== 'mysql') {
    throw new Error('A connected JumpServer MySQL terminal is required.');
  }
  if (!isReadOnlySql(sql)) {
    const ok = await this.dependencies.confirm(`Run state-changing MySQL SQL on ${target.asset.name}?\n\n${sql}`);
    if (!ok) {
      throw new Error('MySQL SQL execution was cancelled.');
    }
  }
  const output = this.dependencies.terminalContext.getOutputBuffer(target.terminalId);
  if (!output) {
    throw new Error('Terminal output capture is not available.');
  }
  return await this.mysqlExecutor.execute({
    terminalId: target.terminalId,
    assetId: target.asset.id,
    assetName: target.asset.name,
    sql,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    write: target.write,
    output
  });
}
```

- [ ] **Step 6: Add SFTP tools**

Add methods:

```ts
async sftpListDirectory(input: { connectionKey?: string; terminalId?: string; path?: string }) {
  return { entries: await this.dependencies.sftp.listDirectory(input.path) };
}

async sftpStatPath(input: { connectionKey?: string; terminalId?: string; path: string }) {
  return await this.dependencies.sftp.stat(input.path, input.connectionKey ?? input.terminalId);
}

async sftpReadFile(input: { connectionKey?: string; terminalId?: string; path: string; maxBytes?: number }) {
  const maxBytes = clampReadBytes(input.maxBytes);
  const buffer = await this.dependencies.sftp.readFile(input.path, maxBytes, input.connectionKey ?? input.terminalId);
  if (buffer.includes(0)) {
    throw new Error('Remote file appears to be binary.');
  }
  return { path: input.path, content: buffer.toString('utf8'), truncated: buffer.byteLength >= maxBytes };
}

async sftpWriteFile(input: { connectionKey?: string; terminalId?: string; path: string; content: string; overwrite?: boolean }) {
  await this.requireConfirm(`Write JumpServer SFTP file ${input.path}?`);
  await this.dependencies.sftp.writeFile(input.path, Buffer.from(input.content, 'utf8'), input.connectionKey ?? input.terminalId);
  return { path: input.path, bytesWritten: Buffer.byteLength(input.content, 'utf8') };
}

async sftpCreateFile(input: { connectionKey?: string; terminalId?: string; path: string; content?: string }) {
  await this.requireConfirm(`Create JumpServer SFTP file ${input.path}?`);
  if (input.content === undefined) {
    await this.dependencies.sftp.createFile(input.path, input.connectionKey ?? input.terminalId);
  } else {
    await this.dependencies.sftp.writeFile(input.path, Buffer.from(input.content, 'utf8'), input.connectionKey ?? input.terminalId);
  }
  return { path: input.path };
}

async sftpCreateDirectory(input: { connectionKey?: string; terminalId?: string; path: string }) {
  await this.requireConfirm(`Create JumpServer SFTP directory ${input.path}?`);
  await this.dependencies.sftp.mkdir(input.path);
  return { path: input.path };
}

async sftpRename(input: { connectionKey?: string; terminalId?: string; oldPath: string; newPath: string }) {
  await this.requireConfirm(`Rename JumpServer SFTP path ${input.oldPath} to ${input.newPath}?`);
  await this.dependencies.sftp.rename(input.oldPath, input.newPath);
  return { oldPath: input.oldPath, newPath: input.newPath };
}

async sftpDelete(input: { connectionKey?: string; terminalId?: string; path: string }) {
  await this.requireConfirm(`Delete JumpServer SFTP path ${input.path}?`);
  await this.dependencies.sftp.deleteEntry({ name: input.path.split('/').pop() || input.path, path: input.path, type: 'file' });
  return { path: input.path, deleted: true };
}
```

Add helpers:

```ts
private async requireConfirm(message: string): Promise<void> {
  if (!await this.dependencies.confirm(message)) {
    throw new Error('JumpServer operation was cancelled.');
  }
}

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return 64 * 1024;
  }
  return Math.min(value, 256 * 1024);
}
```

- [ ] **Step 7: Run tests**

Run:

```powershell
npx vitest run test/agent/JumpServerAgentToolService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/agent/JumpServerAgentToolService.ts test/agent/JumpServerAgentToolService.test.ts
git commit -m "feat: add JumpServer agent tool service"
```

---

### Task 7: Implement Bridge Server

**Files:**
- Create: `src/mcp/BridgeServer.ts`
- Test: `test/mcp/BridgeServer.test.ts`

- [ ] **Step 1: Write failing bridge server tests**

Create `test/mcp/BridgeServer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBridgeRequestHandler } from '../../src/mcp/BridgeServer';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

describe('JumpServer BridgeServer', () => {
  it('rejects requests without the bridge token', async () => {
    const handler = createBridgeRequestHandler({ service: service(), token: 'secret' });
    await expect(handler({ method: 'POST', path: '/tools/jumpserver_list_assets', headers: {}, body: '{}' }))
      .resolves.toEqual({ status: 401, body: { error: 'Unauthorized JumpServer MCP bridge request.' } });
  });

  it('routes list assets requests', async () => {
    const svc = service({ listAssets: vi.fn(async () => ({ assets: [] })) });
    const handler = createBridgeRequestHandler({ service: svc, token: 'secret' });
    await expect(handler({
      method: 'POST',
      path: '/tools/jumpserver_list_assets',
      headers: { [BRIDGE_TOKEN_HEADER]: 'secret' },
      body: '{}'
    })).resolves.toEqual({ status: 200, body: { assets: [] } });
  });

  it('returns 404 for unknown endpoints', async () => {
    const handler = createBridgeRequestHandler({ service: service(), token: 'secret' });
    await expect(handler({
      method: 'POST',
      path: '/tools/unknown',
      headers: { [BRIDGE_TOKEN_HEADER]: 'secret' },
      body: '{}'
    })).resolves.toEqual({ status: 404, body: { error: 'Unknown AT JumpServer Terminal MCP bridge endpoint.' } });
  });
});

function service(overrides = {}) {
  return {
    listAssets: async () => ({}),
    getTerminalContext: async () => ({}),
    sendTerminalInput: async () => ({}),
    runTerminalCommand: async () => ({}),
    sftpListDirectory: async () => ({}),
    sftpStatPath: async () => ({}),
    sftpReadFile: async () => ({}),
    sftpWriteFile: async () => ({}),
    sftpCreateFile: async () => ({}),
    sftpCreateDirectory: async () => ({}),
    sftpRename: async () => ({}),
    sftpDelete: async () => ({}),
    mysqlGetContext: async () => ({}),
    mysqlSendInput: async () => ({}),
    mysqlExecuteSql: async () => ({}),
    ...overrides
  } as never;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npx vitest run test/mcp/BridgeServer.test.ts
```

Expected: FAIL because `BridgeServer` does not exist.

- [ ] **Step 3: Implement BridgeServer**

Create `src/mcp/BridgeServer.ts` modeled after `ssh-plugins/src/mcp/BridgeServer.ts`, but with JumpServer names and endpoints:

```ts
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import type { JumpServerAgentToolService } from '../agent/JumpServerAgentToolService';
import { formatError } from '../utils/errors';
import { removeBridgeDiscovery, writeBridgeDiscovery } from './BridgeDiscovery';
import { BRIDGE_HOST, BRIDGE_TOKEN_HEADER } from './BridgeProtocol';

export interface BridgeHandlerDependencies {
  service: JumpServerAgentToolService;
  token: string;
}

export interface BridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

export class BridgeServer {
  private server: Server | undefined;
  private token = '';
  private port: number | undefined;

  constructor(private readonly service: JumpServerAgentToolService, private readonly home = homedir()) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = randomBytes(32).toString('hex');
    const handler = createBridgeRequestHandler({ service: this.service, token: this.token });
    this.server = createServer((request, response) => {
      void handleNodeRequest(handler, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, BRIDGE_HOST, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start AT JumpServer Terminal MCP bridge.');
    }
    this.port = address.port;
    await writeBridgeDiscovery(this.home, { port: address.port, token: this.token, pid: process.pid, updatedAt: Date.now() });
  }

  async dispose(): Promise<void> {
    const server = this.server;
    const port = this.port;
    const token = this.token;
    this.server = undefined;
    this.port = undefined;
    await removeBridgeDiscovery(this.home, port && token ? { port, token, pid: process.pid } : undefined);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
```

Add `createBridgeRequestHandler` routes for every tool:

```ts
export function createBridgeRequestHandler(dependencies: BridgeHandlerDependencies) {
  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    try {
      if (request.headers[BRIDGE_TOKEN_HEADER] !== dependencies.token) {
        return json(401, { error: 'Unauthorized JumpServer MCP bridge request.' });
      }
      if (request.path === '/health') {
        return json(200, { ok: true });
      }
      if (request.method !== 'POST') {
        return json(405, { error: 'Method not allowed.' });
      }
      const body = parseBody(request.body);
      if (request.path === '/tools/jumpserver_list_assets') return json(200, await dependencies.service.listAssets());
      if (request.path === '/tools/jumpserver_get_terminal_context') return json(200, await dependencies.service.getTerminalContext());
      if (request.path === '/tools/jumpserver_send_terminal_input') return json(200, await dependencies.service.sendTerminalInput(body as never));
      if (request.path === '/tools/jumpserver_run_terminal_command') return json(200, await dependencies.service.runTerminalCommand(body as never));
      if (request.path === '/tools/jumpserver_sftp_list_directory') return json(200, await dependencies.service.sftpListDirectory(body as never));
      if (request.path === '/tools/jumpserver_sftp_stat_path') return json(200, await dependencies.service.sftpStatPath(body as never));
      if (request.path === '/tools/jumpserver_sftp_read_file') return json(200, await dependencies.service.sftpReadFile(body as never));
      if (request.path === '/tools/jumpserver_sftp_write_file') return json(200, await dependencies.service.sftpWriteFile(body as never));
      if (request.path === '/tools/jumpserver_sftp_create_file') return json(200, await dependencies.service.sftpCreateFile(body as never));
      if (request.path === '/tools/jumpserver_sftp_create_directory') return json(200, await dependencies.service.sftpCreateDirectory(body as never));
      if (request.path === '/tools/jumpserver_sftp_rename') return json(200, await dependencies.service.sftpRename(body as never));
      if (request.path === '/tools/jumpserver_sftp_delete') return json(200, await dependencies.service.sftpDelete(body as never));
      if (request.path === '/tools/jumpserver_mysql_get_context') return json(200, await dependencies.service.mysqlGetContext());
      if (request.path === '/tools/jumpserver_mysql_send_input') return json(200, await dependencies.service.mysqlSendInput(body as never));
      if (request.path === '/tools/jumpserver_mysql_execute_sql') return json(200, await dependencies.service.mysqlExecuteSql(body as never));
      return json(404, { error: 'Unknown AT JumpServer Terminal MCP bridge endpoint.' });
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
```

Add local helpers `parseBody`, `json`, and `handleNodeRequest` from `ssh-plugins`, with JumpServer names.

- [ ] **Step 4: Run tests**

Run:

```powershell
npx vitest run test/mcp/BridgeServer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/mcp/BridgeServer.ts test/mcp/BridgeServer.test.ts
git commit -m "feat: add JumpServer MCP bridge server"
```

---

### Task 8: Implement MCP Stdio Server

**Files:**
- Create: `src/mcp/server.ts`
- Test: `test/mcp/McpServerTools.test.ts`

- [ ] **Step 1: Write failing MCP server test**

Create `test/mcp/McpServerTools.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { JUMPSERVER_MCP_TOOL_NAMES } from '../../src/mcp/BridgeProtocol';

describe('JumpServer MCP server', () => {
  it('registers every JumpServer MCP tool name', async () => {
    const text = await readFile('src/mcp/server.ts', 'utf8');
    for (const toolName of JUMPSERVER_MCP_TOOL_NAMES) {
      expect(text).toContain(`'${toolName}'`);
    }
    expect(text).toContain("name: 'at-jumpserver-terminal'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run test/mcp/McpServerTools.test.ts
```

Expected: FAIL because `src/mcp/server.ts` does not exist.

- [ ] **Step 3: Implement MCP server**

Create `src/mcp/server.ts` following `ssh-plugins/src/mcp/server.ts`. Use:

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeClient } from './BridgeClient';

const bridge = new BridgeClient();
const server = new McpServer({
  name: 'at-jumpserver-terminal',
  version: '0.1.1'
});
```

Register all 15 tools. Example:

```ts
server.registerTool(
  'jumpserver_list_assets',
  {
    title: 'JumpServer List Assets',
    description: 'List cached AT JumpServer Terminal assets without exposing credentials.',
    inputSchema: {}
  },
  async () => textResult(await bridge.listAssets())
);
```

Use schemas:

```ts
const terminalTargetSchema = {
  terminalId: z.string().optional().describe('JumpServer terminal id, or active for the active terminal.')
};

const sftpTargetSchema = {
  connectionKey: z.string().optional().describe('JumpServer SFTP connection key.'),
  terminalId: z.string().optional().describe('JumpServer terminal id.')
};

const sftpPathSchema = {
  ...sftpTargetSchema,
  path: z.string().min(1).describe('Remote POSIX path.')
};
```

End with:

```ts
function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run MCP server test and build**

Run:

```powershell
npx vitest run test/mcp/McpServerTools.test.ts
npm run build
```

Expected: PASS and build emits `dist/mcp-server.js`.

- [ ] **Step 5: Commit**

```powershell
git add src/mcp/server.ts test/mcp/McpServerTools.test.ts
git commit -m "feat: add JumpServer MCP stdio server"
```

---

### Task 9: Implement MCP Config Installer

**Files:**
- Create: `src/mcp/McpConfigInstaller.ts`
- Test: `test/mcp/McpConfigInstaller.test.ts`

- [ ] **Step 1: Write failing installer tests**

Create `test/mcp/McpConfigInstaller.test.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContinueMcpConfig,
  cursorMcpConfigPath,
  installIdeMcpConfig,
  kiroMcpConfigPath,
  resolveIdeMcpConfigTarget
} from '../../src/mcp/McpConfigInstaller';

describe('JumpServer McpConfigInstaller', () => {
  it('builds Continue config with JumpServer server name', () => {
    expect(buildContinueMcpConfig('C:\\ext\\dist\\mcp-server.js')).toContain('name: AT JumpServer Terminal');
    expect(buildContinueMcpConfig('C:\\ext\\dist\\mcp-server.js')).toContain('C:/ext/dist/mcp-server.js');
  });

  it('resolves Kiro and Cursor targets', () => {
    expect(resolveIdeMcpConfigTarget({ appName: 'Kiro' })).toEqual({ id: 'kiro', displayName: 'Kiro' });
    expect(resolveIdeMcpConfigTarget({ appName: 'Cursor' })).toEqual({ id: 'cursor', displayName: 'Cursor' });
  });

  it('writes Kiro MCP config without removing existing servers', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-mcp-installer');
    const existingPath = kiroMcpConfigPath(home);
    await mkdir(existingPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(existingPath, JSON.stringify({ mcpServers: { Existing: { command: 'node', args: ['old.js'] } } }), 'utf8');

    await installIdeMcpConfig({
      home,
      target: { id: 'kiro', displayName: 'Kiro' },
      mcpServerPath: join(home, 'dist', 'mcp-server.js'),
      waitForServerMs: 0
    });
    const parsed = JSON.parse(await readFile(existingPath, 'utf8'));
    expect(parsed.mcpServers.Existing).toBeDefined();
    expect(parsed.mcpServers['AT JumpServer Terminal']).toMatchObject({ command: 'node' });
  });

  it('uses a Cursor-specific config path', () => {
    expect(cursorMcpConfigPath('C:/Users/test').replaceAll('\\', '/')).toBe('C:/Users/test/.cursor/mcp.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run test/mcp/McpConfigInstaller.test.ts
```

Expected: FAIL because installer does not exist.

- [ ] **Step 3: Implement installer**

Create `src/mcp/McpConfigInstaller.ts` by adapting `ssh-plugins/src/mcp/McpConfigInstaller.ts` with these replacements:

- Server display name: `AT JumpServer Terminal`
- Continue path: `.continue/mcpServers/at-jumpserver-terminal.yaml`
- Kiro/Cursor key: `AT JumpServer Terminal`
- Tool list: `JUMPSERVER_MCP_TOOL_NAMES`
- Missing bundle error: `AT JumpServer Terminal MCP server bundle is missing: ...`

The main config builder should be:

```ts
export function buildContinueMcpConfig(mcpServerPath: string): string {
  const normalized = normalizePath(mcpServerPath);
  return `name: AT JumpServer Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT JumpServer Terminal
    command: node
    args:
      - ${normalized}
`;
}
```

For JSON configs:

```ts
function buildIdeMcpServerConfig(mcpServerPath: string): Record<string, unknown> {
  return {
    command: 'node',
    args: [normalizePath(mcpServerPath)],
    autoApprove: [
      'jumpserver_list_assets',
      'jumpserver_get_terminal_context',
      'jumpserver_sftp_list_directory',
      'jumpserver_sftp_stat_path',
      'jumpserver_sftp_read_file',
      'jumpserver_mysql_get_context'
    ]
  };
}
```

- [ ] **Step 4: Run installer tests**

Run:

```powershell
npx vitest run test/mcp/McpConfigInstaller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/mcp/McpConfigInstaller.ts test/mcp/McpConfigInstaller.test.ts
git commit -m "feat: add JumpServer MCP config installer"
```

---

### Task 10: Register Agent Tools And Wire Extension Bridge

**Files:**
- Create: `src/agent/AgentTools.ts`
- Modify: `src/extension.ts`
- Test: `test/agent/AgentTools.test.ts`
- Test: `test/extension/ExtensionCommands.test.ts`

- [ ] **Step 1: Write failing AgentTools test**

Create `test/agent/AgentTools.test.ts`:

```ts
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { registerAgentTools } from '../../src/agent/AgentTools';

describe('JumpServer AgentTools', () => {
  it('registers every JumpServer language model tool', () => {
    const service = new Proxy({}, { get: () => vi.fn(async () => ({})) });
    registerAgentTools(service as never);
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('jumpserver_list_assets', expect.anything());
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('jumpserver_mysql_execute_sql', expect.anything());
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('jumpserver_sftp_delete', expect.anything());
  });
});
```

- [ ] **Step 2: Extend extension command tests**

In `test/extension/ExtensionCommands.test.ts`, add:

```ts
it('registers JumpServer MCP install command', () => {
  activate(extensionContext());
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.installMcpConfig', expect.any(Function));
});
```

If test fixtures do not mock `vscode.lm.registerTool`, add it to `test-fixtures/vscode.ts`:

```ts
export const lm = {
  registerTool: vi.fn(() => ({ dispose: vi.fn() }))
};
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npx vitest run test/agent/AgentTools.test.ts test/extension/ExtensionCommands.test.ts
```

Expected: FAIL because tools and command are not wired.

- [ ] **Step 4: Implement AgentTools**

Create `src/agent/AgentTools.ts`:

```ts
import * as vscode from 'vscode';
import type { JumpServerAgentToolService } from './JumpServerAgentToolService';

export function registerAgentTools(service: JumpServerAgentToolService): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('jumpserver_list_assets', new JsonTool(() => service.listAssets())),
    vscode.lm.registerTool('jumpserver_get_terminal_context', new JsonTool(() => service.getTerminalContext())),
    vscode.lm.registerTool('jumpserver_send_terminal_input', new JsonTool((input) => service.sendTerminalInput(input as never))),
    vscode.lm.registerTool('jumpserver_run_terminal_command', new JsonTool((input) => service.runTerminalCommand(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_list_directory', new JsonTool((input) => service.sftpListDirectory(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_stat_path', new JsonTool((input) => service.sftpStatPath(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_read_file', new JsonTool((input) => service.sftpReadFile(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_write_file', new JsonTool((input) => service.sftpWriteFile(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_create_file', new JsonTool((input) => service.sftpCreateFile(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_create_directory', new JsonTool((input) => service.sftpCreateDirectory(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_rename', new JsonTool((input) => service.sftpRename(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_delete', new JsonTool((input) => service.sftpDelete(input as never))),
    vscode.lm.registerTool('jumpserver_mysql_get_context', new JsonTool(() => service.mysqlGetContext())),
    vscode.lm.registerTool('jumpserver_mysql_send_input', new JsonTool((input) => service.mysqlSendInput(input as never))),
    vscode.lm.registerTool('jumpserver_mysql_execute_sql', new JsonTool((input) => service.mysqlExecuteSql(input as never)))
  ];
}

class JsonTool<TInput extends object> implements vscode.LanguageModelTool<TInput> {
  constructor(private readonly invokeJson: (input: TInput) => Promise<unknown>) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<TInput>): Promise<vscode.LanguageModelToolResult> {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(await this.invokeJson((options.input ?? {}) as TInput), null, 2))
    ]);
  }
}
```

- [ ] **Step 5: Wire extension**

Modify `src/extension.ts`:

Imports:

```ts
import { registerAgentTools } from './agent/AgentTools';
import { JumpServerAgentToolService } from './agent/JumpServerAgentToolService';
import { BridgeServer } from './mcp/BridgeServer';
import { ensureIdeMcpConfig, resolveIdeMcpConfigTarget } from './mcp/McpConfigInstaller';
```

After SFTP setup:

```ts
const agentService = new JumpServerAgentToolService({
  configManager,
  terminalContext,
  sftp: sftpManager,
  confirm: async (message) => {
    const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Continue');
    return answer === 'Continue';
  }
});
const bridgeServer = new BridgeServer(agentService);
void bridgeServer.start().catch((error) => {
  void showTimedNotification(`JumpServer MCP bridge failed to start: ${errorMessage(error)}`, 'warning');
});
```

Add to cleanup:

```ts
void bridgeServer.dispose();
```

Push subscriptions:

```ts
...registerAgentTools(agentService),
```

Register install command:

```ts
vscode.commands.registerCommand('jumpserverManager.installMcpConfig', async () => {
  await runCommand(async () => {
    const target = resolveIdeMcpConfigTarget({
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      extensionPath: context.extensionPath
    });
    const installed = await ensureIdeMcpConfig({
      target,
      mcpServerPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath
    });
    await showTimedNotification(installed ? `JumpServer MCP config installed: ${installed}` : 'JumpServer MCP config is already installed.');
  });
})
```

- [ ] **Step 6: Run tests**

Run:

```powershell
npx vitest run test/agent/AgentTools.test.ts test/extension/ExtensionCommands.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/agent/AgentTools.ts src/extension.ts test/agent/AgentTools.test.ts test/extension/ExtensionCommands.test.ts test-fixtures/vscode.ts
git commit -m "feat: wire JumpServer MCP into extension"
```

---

### Task 11: Add MCP Documentation And Skill

**Files:**
- Create: `docs/mcp/continue-at-jumpserver-terminal-mcp.yaml`
- Create: `skills/at-jumpserver-terminal-mcp/SKILL.md`
- Modify: `README.md`
- Test: `test/docs/JumpServerMcpDocs.test.ts`

- [ ] **Step 1: Write failing docs tests**

Create `test/docs/JumpServerMcpDocs.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('JumpServer MCP docs', () => {
  it('documents Continue config with JumpServer MCP server name', async () => {
    const text = await readFile('docs/mcp/continue-at-jumpserver-terminal-mcp.yaml', 'utf8');
    expect(text).toContain('AT JumpServer Terminal');
    expect(text).toContain('dist/mcp-server.js');
  });

  it('documents JumpServer-specific MCP tool workflow in the skill', async () => {
    const text = await readFile('skills/at-jumpserver-terminal-mcp/SKILL.md', 'utf8');
    expect(text).toContain('jumpserver_get_terminal_context');
    expect(text).toContain('jumpserver_mysql_execute_sql');
    expect(text).toContain('Do not read local VS Code secret storage');
  });

  it('mentions MCP support in README', async () => {
    const text = await readFile('README.md', 'utf8');
    expect(text).toContain('MCP');
    expect(text).toContain('JumpServer: Install MCP Config');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npx vitest run test/docs/JumpServerMcpDocs.test.ts
```

Expected: FAIL because docs and skill do not exist.

- [ ] **Step 3: Add Continue config sample**

Create `docs/mcp/continue-at-jumpserver-terminal-mcp.yaml`:

```yaml
name: AT JumpServer Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT JumpServer Terminal
    command: node
    args:
      - C:/ABSOLUTE/PATH/TO/AT-JUMPSERVER-TERMINAL/dist/mcp-server.js
```

- [ ] **Step 4: Add skill**

Create `skills/at-jumpserver-terminal-mcp/SKILL.md`:

```md
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
```

- [ ] **Step 5: Update README**

Add to `README.md` supported list:

```md
- MCP tools for JumpServer assets, terminal context, SFTP, SSH terminal commands, and MySQL CLI SQL execution
```

Add setup step:

```md
7. Optional: run `JumpServer: Install MCP Config` to expose JumpServer tools to MCP-capable agents.
```

Remove `MCP and Agent tools` from the not-supported list.

- [ ] **Step 6: Run docs tests**

Run:

```powershell
npx vitest run test/docs/JumpServerMcpDocs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add docs/mcp/continue-at-jumpserver-terminal-mcp.yaml skills/at-jumpserver-terminal-mcp/SKILL.md README.md test/docs/JumpServerMcpDocs.test.ts
git commit -m "docs: document JumpServer MCP tools"
```

---

### Task 12: Full Verification And Polish

**Files:**
- Modify only files needed to fix verification failures.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: PASS and `dist/mcp-server.js` exists.

- [ ] **Step 4: Inspect changed files**

Run:

```powershell
git status --short
git diff --stat
```

Expected: only intended MCP, agent, terminal context, manifest, docs, and tests changed.

- [ ] **Step 5: Commit verification fixes if any**

If verification required edits:

```powershell
git add <changed-files>
git commit -m "fix: stabilize JumpServer MCP verification"
```

If no edits were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Coexistence with `ssh-plugins`: Tasks 2, 3, 7, 9.
- JumpServer-specific tool names: Tasks 1, 2, 8, 10.
- Bridge server and stdio MCP server: Tasks 3, 7, 8.
- Existing SSH/MySQL/SFTP runtime usage: Tasks 4, 5, 6, 10.
- MySQL terminal and SQL tools: Tasks 5, 6, 8, 10.
- Confirmation safety model: Tasks 5, 6, 10.
- Installer, docs, skill: Tasks 9 and 11.
- Tests and verification: every task plus Task 12.

Placeholder scan:

- No `TBD`, `TODO`, `fill in details`, or "similar to" implementation gaps remain.

Type consistency:

- Tool names are consistently `jumpserver_`.
- Bridge paths consistently use `/tools/<tool-name>`.
- Discovery path is consistently `~/.at-jumpserver-terminal/mcp-bridge.json`.
- Header is consistently `x-at-jumpserver-terminal-token`.
- Terminal target names are consistently `terminalId`, with SFTP also accepting `connectionKey`.

