# JumpServer MySQL GUI Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-native MySQL workbench that connects to JumpServer database assets through Chen, while preserving the existing SSH terminal path.

**Architecture:** Keep JumpServer credentials, connection tokens, Chen tokens, and WebSocket connections in the extension host. Add a `JumpServerDatabaseSession` that exposes a small typed API to `MysqlWorkbenchPanel`; the webview receives sanitized tree/result view models and uses Monaco only for SQL editing. Asset routing stays centralized in extension command handling: SSH assets open `TerminalPanel`, MySQL database assets open `MysqlWorkbenchPanel`, unsupported assets remain visible and produce a clear message.

**Tech Stack:** TypeScript, VS Code Extension API, Webviews, Monaco Editor AMD distribution, `ws`, `zod`, Vitest, esbuild.

---

## Source Inputs

- Spec: `docs/superpowers/specs/2026-05-15-jumpserver-mysql-gui.md`
- Research scripts: `tools/research/inspect_jumpserver_database_methods.py`, `tools/research/probe_jumpserver_mysql_webgui.py`
- Existing client/session files: `src/jumpserver/JumpServerClient.ts`, `src/jumpserver/JumpServerSession.ts`
- Existing UI patterns: `src/webview/TerminalPanel.ts`, `src/webview/JumpServerConfigPanel.ts`, `src/webview/html.ts`

## File Map

- Modify `package.json`: add `monaco-editor`.
- Modify `esbuild.config.mjs`: bundle MySQL workbench JS/CSS and copy Monaco `min/vs` assets into `dist/webview/monaco/vs`.
- Modify `src/webview/html.ts`: support multiple scripts and `worker-src` for Monaco workers.
- Create `src/jumpserver/databaseTypes.ts`: Chen resource/query packet types and parsers.
- Modify `src/jumpserver/types.ts`: add database account ref and database session event types if useful.
- Modify `src/jumpserver/JumpServerClient.ts`: add MySQL token payload, Chen auth/profile/resources helpers, Chen WebSocket builders.
- Create `src/jumpserver/JumpServerDatabaseSession.ts`: Chen session websocket + console websocket lifecycle.
- Modify `src/tree/TreeItems.ts`: add asset-kind helpers and icon/context metadata.
- Modify `src/extension.ts`: route SSH/MySQL/unsupported assets.
- Create `src/webview/MysqlWorkbenchPanel.ts`: extension-host panel bridge.
- Create `webview/mysql-workbench/index.ts`: Monaco editor, tree, SQL execution UI.
- Create `webview/mysql-workbench/index.css`: workbench layout.
- Add tests:
  - `test/jumpserver/databaseTypes.test.ts`
  - `test/jumpserver/JumpServerDatabaseSession.test.ts`
  - extend `test/jumpserver/JumpServerClient.test.ts`
  - extend `test/tree/JumpServerTreeProvider.test.ts`
  - extend `test/extension/ExtensionCommands.test.ts`
  - add `test/webview/MysqlWorkbenchPanel.test.ts`
  - update `test/webview/html.test.ts`

---

### Task 1: Add Monaco Build Pipeline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `esbuild.config.mjs`
- Modify: `src/webview/html.ts`
- Test: `test/webview/html.test.ts`

- [ ] **Step 1: Install Monaco**

Run:

```powershell
npm install monaco-editor
```

Expected: `package.json` and `package-lock.json` include `monaco-editor`.

- [ ] **Step 2: Extend webview HTML asset support**

Change `src/webview/html.ts` so `WebviewAsset` supports both the existing single `script` and optional `scripts`:

```ts
export interface WebviewAsset {
  script: vscode.Uri;
  scripts?: vscode.Uri[];
  style?: vscode.Uri;
}
```

Render all scripts with the generated nonce, and update CSP to allow Monaco workers:

```ts
const scriptUris = [...(asset.scripts ?? []), asset.script];
const scriptTags = scriptUris
  .map((script) => `<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>`)
  .join('\n  ');

return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
</head>
<body>
  ${body}
  ${scriptTags}
</body>
</html>`;
```

- [ ] **Step 3: Add tests for multiple scripts and worker CSP**

Extend `test/webview/html.test.ts` with:

```ts
it('renders multiple scripts and worker-src for Monaco webviews', () => {
  const webview = {
    cspSource: 'vscode-webview:',
    asWebviewUri: vi.fn((uri: vscode.Uri) => uri.toString())
  } as unknown as vscode.Webview;

  const html = renderWebviewHtml(webview, {
    scripts: [vscode.Uri.file('/ext/dist/webview/monaco/vs/loader.js')],
    script: vscode.Uri.file('/ext/dist/webview/mysql-workbench.js')
  }, '<main></main>');

  expect(html).toContain('worker-src vscode-webview: blob:');
  expect(html).toContain('/ext/dist/webview/monaco/vs/loader.js');
  expect(html).toContain('/ext/dist/webview/mysql-workbench.js');
});
```

- [ ] **Step 4: Add workbench and Monaco asset build entries**

Update `esbuild.config.mjs`:

```js
import { cp, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Add JS and CSS contexts:

```js
esbuild.context({
  ...common,
  entryPoints: ['webview/mysql-workbench/index.ts'],
  outfile: 'dist/webview/mysql-workbench.js',
  platform: 'browser',
  format: 'iife'
}),
esbuild.context({
  ...common,
  entryPoints: ['webview/mysql-workbench/index.css'],
  outfile: 'dist/webview/mysql-workbench.css',
  bundle: true,
  loader: { '.css': 'css' }
})
```

After rebuild/dispose in non-watch mode, copy Monaco:

```js
const __dirname = dirname(fileURLToPath(import.meta.url));
async function copyMonaco() {
  await mkdir('dist/webview/monaco', { recursive: true });
  await cp('node_modules/monaco-editor/min/vs', 'dist/webview/monaco/vs', { recursive: true });
}

// after rebuild/dispose
await copyMonaco();
```

For watch mode, call `await copyMonaco()` once before logging watch status.

- [ ] **Step 5: Verify build pipeline**

Run:

```powershell
npm test -- test/webview/html.test.ts
npm run build
```

Expected:

- HTML tests pass.
- `dist/webview/mysql-workbench.js` exists.
- `dist/webview/mysql-workbench.css` exists.
- `dist/webview/monaco/vs/loader.js` exists.

---

### Task 2: Add Database Type Parsers

**Files:**
- Create: `src/jumpserver/databaseTypes.ts`
- Test: `test/jumpserver/databaseTypes.test.ts`

- [ ] **Step 1: Write parser tests**

Create `test/jumpserver/databaseTypes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isDatabaseAsset,
  isMysqlAsset,
  parseChenResourceNodes,
  parseChenUpdateDataView,
  parseChenPacket
} from '../../src/jumpserver/databaseTypes';

describe('databaseTypes', () => {
  it('detects database assets even when protocolNames are empty', () => {
    expect(isDatabaseAsset({ category: 'database', type: 'mysql', platform: 'MySQL', protocolNames: [] })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: 'mysql', platform: 'MySQL', protocolNames: [] })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: 'redis', platform: 'Redis6+', protocolNames: [] })).toBe(false);
  });

  it('parses Chen schema resources', () => {
    expect(parseChenResourceNodes([{
      key: 'datasource:root,schema:cl_intimfy',
      type: 'schema',
      label: 'cl_intimfy',
      hasChildren: true
    }])).toEqual([{
      key: 'datasource:root,schema:cl_intimfy',
      type: 'schema',
      label: 'cl_intimfy',
      hasChildren: true,
      children: undefined
    }]);
  });

  it('parses update_data_view into query fields and rows', () => {
    const result = parseChenUpdateDataView({
      title: 'SELECT 1',
      data: {
        fields: [{ name: '1', label: '1', columnName: '1', nullable: false, primaryKey: false }],
        data: [{ '1': '1' }]
      }
    });

    expect(result).toEqual({
      title: 'SELECT 1',
      fields: [{ name: '1', label: '1', columnName: '1', nullable: false, primaryKey: false }],
      rows: [{ '1': '1' }],
      messages: []
    });
  });

  it('parses raw console packet JSON safely', () => {
    expect(parseChenPacket('{"type":"init","data":{"title":"Query-1"}}')).toEqual({
      type: 'init',
      data: { title: 'Query-1' }
    });
    expect(() => parseChenPacket('not json')).toThrow('Invalid Chen packet JSON');
  });
});
```

- [ ] **Step 2: Implement `databaseTypes.ts`**

Create `src/jumpserver/databaseTypes.ts`:

```ts
export interface AssetLikeForDatabase {
  category?: string;
  type?: string;
  platform?: string;
  protocolNames?: string[];
}

export interface DatabaseProfile {
  dbType: string;
  canCopy: boolean;
  canPaste: boolean;
}

export interface DatabaseResourceNode {
  key: string;
  type: string;
  label: string;
  hasChildren: boolean;
  children?: DatabaseResourceNode[];
}

export interface QueryField {
  name: string;
  label?: string;
  columnName?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface QueryMessage {
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface QueryResult {
  title: string;
  fields: QueryField[];
  rows: Record<string, unknown>[];
  messages: QueryMessage[];
}

export interface ChenPacket {
  type: string;
  data?: unknown;
}

export function isDatabaseAsset(asset: AssetLikeForDatabase): boolean {
  return lowerValues(asset).includes('database') || lowerValues(asset).some((value) => ['mysql', 'mariadb', 'postgresql', 'redis', 'oracle', 'sqlserver'].includes(value));
}

export function isMysqlAsset(asset: AssetLikeForDatabase): boolean {
  return lowerValues(asset).includes('mysql') || lowerValues(asset).includes('mariadb');
}

export function parseChenPacket(raw: Buffer | string): ChenPacket {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid Chen packet JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new Error('Invalid Chen packet shape');
  }
  return parsed as ChenPacket;
}

export function parseChenResourceNodes(value: unknown): DatabaseResourceNode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({
      key: String(item.key ?? ''),
      type: String(item.type ?? ''),
      label: String(item.label ?? ''),
      hasChildren: Boolean(item.hasChildren),
      children: Array.isArray(item.children) ? parseChenResourceNodes(item.children) : undefined
    }))
    .filter((item) => item.key && item.label);
}

export function parseChenUpdateDataView(value: unknown): QueryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Chen data view packet');
  }
  const record = value as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : {};
  const fields = Array.isArray(data.fields)
    ? data.fields.filter(isRecord).map((field) => ({
      name: String(field.name ?? field.label ?? field.columnName ?? ''),
      label: field.label === undefined ? undefined : String(field.label),
      columnName: field.columnName === undefined ? undefined : String(field.columnName),
      nullable: typeof field.nullable === 'boolean' ? field.nullable : undefined,
      primaryKey: typeof field.primaryKey === 'boolean' ? field.primaryKey : undefined
    })).filter((field) => field.name)
    : [];
  const rows = Array.isArray(data.data)
    ? data.data.filter(isRecord).map((row) => ({ ...row }))
    : [];
  return {
    title: String(record.title ?? ''),
    fields,
    rows,
    messages: []
  };
}

function lowerValues(asset: AssetLikeForDatabase): string[] {
  return [
    asset.category,
    asset.type,
    asset.platform,
    ...(asset.protocolNames ?? [])
  ].map((value) => String(value ?? '').toLowerCase()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
```

- [ ] **Step 3: Verify parsers**

Run:

```powershell
npm test -- test/jumpserver/databaseTypes.test.ts
```

Expected: PASS.

---

### Task 3: Extend JumpServerClient For Chen

**Files:**
- Modify: `src/jumpserver/types.ts`
- Modify: `src/jumpserver/JumpServerClient.ts`
- Test: extend `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Extend account/token types**

Change `JumpServerAccountRef` in `src/jumpserver/types.ts`:

```ts
export interface JumpServerAccountRef {
  id: string;
  alias: string;
  username: string;
  hasSecret?: boolean;
}
```

Update SSH tests to expect `alias` when accounts are resolved:

```ts
expect(resolveFirstUsableAccount({
  permed_accounts: [{ id: 'account-1', alias: 'account-alias-1', username: 'root' }]
})).toEqual({ id: 'account-1', alias: 'account-alias-1', username: 'root', hasSecret: undefined });
```

- [ ] **Step 2: Update account resolver without breaking SSH**

Modify `resolveFirstUsableAccount`:

```ts
export function resolveFirstUsableAccount(detail: Record<string, any>): JumpServerAccountRef {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];
  const preferred = accounts.find((account) => account?.has_secret === true && !String(account?.alias ?? '').startsWith('@')) ?? accounts[0];
  if (!preferred) {
    throw new Error('No usable JumpServer account was returned for this asset.');
  }
  const id = preferred.id ? String(preferred.id) : '';
  const alias = preferred.alias ? String(preferred.alias) : id || String(preferred.name ?? '');
  const username = String(preferred.username || preferred.name || alias || '');
  if (!id || !alias || !username) {
    throw new Error('No usable JumpServer account was returned for this asset.');
  }
  return { id, alias, username, hasSecret: typeof preferred.has_secret === 'boolean' ? preferred.has_secret : undefined };
}
```

- [ ] **Step 3: Add MySQL token payload tests**

Add tests:

```ts
import { buildMysqlConnectionTokenPayload, buildChenWsUrl } from '../../src/jumpserver/JumpServerClient';

