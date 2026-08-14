# MySQL Terminal Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JumpServer MySQL asset support that opens a terminal-based `db_client` session in the existing xterm.js terminal panel.

**Architecture:** Introduce a small protocol/connection-kind helper, route assets as SSH/MySQL/unsupported from the existing tree, and reuse the existing `TerminalPanel` plus `JumpServerSession` for both SSH and MySQL. `JumpServerClient` owns token payload construction, including MySQL account alias handling and `connect_method: "db_client"`.

**Tech Stack:** TypeScript, VS Code extension API, xterm.js webview, JumpServer REST API, KoKo terminal WebSocket, Vitest.

---

## File Structure

- Create `src/jumpserver/connectionTypes.ts`: asset classification, connection kind labels, protocol mapping.
- Create `test/jumpserver/connectionTypes.test.ts`: MySQL/SSH/unsupported detection tests.
- Modify `src/jumpserver/types.ts`: allow account alias/secret metadata and shared protocol type.
- Modify `src/jumpserver/JumpServerClient.ts`: add MySQL token payload and update account resolution.
- Modify `src/jumpserver/JumpServerSession.ts`: accept connection kind, validate protocol, and request SSH or MySQL token.
- Modify `src/tree/TreeItems.ts`: assign MySQL/unsupported context values and descriptions.
- Modify `package.json`: show the existing connect menu for SSH, MySQL, and unsupported asset context values.
- Modify `src/webview/TerminalPanel.ts`: choose panel title and session connection kind from the asset.
- Modify `src/extension.ts`: prevent unsupported assets from opening a terminal, but keep MySQL using the same terminal panel.
- Modify tests under `test/jumpserver`, `test/tree`, `test/webview`, `test/extension`, and `test/package.manifest.test.ts`.
- Modify `README.md`: document MySQL terminal support and explicitly exclude GUI/workbench behavior.

---

### Task 0: Confirm `db_client` Connection Facts

**Files:**
- Read: `.worktrees/jumpserver-mysql-gui/src/jumpserver/JumpServerClient.ts`
- Read: `.worktrees/jumpserver-mysql-gui/src/jumpserver/databaseTypes.ts`
- Read: `tools/research/inspect_jumpserver_database_methods.py`
- Read: `docs/superpowers/specs/2026-05-27-mysql-terminal-connection-design.md`

- [ ] **Step 1: Inspect existing MySQL connection code**

Run:

```powershell
rg -n "db_client|web_gui|connect_method|DEFAULT_MYSQL|buildMysql|createMysql|alias|has_secret" .worktrees\jumpserver-mysql-gui tools docs\superpowers\specs\2026-05-27-mysql-terminal-connection-design.md
```

Expected:

```text
.worktrees\jumpserver-mysql-gui\src\jumpserver\JumpServerClient.ts:... connect_method: 'web_gui'
tools\research\inspect_jumpserver_database_methods.py:... db_client ...
docs\superpowers\specs\2026-05-27-mysql-terminal-connection-design.md:... connect_method": "db_client"
```

- [ ] **Step 2: If real JumpServer credentials are available, verify advertised MySQL methods**

Run with the real environment values already used for manual JumpServer testing:

```powershell
python tools\research\inspect_jumpserver_database_methods.py
```

Expected:

```text
mysql connect methods:
...
db_client advertised: True
```

If the command cannot run because credentials are not configured, continue with unit implementation but do not claim real JumpServer MySQL terminal verification later. If `db_client advertised: False`, stop implementation and ask for JumpServer environment confirmation.

- [ ] **Step 3: Commit nothing**

This task is verification and orientation only. No files should be staged.

Run:

```powershell
git status --short
```

Expected: only pre-existing unrelated changes such as `media/at-terminal-activity.svg` and `tools/` appear.

---

### Task 1: Add Connection Kind Helpers

**Files:**
- Create: `src/jumpserver/connectionTypes.ts`
- Create: `test/jumpserver/connectionTypes.test.ts`

- [ ] **Step 1: Write failing tests for asset classification**

Create `test/jumpserver/connectionTypes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  connectionKindLabel,
  connectionKindProtocol,
  getAssetConnectionKind,
  isDatabaseAsset,
  isMysqlAsset
} from '../../src/jumpserver/connectionTypes';

describe('connectionTypes', () => {
  it('detects MySQL assets from protocol and database metadata', () => {
    expect(isMysqlAsset({ protocolNames: ['mysql'] })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: 'mysql', platform: 'MySQL' })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: '', platform: '', name: 'prod-mariadb-01' })).toBe(true);
  });

  it('does not treat SSH hosts with mysql in their name as MySQL assets', () => {
    expect(isMysqlAsset({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'mysql-backup-host',
      protocolNames: ['ssh']
    })).toBe(false);
  });

  it('detects unsupported database assets without hiding them', () => {
    expect(isDatabaseAsset({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe(true);
    expect(getAssetConnectionKind({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe('unsupported');
  });

  it('routes MySQL before SSH when cached metadata is mixed', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'mysql',
      platform: 'MySQL',
      protocolNames: ['ssh']
    })).toBe('mysql');
  });

  it('maps supported connection kinds to labels and protocols', () => {
    expect(connectionKindLabel('ssh')).toBe('SSH');
    expect(connectionKindLabel('mysql')).toBe('MySQL');
    expect(connectionKindProtocol('ssh')).toBe('ssh');
    expect(connectionKindProtocol('mysql')).toBe('mysql');
    expect(() => connectionKindProtocol('unsupported')).toThrow('Unsupported JumpServer asset type.');
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```powershell
npm test -- test/jumpserver/connectionTypes.test.ts
```

Expected: FAIL because `src/jumpserver/connectionTypes.ts` does not exist.

- [ ] **Step 3: Implement connection type helpers**

Create `src/jumpserver/connectionTypes.ts`:

```ts
export type JumpServerConnectionKind = 'ssh' | 'mysql' | 'unsupported';
export type JumpServerConnectionProtocol = 'ssh' | 'mysql';

export interface AssetLikeForConnection {
  name?: string;
  category?: string;
  type?: string;
  platform?: string;
  protocolNames?: string[];
}

export function isDatabaseAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  return values.includes('database') || values.some((value) => [
    'mysql',
    'mariadb',
    'postgresql',
    'redis',
    'oracle',
    'sqlserver'
  ].includes(value));
}

export function isMysqlAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  if (hasMysqlMarker(values)) {
    return true;
  }
  return isDatabaseAsset(asset) && hasMysqlMarker([String(asset.name ?? '').toLowerCase()]);
}

export function getAssetConnectionKind(asset: AssetLikeForConnection): JumpServerConnectionKind {
  if (isMysqlAsset(asset)) {
    return 'mysql';
  }
  if (lowerProtocols(asset).includes('ssh')) {
    return 'ssh';
  }
  return 'unsupported';
}

export function connectionKindLabel(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'MySQL';
  }
  if (kind === 'ssh') {
    return 'SSH';
  }
  return 'Unsupported';
}

export function connectionKindProtocol(kind: JumpServerConnectionKind): JumpServerConnectionProtocol {
  if (kind === 'ssh' || kind === 'mysql') {
    return kind;
  }
  throw new Error('Unsupported JumpServer asset type.');
}

function lowerValues(asset: AssetLikeForConnection): string[] {
  return [
    asset.type,
    asset.platform,
    asset.category,
    ...lowerProtocols(asset)
  ].map((value) => String(value ?? '').toLowerCase()).filter(Boolean);
}

function lowerProtocols(asset: AssetLikeForConnection): string[] {
  return (asset.protocolNames ?? []).map((value) => value.toLowerCase());
}

function hasMysqlMarker(values: string[]): boolean {
  return values.some((value) => value.includes('mysql') || value.includes('mariadb'));
}
```

- [ ] **Step 4: Run the helper tests**

Run:

```powershell
npm test -- test/jumpserver/connectionTypes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit helper slice**

Run:

```powershell
git add src/jumpserver/connectionTypes.ts test/jumpserver/connectionTypes.test.ts
git commit -m "feat: classify JumpServer connection kinds"
```

Expected: commit succeeds with only these two files.

---

### Task 2: Route Tree Items By Connection Kind