it('builds Chen MySQL connection-token payload with account alias', () => {
  expect(buildMysqlConnectionTokenPayload({
    assetId: 'asset-1',
    account: { id: 'account-id-1', alias: 'alias-1', username: 'root', hasSecret: true }
  })).toEqual({
    asset: 'asset-1',
    account: 'alias-1',
    protocol: 'mysql',
    input_username: 'root',
    input_secret: '',
    connect_method: 'web_gui',
    connect_options: {
      token_reusable: false,
      disableautohash: false
    }
  });
});

it('builds Chen websocket URLs', () => {
  expect(buildChenWsUrl('https://jumpserver.example.com', '/chen/ws/session')).toBe('wss://jumpserver.example.com/chen/ws/session');
  expect(buildChenWsUrl('http://jumpserver.example.com', '/chen/ws/console')).toBe('ws://jumpserver.example.com/chen/ws/console');
});
```

- [ ] **Step 4: Implement Chen helpers**

Add exports in `JumpServerClient.ts`:

```ts
export const DEFAULT_MYSQL_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export function buildMysqlConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.alias || input.account.id,
    protocol: 'mysql',
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'web_gui',
    connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
  };
}

export function buildChenWsUrl(baseUrl: string, path: '/chen/ws/session' | '/chen/ws/console'): string {
  const parsed = new URL(buildOrigin(baseUrl));
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = path;
  parsed.search = '';
  return parsed.toString();
}
```

Add methods to `JumpServerClient`:

```ts
async createMysqlConnectionToken(input: { assetId: string; account: JumpServerAccountRef }): Promise<{ id: string; value?: string }> {
  await this.ensureAuthToken();
  const response = await this.request('/api/v1/authentication/connection-token/', {
    method: 'POST',
    headers: { ...this.restHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(buildMysqlConnectionTokenPayload(input))
  });
  const body = await response.json() as { id?: unknown; value?: unknown };
  if (!body.id) {
    throw new Error('JumpServer MySQL connection-token response did not include id.');
  }
  return { id: String(body.id), value: body.value === undefined ? undefined : String(body.value) };
}

async chenAuth(connectionTokenId: string): Promise<{ token: string; lang: string }> {
  const response = await this.request('/chen/api/auth', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ token: connectionTokenId, disableAutoHash: false })
  });
  const body = await response.json() as { token?: unknown; lang?: unknown };
  if (!body.token) {
    throw new Error('Chen auth response did not include token.');
  }
  return { token: String(body.token), lang: String(body.lang ?? '') };
}

async chenProfile(chenToken: string): Promise<unknown> {
  const response = await this.request('/chen/api/profile', {
    headers: { Accept: 'application/json', token: chenToken }
  });
  return response.json();
}

async chenResourceChildren(chenToken: string, parentKey?: string): Promise<unknown> {
  const body = parentKey ? { key: parentKey } : undefined;
  const response = await this.request('/chen/api/resources/children', {
    method: 'POST',
    headers: { Accept: 'application/json', token: chenToken, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}
```

- [ ] **Step 5: Add REST tests for Chen auth headers**

Add a test that mocks auth and asserts `Accept-Language`:

```ts
it('authenticates Chen with Accept-Language and connection token id', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ token: 'chen-1', lang: 'zh-CN' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true,
    connectTimeout: 30
  }, fetchMock);

  await expect(client.chenAuth('connection-token-id')).resolves.toEqual({ token: 'chen-1', lang: 'zh-CN' });
  expect(fetchMock).toHaveBeenCalledWith('https://jumpserver.example.com/chen/api/auth', expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }),
    body: JSON.stringify({ token: 'connection-token-id', disableAutoHash: false })
  }));
});
```

- [ ] **Step 6: Verify client tests**

Run:

```powershell
npm test -- test/jumpserver/JumpServerClient.test.ts
```

Expected: PASS.

---

### Task 4: Implement JumpServerDatabaseSession

**Files:**
- Create: `src/jumpserver/JumpServerDatabaseSession.ts`
- Test: `test/jumpserver/JumpServerDatabaseSession.test.ts`

- [ ] **Step 1: Write lifecycle and SQL tests**

Create tests with fake sockets:

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { JumpServerDatabaseSession } from '../../src/jumpserver/JumpServerDatabaseSession';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
}

function client(sessionSocket: FakeSocket, consoleSocket: FakeSocket) {
  return {
    getAssetDetail: vi.fn(async () => ({
      category: 'database',
      type: 'mysql',
      permed_accounts: [{ id: 'account-1', alias: 'alias-1', username: 'root', has_secret: true }]
    })),
    createMysqlConnectionToken: vi.fn(async () => ({ id: 'token-1' })),
    chenAuth: vi.fn(async () => ({ token: 'chen-1', lang: 'zh-CN' })),
    openChenSessionWebSocket: vi.fn(async () => sessionSocket),
    chenProfile: vi.fn(async () => ({ dbType: 'mysql', canCopy: true, canPaste: true })),
    chenResourceChildren: vi.fn(async () => [{ key: 'datasource:root', type: 'datasource', label: 'db', hasChildren: true }]),
    openChenConsoleWebSocket: vi.fn(async () => consoleSocket)
  };
}

describe('JumpServerDatabaseSession', () => {
  it('waits for set_ready before loading profile and resources', async () => {
    const sessionSocket = new FakeSocket();
    const consoleSocket = new FakeSocket();
    const fakeClient = client(sessionSocket, consoleSocket);
    const session = new JumpServerDatabaseSession({ asset: { id: 'asset-1', name: 'mysql-1' }, client: fakeClient });

    const connect = session.connect();
    sessionSocket.emit('message', JSON.stringify({ type: 'show_dialog', data: {} }));
    expect(fakeClient.chenProfile).not.toHaveBeenCalled();
    sessionSocket.emit('message', JSON.stringify({ type: 'set_ready' }));

    await expect(connect).resolves.toEqual({ dbType: 'mysql', canCopy: true, canPaste: true });
    expect(fakeClient.chenProfile).toHaveBeenCalledWith('chen-1');
    expect(fakeClient.chenResourceChildren).toHaveBeenCalledWith('chen-1', undefined);
  });

  it('executes SQL and resolves update_data_view rows', async () => {
    const sessionSocket = new FakeSocket();
    const consoleSocket = new FakeSocket();
    const fakeClient = client(sessionSocket, consoleSocket);
    const session = new JumpServerDatabaseSession({ asset: { id: 'asset-1', name: 'mysql-1' }, client: fakeClient });

    const connect = session.connect();
    sessionSocket.emit('message', JSON.stringify({ type: 'set_ready' }));
    await connect;

    const query = session.executeSql('select 1');
    consoleSocket.emit('message', JSON.stringify({ type: 'init', data: { title: 'Query-1' } }));
    expect(consoleSocket.sent.at(-1)).toContain('"run_sql"');
    consoleSocket.emit('message', JSON.stringify({
      type: 'update_data_view',
      data: {
        title: 'SELECT 1',
        data: { fields: [{ name: '1' }], data: [{ '1': '1' }] }
      }
    }));

    await expect(query).resolves.toMatchObject({ title: 'SELECT 1', rows: [{ '1': '1' }] });
  });
});
```

- [ ] **Step 2: Implement session class**

Create `src/jumpserver/JumpServerDatabaseSession.ts` with this public shape:

```ts
import type { CachedJumpServerAsset } from '../config/schema';
import { extractProtocolNames, resolveFirstUsableAccount, type KokoWebSocket } from './JumpServerClient';
import {
  type DatabaseProfile,
  type DatabaseResourceNode,
  type QueryResult,
  isMysqlAsset,
  parseChenPacket,
  parseChenResourceNodes,
  parseChenUpdateDataView
} from './databaseTypes';

export interface JumpServerDatabaseSessionClient {
  getAssetDetail(assetId: string): Promise<Record<string, any>>;
  createMysqlConnectionToken(input: { assetId: string; account: ReturnType<typeof resolveFirstUsableAccount> }): Promise<{ id: string }>;
  chenAuth(connectionTokenId: string): Promise<{ token: string; lang: string }>;
  openChenSessionWebSocket(chenToken: string): Promise<KokoWebSocket>;
  openChenConsoleWebSocket(chenToken: string): Promise<KokoWebSocket>;
  chenProfile(chenToken: string): Promise<unknown>;
  chenResourceChildren(chenToken: string, parentKey?: string): Promise<unknown>;
}

export class JumpServerDatabaseSession {
  private chenToken = '';
  private sessionSocket?: KokoWebSocket;
  private consoleSocket?: KokoWebSocket;
  private consoleReady = false;
  private pendingQuery?: { resolve: (result: QueryResult) => void; reject: (error: unknown) => void };

  constructor(private readonly input: {
    asset: Pick<CachedJumpServerAsset, 'id' | 'name' | 'category' | 'type' | 'platform' | 'protocolNames'>;
    client: JumpServerDatabaseSessionClient;
  }) {}

  async connect(): Promise<DatabaseProfile> {
    const detail = await this.input.client.getAssetDetail(this.input.asset.id);
    const protocolNames = extractProtocolNames(detail);
    const assetForCheck = { ...this.input.asset, protocolNames };
    if (!isMysqlAsset(assetForCheck)) {
      throw new Error('Selected database asset is not supported yet. Only MySQL is implemented.');
    }
    const account = resolveFirstUsableAccount(detail);
    const token = await this.input.client.createMysqlConnectionToken({ assetId: this.input.asset.id, account });
    const auth = await this.input.client.chenAuth(token.id);
    this.chenToken = auth.token;
    this.sessionSocket = await this.input.client.openChenSessionWebSocket(this.chenToken);
    await this.waitForSessionReady(this.sessionSocket);
    return this.input.client.chenProfile(this.chenToken) as Promise<DatabaseProfile>;
  }

  async listChildren(parentKey?: string): Promise<DatabaseResourceNode[]> {
    return parseChenResourceNodes(await this.input.client.chenResourceChildren(this.chenToken, parentKey));
  }

  async executeSql(sql: string, contextKey = 'datasource:root'): Promise<QueryResult> {
    const socket = await this.ensureConsole(contextKey);
    return new Promise<QueryResult>((resolve, reject) => {
      this.pendingQuery = { resolve, reject };
      socket.send(JSON.stringify({ type: 'query_console_action', data: { action: 'run_sql', data: sql } }));
    });
  }

  dispose(): void {
    this.pendingQuery?.reject(new Error('Database session disposed.'));
    this.pendingQuery = undefined;
    this.consoleSocket?.close();
    this.sessionSocket?.close();
    this.consoleSocket = undefined;
    this.sessionSocket = undefined;
  }

  private async waitForSessionReady(socket: KokoWebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.on('message', (raw) => {
        const packet = parseChenPacket(raw as Buffer | string);
        if (packet.type === 'set_ready') {
          resolve();
        }
      });
      socket.on('error', reject);
      socket.on('close', () => reject(new Error('Chen session websocket closed before ready.')));
    });
  }

  private async ensureConsole(contextKey: string): Promise<KokoWebSocket> {
    if (this.consoleSocket && this.consoleReady) {
      return this.consoleSocket;
    }
    this.consoleSocket = await this.input.client.openChenConsoleWebSocket(this.chenToken);
    this.consoleSocket.on('message', (raw) => this.handleConsolePacket(raw as Buffer | string));
    this.consoleSocket.on('error', (error) => this.pendingQuery?.reject(error));
    this.consoleSocket.send(JSON.stringify({ type: 'connect', data: { nodeKey: contextKey, type: 'query' } }));
    await new Promise<void>((resolve, reject) => {
      const onMessage = (raw: Buffer | string) => {
        const packet = parseChenPacket(raw);
        if (packet.type === 'init') {
          this.consoleReady = true;
          resolve();
        }
      };
      this.consoleSocket?.on('message', onMessage);
      this.consoleSocket?.on('error', reject);
    });
    return this.consoleSocket;
  }

  private handleConsolePacket(raw: Buffer | string): void {
    const packet = parseChenPacket(raw);
    if (packet.type === 'update_data_view') {
      const pending = this.pendingQuery;
      this.pendingQuery = undefined;
      pending?.resolve(parseChenUpdateDataView(packet.data));
    } else if (packet.type === 'message') {
      const pending = this.pendingQuery;
      this.pendingQuery = undefined;
      pending?.reject(new Error(JSON.stringify(packet.data)));
    }
  }
}
```

During implementation, refine duplicated `message` listeners so tests still pass and no query packet is processed twice.

- [ ] **Step 3: Add client WebSocket helpers**

Add to `JumpServerClient`:

```ts
async openChenSessionWebSocket(chenToken: string, webSocketFactory: WebSocketFactory = defaultChenWebSocketFactory): Promise<KokoWebSocket> {
  return webSocketFactory(buildChenWsUrl(this.settings.baseUrl, '/chen/ws/session'), chenWebSocketOptions(this.settings.baseUrl, chenToken, this.settings.verifyTls));
}

async openChenConsoleWebSocket(chenToken: string, webSocketFactory: WebSocketFactory = defaultChenWebSocketFactory): Promise<KokoWebSocket> {
  return webSocketFactory(buildChenWsUrl(this.settings.baseUrl, '/chen/ws/console'), chenWebSocketOptions(this.settings.baseUrl, chenToken, this.settings.verifyTls));
}
```

Use subprotocol `chenToken` in `defaultChenWebSocketFactory`, unlike KoKo's `JMS-KOKO`:

```ts
export async function defaultChenWebSocketFactory(url: string, options: WebSocket.ClientOptions & { chenToken?: string }): Promise<KokoWebSocket> {
  const socket = new WebSocket(url, options.chenToken ? [options.chenToken] : undefined, options);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}
```

- [ ] **Step 4: Verify session tests**

Run:

```powershell
npm test -- test/jumpserver/JumpServerDatabaseSession.test.ts test/jumpserver/JumpServerClient.test.ts
```

Expected: PASS.

---

### Task 5: Route Assets By Capability

**Files:**
- Modify: `src/tree/TreeItems.ts`
- Modify: `src/extension.ts`
- Test: extend `test/extension/ExtensionCommands.test.ts`
- Test: extend `test/tree/JumpServerTreeProvider.test.ts`

- [ ] **Step 1: Add asset capability helpers**

In `src/tree/TreeItems.ts` add:

```ts
import { isDatabaseAsset, isMysqlAsset } from '../jumpserver/databaseTypes';

export type JumpServerAssetOpenKind = 'ssh' | 'mysql' | 'unsupported';

export function getAssetOpenKind(asset: CachedJumpServerAsset): JumpServerAssetOpenKind {
  if (asset.protocolNames.includes('ssh')) {
    return 'ssh';
  }
  if (isMysqlAsset(asset)) {
    return 'mysql';
  }
  return 'unsupported';
}
```

In `AssetTreeItem`, set context and description:

```ts
const kind = getAssetOpenKind(asset);
this.contextValue = kind === 'mysql' ? 'jumpserverDatabaseAsset' : kind === 'ssh' ? 'jumpserverAsset' : 'jumpserverUnsupportedAsset';
this.description = asset.address || asset.platform || (isDatabaseAsset(asset) ? asset.type : '');
```

- [ ] **Step 2: Add routing tests**

Extend command tests to register a MySQL asset and assert `MysqlWorkbenchPanel.open` is called. Mock `MysqlWorkbenchPanel`:

```ts
const mysqlPanelMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../src/webview/MysqlWorkbenchPanel', () => ({
  MysqlWorkbenchPanel: mysqlPanelMock
}));
```

Add:

```ts
it('routes MySQL assets to the MySQL workbench', async () => {
  // activate context as existing tests do
  const connect = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === 'jumpserverManager.connect')?.[1] as (item: AssetTreeItem) => Promise<void>;
  await connect(new AssetTreeItem({
    id: 'mysql-1',
    name: 'mysql-1',
    address: 'db.example.com',
    platform: 'MySQL',
    category: 'database',
    type: 'mysql',
    zoneName: '',
    nodePath: [],
    protocolNames: [],
    raw: {}
  }));
  expect(mysqlPanelMock.open).toHaveBeenCalled();
});
```

Add unsupported asset test:

```ts
it('keeps unsupported assets visible but shows unsupported message', async () => {
  const connect = /* registered connect handler */;
  await connect(new AssetTreeItem({
    id: 'redis-1',
    name: 'redis-1',
    address: 'redis.example.com',
    platform: 'Redis6+',
    category: 'database',
    type: 'redis',
    zoneName: '',
    nodePath: [],
    protocolNames: [],
    raw: {}
  }));
  expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('not supported'));
});
```

- [ ] **Step 3: Update extension routing**

Modify imports:

```ts
import { getAssetOpenKind } from './tree/TreeItems';
import { MysqlWorkbenchPanel } from './webview/MysqlWorkbenchPanel';
```

Change connect command:

```ts
const kind = getAssetOpenKind(item.asset);
if (kind === 'ssh') {
  TerminalPanel.open(context, item.asset, client, terminalContext);
  return;
}
if (kind === 'mysql') {
  MysqlWorkbenchPanel.open(context, item.asset, client);
  return;
}
await showTimedNotification(`Asset type is not supported yet: ${item.asset.name}`, 'error');
```

- [ ] **Step 4: Verify routing tests**

Run:

```powershell
npm test -- test/extension/ExtensionCommands.test.ts test/tree/JumpServerTreeProvider.test.ts
```

Expected: PASS.

---

### Task 6: Add MysqlWorkbenchPanel And Webview UI

**Files:**
- Create: `src/webview/MysqlWorkbenchPanel.ts`
- Create: `webview/mysql-workbench/index.ts`
- Create: `webview/mysql-workbench/index.css`
- Test: `test/webview/MysqlWorkbenchPanel.test.ts`

- [ ] **Step 1: Write panel tests**