**Files:**
- Modify: `src/tree/TreeItems.ts`
- Modify: `package.json`
- Modify: `test/tree/JumpServerTreeProvider.test.ts`
- Modify: `test/package.manifest.test.ts`

- [ ] **Step 1: Write failing tree item tests**

In `test/tree/JumpServerTreeProvider.test.ts`, change the import:

```ts
import { AssetTreeItem, GroupTreeItem, getAssetOpenKind } from '../../src/tree/TreeItems';
```

Add these tests before the final node-tree test:

```ts
  it('marks MySQL and unsupported database assets without hiding them', () => {
    const mysql = new AssetTreeItem({
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
    });
    const redis = new AssetTreeItem({
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
    });

    expect(getAssetOpenKind(mysql.asset)).toBe('mysql');
    expect(mysql.contextValue).toBe('jumpserverMysqlAsset');
    expect(mysql.description).toBe('db.example.com - MySQL');
    expect(getAssetOpenKind(redis.asset)).toBe('unsupported');
    expect(redis.contextValue).toBe('jumpserverUnsupportedAsset');
  });

  it('routes MySQL database assets to the terminal even if cached protocols include ssh', () => {
    const mysql = new AssetTreeItem({
      id: 'mysql-1',
      name: 'mysql-1',
      address: 'db.example.com',
      platform: 'MySQL',
      category: 'database',
      type: 'mysql',
      zoneName: '',
      nodePath: [],
      protocolNames: ['ssh'],
      raw: {}
    });

    expect(getAssetOpenKind(mysql.asset)).toBe('mysql');
    expect(mysql.contextValue).toBe('jumpserverMysqlAsset');
  });
```

- [ ] **Step 2: Write failing manifest menu test**

In `test/package.manifest.test.ts`, add this test:

```ts
  it('shows the connect menu for SSH, MySQL, and unsupported JumpServer assets', () => {
    const connectMenu = manifest.contributes.menus['view/item/context'].find(
      (item: { command: string }) => item.command === 'jumpserverManager.connect'
    );

    expect(connectMenu.when).toContain('view == jumpserverManager.assets');
    expect(connectMenu.when).toContain('jumpserverAsset');
    expect(connectMenu.when).toContain('jumpserverMysqlAsset');
    expect(connectMenu.when).toContain('jumpserverUnsupportedAsset');
  });
```

- [ ] **Step 3: Run focused tests to verify failures**

Run:

```powershell
npm test -- test/tree/JumpServerTreeProvider.test.ts test/package.manifest.test.ts
```

Expected: FAIL because `getAssetOpenKind` is missing and the menu only matches `jumpserverAsset`.

- [ ] **Step 4: Implement tree routing**

Replace `src/tree/TreeItems.ts` with:

```ts
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind, isDatabaseAsset, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';

export class GroupTreeItem extends vscode.TreeItem {
  readonly contextValue = 'jumpserverGroup';

  constructor(
    readonly path: string[],
    collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
  ) {
    super(path.at(-1) || 'Default', collapsibleState);
    this.label = path.at(-1) || 'Default';
  }
}

export class AssetTreeItem extends vscode.TreeItem {
  constructor(readonly asset: CachedJumpServerAsset) {
    super(asset.name, vscode.TreeItemCollapsibleState.None);
    const kind = getAssetOpenKind(asset);
    this.label = asset.name;
    this.contextValue = contextValueForKind(kind);
    this.description = assetDescription(asset, kind);
    this.tooltip = `${asset.name}${asset.address ? ` (${asset.address})` : ''}${kind === 'mysql' ? ' - MySQL' : ''}`;
    this.command = {
      command: 'jumpserverManager.connect',
      title: 'Connect',
      arguments: [this]
    };
  }
}

export const getAssetOpenKind = getAssetConnectionKind;

function contextValueForKind(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'jumpserverMysqlAsset';
  }
  if (kind === 'ssh') {
    return 'jumpserverAsset';
  }
  return 'jumpserverUnsupportedAsset';
}

function assetDescription(asset: CachedJumpServerAsset, kind: JumpServerConnectionKind): string {
  const base = asset.address || asset.platform || (isDatabaseAsset(asset) ? asset.type : '');
  if (kind === 'mysql') {
    return base ? `${base} - MySQL` : 'MySQL';
  }
  return base;
}
```