Create `test/webview/MysqlWorkbenchPanel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { MysqlWorkbenchPanel, renderMysqlWorkbenchBody } from '../../src/webview/MysqlWorkbenchPanel';

describe('MysqlWorkbenchPanel', () => {
  it('renders workbench shell with Monaco mount point and result table', () => {
    const body = renderMysqlWorkbenchBody({ id: 'asset-1', name: 'mysql-1', address: 'db.example.com' });
    expect(body).toContain('id="sqlEditor"');
    expect(body).toContain('id="resourceTree"');
    expect(body).toContain('id="resultTable"');
    expect(body).toContain('mysql-1');
  });

  it('opens a retained VS Code webview panel', () => {
    const panel = {
      webview: {
        html: '',
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn()
      },
      onDidDispose: vi.fn()
    } as unknown as vscode.WebviewPanel;
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panel);

    MysqlWorkbenchPanel.open(
      { extensionUri: vscode.Uri.file('extension-root') } as vscode.ExtensionContext,
      { id: 'asset-1', name: 'mysql-1', address: 'db.example.com', platform: 'MySQL', category: 'database', type: 'mysql', zoneName: '', nodePath: [], protocolNames: [], raw: {} },
      {} as any
    );

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverMysqlWorkbench',
      'MySQL: mysql-1',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
    );
  });
});
```

- [ ] **Step 2: Implement panel bridge**

Create `src/webview/MysqlWorkbenchPanel.ts`:

```ts
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { JumpServerClient } from '../jumpserver/JumpServerClient';
import { JumpServerDatabaseSession } from '../jumpserver/JumpServerDatabaseSession';
import { formatError } from '../utils/errors';
import { renderWebviewHtml, type WebviewAsset } from './html';

type WorkbenchMessage =
  | { type: 'ready' }
  | { type: 'expandNode'; key?: string }
  | { type: 'executeSql'; sql: string; contextKey?: string };

export class MysqlWorkbenchPanel {
  private session: JumpServerDatabaseSession;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly asset: CachedJumpServerAsset,
    client: JumpServerClient
  ) {
    this.session = new JumpServerDatabaseSession({ asset, client });
  }

  static open(context: vscode.ExtensionContext, asset: CachedJumpServerAsset, client: JumpServerClient): MysqlWorkbenchPanel {
    const panel = vscode.window.createWebviewPanel('jumpserverMysqlWorkbench', `MySQL: ${asset.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri]
    });
    const workbench = new MysqlWorkbenchPanel(panel, asset, client);
    panel.webview.html = renderWebviewHtml(panel.webview, createMysqlWorkbenchAssets(context.extensionUri), renderMysqlWorkbenchBody(asset));
    workbench.bind();
    return workbench;
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: WorkbenchMessage) => {
      void this.handleMessage(message);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.session.dispose();
    });
  }

  private async handleMessage(message: WorkbenchMessage): Promise<void> {
    try {
      if (message.type === 'ready') {
        this.post({ type: 'statusChanged', status: 'Connecting' });
        const profile = await this.session.connect();
        this.post({ type: 'profileLoaded', profile });
        const tree = await this.session.listChildren();
        this.post({ type: 'treeLoaded', nodes: tree });
        this.post({ type: 'statusChanged', status: 'Connected' });
      } else if (message.type === 'expandNode') {
        this.post({ type: 'treeChildrenLoaded', key: message.key, nodes: await this.session.listChildren(message.key) });
      } else if (message.type === 'executeSql') {
        this.post({ type: 'queryStarted' });
        this.post({ type: 'queryResult', result: await this.session.executeSql(message.sql, message.contextKey) });
      }
    } catch (error) {
      this.post({ type: 'queryError', message: formatError(error) });
      this.post({ type: 'statusChanged', status: 'Error' });
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }
}

export function createMysqlWorkbenchAssets(extensionUri: vscode.Uri): WebviewAsset {
  return {
    scripts: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'monaco', 'vs', 'loader.js')],
    script: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'mysql-workbench.js'),
    style: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'mysql-workbench.css')
  };
}