- [ ] **Step 5: Update manifest menu**

In `package.json`, replace the current `view/item/context` `when` value with:

```json
"view == jumpserverManager.assets && (viewItem == jumpserverAsset || viewItem == jumpserverMysqlAsset || viewItem == jumpserverUnsupportedAsset)"
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm test -- test/tree/JumpServerTreeProvider.test.ts test/package.manifest.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit tree routing slice**

Run:

```powershell
git add src/tree/TreeItems.ts package.json test/tree/JumpServerTreeProvider.test.ts test/package.manifest.test.ts
git commit -m "feat: route JumpServer assets by connection kind"
```

Expected: commit succeeds with only tree/menu/test changes.

---

### Task 3: Add MySQL Token Payload And Account Alias Handling

**Files:**
- Modify: `src/jumpserver/types.ts`
- Modify: `src/jumpserver/JumpServerClient.ts`
- Modify: `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Write failing client tests**

In `test/jumpserver/JumpServerClient.test.ts`, add `DEFAULT_MYSQL_CONNECT_OPTIONS` to the import:

```ts
  DEFAULT_MYSQL_CONNECT_OPTIONS,
```

Add `buildMysqlConnectionTokenPayload` to the import:

```ts
  buildMysqlConnectionTokenPayload,
```

Replace the account-selection test with:

```ts
  it('selects a usable account with alias metadata without exposing account choice to users', () => {
    expect(
      resolveFirstUsableAccount({
        permed_accounts: [
          { id: 'account-1', alias: '@virtual', username: 'virtual', has_secret: true },
          { id: 'account-2', alias: 'mysql-root', username: 'root', has_secret: true },
          { id: 'account-3', name: 'deploy' }
        ]
      })
    ).toEqual({ id: 'account-2', alias: 'mysql-root', username: 'root', hasSecret: true });
  });
```

Add this pure-helper test after the SSH payload test:

```ts
  it('builds MySQL db_client connection-token payload with account alias', () => {
    expect(buildMysqlConnectionTokenPayload({
      assetId: 'mysql-1',
      account: { id: 'account-id-1', alias: 'mysql-alias', username: 'root', hasSecret: true }
    })).toEqual({
      asset: 'mysql-1',
      account: 'mysql-alias',
      protocol: 'mysql',
      input_username: 'root',
      input_secret: '',
      connect_method: 'db_client',
      connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
    });
  });
```

Add this REST-flow test after the SSH connection token test:

```ts
  it('creates MySQL db_client connection tokens', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'mysql-token-1' }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
      connectTimeout: 30
    }, fetchMock);

    const token = await client.createConnectionToken({
      assetId: 'mysql-1',
      account: { id: 'account-id-1', alias: 'mysql-alias', username: 'root', hasSecret: true },
      protocol: 'mysql'
    });

    expect(token.id).toBe('mysql-token-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/authentication/connection-token/', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"connect_method":"db_client"')
    }));
  });
```

- [ ] **Step 2: Run focused tests to verify failures**

Run:

```powershell
npm test -- test/jumpserver/JumpServerClient.test.ts
```

Expected: FAIL because MySQL payload helpers and protocol types are missing.

- [ ] **Step 3: Update account and protocol types**

In `src/jumpserver/types.ts`, replace `JumpServerAccountRef` with:

```ts
export type JumpServerConnectionProtocol = 'ssh' | 'mysql';

export interface JumpServerAccountRef {
  id: string;
  alias?: string;
  username: string;
  hasSecret?: boolean;
}
```

- [ ] **Step 4: Implement MySQL payload helpers and protocol-aware token creation**

In `src/jumpserver/JumpServerClient.ts`, update the type import:

```ts
import type { JumpServerAccountRef, JumpServerConnectionProtocol, JumpServerEndpoint, JumpServerSettingsWithPassword } from './types';
```

Add after `DEFAULT_CONNECT_OPTIONS`:

```ts
export const DEFAULT_MYSQL_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;
```

Replace `resolveFirstUsableAccount` with:

```ts
export function resolveFirstUsableAccount(detail: Record<string, any>): JumpServerAccountRef {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];
  const preferred = accounts.find((account) => account?.has_secret === true && !String(account?.alias ?? '').startsWith('@')) ?? accounts[0];
  if (preferred) {
    const id = preferred.id ? String(preferred.id) : '';
    const alias = preferred.alias ? String(preferred.alias) : undefined;
    const username = String(preferred.username || preferred.name || alias || '');
    if (id && username) {
      return {
        id,
        alias,
        username,
        hasSecret: typeof preferred.has_secret === 'boolean' ? preferred.has_secret : undefined
      };
    }
  }
  throw new Error('No usable JumpServer account was returned for this asset.');
}
```

Change `buildConnectionTokenPayload` signature and body to:

```ts
export function buildConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  protocol: JumpServerConnectionProtocol;
}): Record<string, unknown> {
  if (input.protocol === 'mysql') {
    return buildMysqlConnectionTokenPayload(input);
  }
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: input.protocol,
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'web_cli',
    connect_options: DEFAULT_CONNECT_OPTIONS
  };
}
```

Add below it:

```ts
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
    connect_method: 'db_client',
    connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
  };
}
```

Replace `createConnectionToken` signature and missing-id error with:

```ts
  async createConnectionToken(input: { assetId: string; account: JumpServerAccountRef; protocol: JumpServerConnectionProtocol }): Promise<{ id: string }> {
    await this.ensureAuthToken();
    const response = await this.request('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { ...this.restHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(buildConnectionTokenPayload(input))
    });
    const body = await response.json() as { id?: unknown };
    if (!body.id) {
      throw new Error(input.protocol === 'mysql'
        ? 'JumpServer MySQL connection-token response did not include id.'
        : 'JumpServer connection-token response did not include id.');
    }
    return { id: String(body.id) };
  }
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm test -- test/jumpserver/JumpServerClient.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit client token slice**

Run:

```powershell
git add src/jumpserver/types.ts src/jumpserver/JumpServerClient.ts test/jumpserver/JumpServerClient.test.ts
git commit -m "feat: add MySQL db_client token payload"
```

Expected: commit succeeds with only client/type/test files.

---

### Task 4: Protocolize JumpServer Terminal Sessions

**Files:**
- Modify: `src/jumpserver/JumpServerSession.ts`
- Modify: `test/jumpserver/JumpServerSession.test.ts`

- [ ] **Step 1: Write failing session tests**

In `test/jumpserver/JumpServerSession.test.ts`, update the `client` helper signature:

```ts
function client(socket: FakeSocket, protocolName = 'ssh') {
```

Change its resolved asset detail to:

```ts
      permed_accounts: [{ id: 'account-1', alias: 'account-alias-1', username: 'root', has_secret: true }],
      permed_protocols: [{ name: protocolName }]
```

Update the first SSH expectation account to include alias and hasSecret:

```ts
      account: { id: 'account-1', alias: 'account-alias-1', username: 'root', hasSecret: true },
```

Add this test after the SSH token test:

```ts
  it('creates MySQL db_client tokens and opens the same KoKo terminal socket', async () => {
    const fakeClient = client(socket, 'mysql');
    const session = new JumpServerSession({
      asset: { id: 'mysql-1', name: 'mysql-1' },
      connectionKind: 'mysql',
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));

    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'mysql-1',
      account: { id: 'account-1', alias: 'account-alias-1', username: 'root', hasSecret: true },
      protocol: 'mysql'
    });
    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledWith({
      endpoint: { host: 'koko.example.com', https_port: 443 },
      tokenId: 'token-1',
      cols: 80,
      rows: 24
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
  });
```

Add this rejection test:

```ts
  it('rejects assets that do not expose MySQL protocol for MySQL sessions', async () => {
    const fakeClient = client(socket, 'ssh');
    const session = new JumpServerSession({
      asset: { id: 'mysql-1', name: 'mysql-1' },
      connectionKind: 'mysql',
      client: fakeClient,
      events
    });

    await expect(session.connect()).rejects.toThrow('Selected asset does not expose MySQL protocol.');
  });
```

In each existing `new JumpServerSession({ ... })`, add:

```ts
      connectionKind: 'ssh',
```

- [ ] **Step 2: Run focused tests to verify failures**

Run:

```powershell
npm test -- test/jumpserver/JumpServerSession.test.ts
```

Expected: FAIL because `connectionKind` is not accepted and protocol union is not wired.

- [ ] **Step 3: Implement protocol-aware sessions**

In `src/jumpserver/JumpServerSession.ts`, add imports:

```ts
import { connectionKindLabel, connectionKindProtocol, type JumpServerConnectionKind } from './connectionTypes';
import type { JumpServerConnectionProtocol } from './types';
```

Update `JumpServerSessionClient.createConnectionToken` to:

```ts
  createConnectionToken(input: {
    assetId: string;
    account: { id: string; alias?: string; username: string; hasSecret?: boolean };
    protocol: JumpServerConnectionProtocol;
  }): Promise<{ id: string }>;
```

Update the constructor input type:

```ts
  constructor(private readonly input: {
    asset: JumpServerSessionAsset;
    connectionKind: JumpServerConnectionKind;
    client: JumpServerSessionClient;
    events: TerminalEvents;
  }) {}
```

Replace the protocol validation and token creation block in `connect()` with:

```ts
    const protocol = connectionKindProtocol(this.input.connectionKind);
    const protocolNames = extractProtocolNames(detail).map((name) => name.toLowerCase());
    if (!protocolNames.includes(protocol)) {
      throw new Error(`Selected asset does not expose ${connectionKindLabel(this.input.connectionKind)} protocol.`);
    }
    const account = resolveFirstUsableAccount(detail);

    this.input.events.status('Creating connection token');
    const token = await this.input.client.createConnectionToken({
      assetId: this.input.asset.id,
      account,
      protocol
    });
```

Leave `getSmartEndpoint`, `openKokoWebSocket`, terminal init, input, resize, ping/pong, and output handling unchanged.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- test/jumpserver/JumpServerSession.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit session slice**

Run:

```powershell
git add src/jumpserver/JumpServerSession.ts test/jumpserver/JumpServerSession.test.ts
git commit -m "feat: support MySQL terminal sessions"
```

Expected: commit succeeds with only session/test files.

---

### Task 5: Wire Terminal Panel Titles And Session Kind

**Files:**
- Modify: `src/webview/TerminalPanel.ts`
- Modify: `test/webview/TerminalPanel.test.ts`

- [ ] **Step 1: Write failing panel tests**

In `test/webview/TerminalPanel.test.ts`, add this helper after `asset()`:

```ts
function mysqlAsset(id = 'mysql-asset'): CachedJumpServerAsset {
  return {
    id,
    name: id,
    address: `${id}.example.com`,
    platform: 'MySQL',
    category: 'database',
    type: 'mysql',
    zoneName: 'Production',
    nodePath: ['Production'],
    protocolNames: ['mysql'],
    raw: {}
  };
}
```

Update the `JumpServerSession` mock to record the constructor input:

```ts
const sessionInputs: unknown[] = [];
```

Inside the mock implementation:

```ts
    sessionInputs.push(input);
```

Clear it in `beforeEach`:

```ts
  sessionInputs.length = 0;
```

Update the existing panel title expectation:

```ts
      'JumpServer SSH: terminal-asset',
```

Add this test:

```ts
  it('uses a MySQL title and passes mysql connection kind into the session', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), mysqlAsset(), jumpServerClient());

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverTerminal',
      'JumpServer MySQL: mysql-asset',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
    );
    expect(sessionInputs.at(-1)).toMatchObject({
      connectionKind: 'mysql',
      asset: expect.objectContaining({ id: 'mysql-asset' })
    });
  });
```

- [ ] **Step 2: Run focused panel tests to verify failures**

Run:

```powershell
npm test -- test/webview/TerminalPanel.test.ts
```

Expected: FAIL because titles are still `JumpServer: ...` and session input has no `connectionKind`.

- [ ] **Step 3: Implement panel title and session kind**

In `src/webview/TerminalPanel.ts`, add import:

```ts
import { connectionKindLabel, getAssetConnectionKind, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';
```

Add a private field in `TerminalPanel`:

```ts
  private readonly connectionKind: JumpServerConnectionKind;
```

Initialize it in the constructor body before `createSession`:

```ts
    this.connectionKind = getAssetConnectionKind(asset);
```

In `TerminalPanel.open`, before `createWebviewPanel`, add:

```ts
    const connectionKind = getAssetConnectionKind(asset);
```

Change the title argument to:

```ts
      `JumpServer ${connectionKindLabel(connectionKind)}: ${asset.name}`,
```

In `createSession`, add `connectionKind` to the `JumpServerSession` input:

```ts
      connectionKind: this.connectionKind,
```

- [ ] **Step 4: Run focused panel tests**

Run:

```powershell
npm test -- test/webview/TerminalPanel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit panel slice**

Run:

```powershell
git add src/webview/TerminalPanel.ts test/webview/TerminalPanel.test.ts
git commit -m "feat: label terminal panels by JumpServer protocol"
```

Expected: commit succeeds with only panel/test files.

---

### Task 6: Block Unsupported Assets In The Connect Command

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/extension/ExtensionCommands.test.ts`

- [ ] **Step 1: Write failing command tests**

At the top of `test/extension/ExtensionCommands.test.ts`, add hoisted mocks before importing `activate`:

```ts
const terminalPanelMock = vi.hoisted(() => ({
  open: vi.fn(),
  getActive: vi.fn(),
  disconnectAll: vi.fn()
}));

const notificationsMock = vi.hoisted(() => ({
  showTimedNotification: vi.fn()
}));
```

Add mocks:

```ts
vi.mock('../../src/webview/TerminalPanel', () => ({
  TerminalPanel: terminalPanelMock
}));

vi.mock('../../src/utils/notifications', () => ({
  showTimedNotification: notificationsMock.showTimedNotification
}));
```

In `beforeEach`, add:

```ts
  terminalPanelMock.open.mockClear();
  terminalPanelMock.getActive.mockReturnValue(undefined);
  terminalPanelMock.disconnectAll.mockClear();
  notificationsMock.showTimedNotification.mockResolvedValue(undefined);
```

Add helper functions near the test setup:

```ts
function contextWithSettings(): vscode.ExtensionContext {
  const data = new Map<string, unknown>([
    ['jumpserverManager.settings', {
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      verifyTls: true,
      connectTimeout: 30,
      updatedAt: 1
    }]
  ]);
  return {
    globalState: {
      get: vi.fn((key, fallback) => data.has(key) ? data.get(key) : fallback),
      update: vi.fn(async (key, value) => {
        data.set(key, value);
      })
    },
    secrets: { get: vi.fn(async () => 'secret'), store: vi.fn(), delete: vi.fn() },
    subscriptions: [],
    extensionUri: vscode.Uri.file('extension-root')
  } as unknown as vscode.ExtensionContext;
}

function registeredCommand(commandId: string): (...args: any[]) => Promise<void> {
  return vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === commandId)?.[1] as (...args: any[]) => Promise<void>;
}
```

Add tests:

```ts
  it('opens the unified terminal panel for MySQL assets', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: {
        id: 'mysql-1',
        name: 'mysql-1',
        address: 'db.example.com',
        platform: 'MySQL',
        category: 'database',
        type: 'mysql',
        zoneName: '',
        nodePath: [],
        protocolNames: ['mysql'],
        raw: {}
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith(expect.stringContaining('not supported'), 'error');
  });

  it('keeps unsupported assets visible but shows an unsupported message instead of opening a terminal', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: {
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
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).not.toHaveBeenCalled();
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Asset type is not supported yet: redis-1', 'error');
  });