export function renderMysqlWorkbenchBody(asset: Pick<CachedJumpServerAsset, 'id' | 'name' | 'address'>): string {
  return `<main class="mysql-workbench" data-asset-id="${escapeAttr(asset.id)}" data-monaco-base="__MONACO_BASE__">
  <header class="workbench-header">
    <strong>${escapeHtml(asset.name)}</strong>
    <span>${escapeHtml(asset.address || '')}</span>
    <span id="status">Starting</span>
    <button id="runSql" type="button">Run</button>
  </header>
  <section class="workbench-body">
    <aside id="resourceTree" class="resource-tree"></aside>
    <section class="query-area">
      <div id="sqlEditor" class="sql-editor"></div>
      <div id="messageArea" class="message-area"></div>
      <table id="resultTable" class="result-table"></table>
    </section>
  </section>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeHtml(value: string): string {
  return escapeAttr(value);
}
```

When implementing, replace `__MONACO_BASE__` with a real webview URI before rendering or add `data-monaco-base` after `renderWebviewHtml`. The simplest implementation is to compute Monaco base in `renderMysqlWorkbenchBody(asset, monacoBaseUri)`.

- [ ] **Step 3: Implement workbench frontend**

Create `webview/mysql-workbench/index.ts`:

```ts
declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
declare const require: any;

const vscode = acquireVsCodeApi();
const editorEl = document.getElementById('sqlEditor') as HTMLElement;
const treeEl = document.getElementById('resourceTree') as HTMLElement;
const resultEl = document.getElementById('resultTable') as HTMLTableElement;
const statusEl = document.getElementById('status') as HTMLElement;
const messageEl = document.getElementById('messageArea') as HTMLElement;
const runButton = document.getElementById('runSql') as HTMLButtonElement;

let editor: any;

function initMonaco() {
  const monacoBase = document.querySelector('main')?.getAttribute('data-monaco-base') || '';
  (window as any).MonacoEnvironment = {
    getWorkerUrl: () => `${monacoBase}/base/worker/workerMain.js`
  };
  require.config({ paths: { vs: monacoBase } });
  require(['vs/editor/editor.main'], () => {
    editor = (window as any).monaco.editor.create(editorEl, {
      value: 'select 1',
      language: 'sql',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13
    });
    vscode.postMessage({ type: 'ready' });
  });
}

runButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'executeSql', sql: editor?.getValue?.() ?? '' });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'statusChanged') {
    statusEl.textContent = message.status;
  } else if (message.type === 'treeLoaded') {
    renderTree(message.nodes || []);
  } else if (message.type === 'queryStarted') {
    messageEl.textContent = 'Running...';
  } else if (message.type === 'queryResult') {
    messageEl.textContent = '';
    renderResult(message.result);
  } else if (message.type === 'queryError') {
    messageEl.textContent = message.message;
  }
});

function renderTree(nodes: any[]) {
  treeEl.innerHTML = '';
  for (const node of nodes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = node.label;
    button.addEventListener('click', () => vscode.postMessage({ type: 'expandNode', key: node.key }));
    treeEl.appendChild(button);
  }
}

function renderResult(result: any) {
  resultEl.innerHTML = '';
  const fields = result.fields || [];
  const rows = result.rows || [];
  const head = resultEl.createTHead().insertRow();
  for (const field of fields) {
    const cell = document.createElement('th');
    cell.textContent = field.label || field.name;
    head.appendChild(cell);
  }
  const body = resultEl.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const field of fields) {
      const td = tr.insertCell();
      td.textContent = String(row[field.name] ?? '');
    }
  }
}

initMonaco();
```

- [ ] **Step 4: Implement workbench CSS**

Create `webview/mysql-workbench/index.css` with a dense tool layout:

```css
body {
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
}

.mysql-workbench {
  height: 100vh;
  display: grid;
  grid-template-rows: 36px 1fr;
}

.workbench-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.workbench-header button,
.resource-tree button {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: 0;
  padding: 4px 8px;
}

.workbench-body {
  min-height: 0;
  display: grid;
  grid-template-columns: 260px 1fr;
}

.resource-tree {
  overflow: auto;
  border-right: 1px solid var(--vscode-panel-border);
  padding: 8px;
}

.resource-tree button {
  display: block;
  width: 100%;
  text-align: left;
  margin-bottom: 4px;
}

.query-area {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(160px, 36%) 24px 1fr;
}

.sql-editor {
  min-height: 160px;
}

.message-area {
  padding: 4px 8px;
  color: var(--vscode-errorForeground);
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.result-table th,
.result-table td {
  border: 1px solid var(--vscode-panel-border);
  padding: 4px 6px;
  white-space: nowrap;
}
```

- [ ] **Step 5: Verify workbench panel tests and build**

Run:

```powershell
npm test -- test/webview/MysqlWorkbenchPanel.test.ts test/webview/html.test.ts
npm run build
```

Expected: PASS and build emits MySQL workbench bundles.

---

### Task 7: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Keep: `tools/research/*.py`

- [ ] **Step 1: Update README supported scope**

Change "Supported In This Version" to include:

```md
- MySQL database assets through JumpServer Chen Web GUI
- VS Code-native MySQL query workbench
- Schema tree, SQL execution, and result table
```

Change "Not Supported In This Version" to remove "database" from the unsupported line and add:

```md
- Redis, PostgreSQL, Oracle, SQL Server, and other non-MySQL database workbenches
- Direct database TCP connections or local database credential storage
```

- [ ] **Step 2: Run unit verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
python -m py_compile tools\research\probe_jumpserver_mysql_webgui.py tools\research\inspect_jumpserver_database_methods.py
```

Expected: all commands pass.

- [ ] **Step 3: Manual verification**

Use the already validated JumpServer:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins\tools\research
python probe_jumpserver_mysql_webgui.py
```

Expected: `SQL result rows: [{"1":"1"}]`.

Then verify in VS Code extension host:

- Refresh assets.
- SSH assets remain visible and open terminal.
- MySQL assets remain visible and open MySQL workbench.
- Redis and other unsupported assets remain visible and show unsupported message.
- MySQL workbench shows schema tree.
- `select 1` returns one row.
- Closing the workbench closes Chen session and console websockets.

---

## Final Verification Checklist

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] Research probe still proves `select 1` through Chen.
- [ ] Existing SSH terminal flow still works.
- [ ] MySQL workbench uses Monaco.
- [ ] All JumpServer-returned assets remain visible.
- [ ] Unsupported assets show a clear message.
- [ ] Chen query timeout remains the default `30s`.
- [ ] No direct database credentials are requested or stored.
- [ ] Tokens, cookies, and passwords are redacted from errors.