```

- [ ] **Step 2: Run focused command tests to verify failures**

Run:

```powershell
npm test -- test/extension/ExtensionCommands.test.ts
```

Expected: FAIL because unsupported assets still open `TerminalPanel`.

- [ ] **Step 3: Implement unsupported blocking**

In `src/extension.ts`, update the tree import:

```ts
import { AssetTreeItem, getAssetOpenKind } from './tree/TreeItems';
```

Replace the connect command body with:

```ts
      await runCommand(async () => {
        const kind = getAssetOpenKind(item.asset);
        if (kind === 'unsupported') {
          await showTimedNotification(`Asset type is not supported yet: ${item.asset.name}`, 'error');
          return;
        }
        const client = await createClient(configManager);
        TerminalPanel.open(context, item.asset, client, terminalContext);
      });
```

- [ ] **Step 4: Run focused command tests**

Run:

```powershell
npm test -- test/extension/ExtensionCommands.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit command routing slice**

Run:

```powershell
git add src/extension.ts test/extension/ExtensionCommands.test.ts
git commit -m "feat: block unsupported JumpServer asset connections"
```

Expected: commit succeeds with only extension command/test files.

---

### Task 7: Update Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README support matrix**

In `README.md`, change the supported section to include:

```md
- SSH protocol assets
- MySQL protocol assets through JumpServer `db_client`
- xterm.js terminal UI
- JumpServer KoKo WebSocket terminal sessions
```

Change the not-supported section to:

```md
- Ahell backend integration
- Direct SSH through ssh2
- SFTP or remote file editing
- MCP and Agent tools
- MySQL GUI/workbench, Chen SQL editor, schema browser, or result grid
- RDP, PostgreSQL, Redis, Oracle, SQL Server, Kubernetes, or other non-SSH/non-MySQL assets
- SSO, MFA, captcha, private token, or access key login
```

Change setup step 6 to:

```md
6. Click an SSH or MySQL asset to connect in a terminal.
```

Add manual verification bullets:

```md
- Connect to a MySQL asset.
- Run `select 1;` at the MySQL prompt.
- Verify unsupported database assets show clear errors and do not open a GUI.
```

- [ ] **Step 2: Review README diff**

Run:

```powershell
git diff -- README.md
```

Expected: diff only documents terminal-based MySQL support and does not mention GUI support as available.

- [ ] **Step 3: Commit docs slice**

Run:

```powershell
git add README.md
git commit -m "docs: document MySQL terminal support"
```

Expected: commit succeeds with only README changes.

---

### Task 8: Full Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm test
```

Expected:

```text
Test Files  ... passed
Tests       ... passed
```

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected:

```text
> at-jumpserver-terminal@0.1.0 typecheck
> tsc --noEmit
```

Exit code must be 0.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected:

```text
> at-jumpserver-terminal@0.1.0 build
> node esbuild.config.mjs
```

Exit code must be 0 and `dist/` may update as ignored build output.

- [ ] **Step 4: Inspect final git status**

Run:

```powershell
git status --short
```

Expected: no unstaged tracked source/test/README changes from this implementation. Pre-existing unrelated changes may still appear:

```text
 M media/at-terminal-activity.svg
?? tools/
```

- [ ] **Step 5: Inspect commit history**

Run:

```powershell
git log --oneline -8
```

Expected: recent commits include:

```text
docs: document MySQL terminal support
feat: block unsupported JumpServer asset connections
feat: label terminal panels by JumpServer protocol
feat: support MySQL terminal sessions
feat: add MySQL db_client token payload
feat: route JumpServer assets by connection kind
feat: classify JumpServer connection kinds
docs: add mysql terminal connection design
```

---

## Self-Review Checklist

- Spec coverage:
  - Existing `Assets` tree remains in place: Task 2 and Task 6.
  - MySQL uses terminal panel, not GUI: Task 4, Task 5, Task 7.
  - MySQL token uses `db_client`: Task 3.
  - Account alias handling: Task 3.
  - Unsupported assets remain visible but blocked: Task 2 and Task 6.
  - Worktree connection facts checked first: Task 0.
  - Tests and manual verification guidance: Task 8 and README updates.
- Placeholder scan: no unfinished markers or open-ended "add tests" steps.
- Type consistency:
  - `JumpServerConnectionKind` is defined in `connectionTypes.ts`.
  - `JumpServerConnectionProtocol` is defined in `types.ts`.
  - `getAssetOpenKind` re-exports `getAssetConnectionKind` from `TreeItems.ts`.
  - `connectionKindProtocol('unsupported')` throws before session creation for unsupported assets.
