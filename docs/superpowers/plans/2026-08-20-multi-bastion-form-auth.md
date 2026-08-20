# Multi-bastion + form-auth fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist several JumpServer bastions (grouped tree, per-bastion org/password, concurrent terminals) and retry password login once as form-urlencoded when JSON does not yield a token.

**Architecture:** `JumpServerClient` stays one host. `JumpServerConfigManager` owns `bastions[]`, `password.<id>`, and caches stamped with `bastionId`. The asset tree grows a `BastionTreeItem` root. `ensureAuthToken` tries JSON then one form POST. HMAC is out of scope.

**Tech Stack:** TypeScript, Zod, Vitest, VS Code TreeView / webview / SecretStorage, `vscode.l10n` via `t()`.

**Branch:** Create `feat/multi-bastion-form-auth` from current `feat/jumpserver-rest-alignment` (REST `next` / org / health already landed). Do not rebase onto `main` until REST alignment is merged or the user asks.

**Spec:** `docs/superpowers/specs/2026-08-20-multi-bastion-form-auth-design.md`

**TDD:** Every task writes a failing test first, watches RED, then implements. Commits use HEREDOC. Never update git config. Never skip hooks.

---

## File map

| File | Responsibility |
|---|---|
| Modify `src/jumpserver/JumpServerClient.ts` | JSON auth then one form-urlencoded retry |
| Modify `src/config/schema.ts` | `JumpServerBastion`, `bastionId` on caches, `bastionDisplayName` |
| Modify `src/config/JumpServerConfigManager.ts` | Multi-bastion persistence + migration |
| Modify `src/jumpserver/types.ts` | `JumpServerSettingsWithPassword` unchanged (client still one host) |
| Create `src/tree/BastionTreeItem.ts` | Root row `contextValue = jumpserverBastion` |
| Modify `src/tree/TreeItems.ts` | Group/asset ids include `bastionId` |
| Modify `src/tree/JumpServerTreeProvider.ts` | Roots are bastions; children filtered by `bastionId` |
| Modify `src/webview/JumpServerConfigPanel.ts` | Display name; save via `saveBastion` |
| Modify `webview/jumpserver-config/index.ts` | Post `name` + optional `bastionId` |
| Modify `src/extension.ts` | Add/remove/refresh-one/validate-one; `createClient(id)` |
| Modify `src/webview/TerminalPanel.ts` | `disposeSessionsForBastion(bastionId)` |
| Modify `src/agent/JumpServerAgentToolService.ts` | `bastionId` / `bastionName` on list_assets |
| Modify `src/mcp/bridgeSchemas.ts` + `toolCatalog.ts` | Optional `bastionId` filter; catalog copy |
| Modify `package.json` + `package.nls.json` + `package.nls.zh-cn.json` | New commands/menus |
| Modify `l10n/bundle.l10n.zh-cn.json` | New `t()` keys; run `npm run sync:l10n` |
| Modify `README.md` | Multiple bastions; form fallback is internal |
| Tests listed per task | |

Legacy `getSettings` / `saveSettings` / `requireSettings` / `getPassword` / `deleteSettings` stay as adapters in Task 3 so `extension.ts` still compiles; Task 6 stops using them for validate/refresh/connect. Adapters: empty list → undefined; `saveSettings` updates the only bastion or creates one; if several exist, `saveSettings` updates the first (panel will not call this after Task 5).

Do not implement HMAC, list webview, per-bastion SFTP tree, version bump, or CHANGELOG.

---

### Task 1: Form-urlencoded auth fallback

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`ensureAuthToken`)
- Modify: `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Write failing tests**

Add next to the existing auth tests (same `settings` / `jsonResponse` helpers):

```ts
it('retries auth as form-urlencoded when JSON does not return a token', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ detail: 'Unsupported media type' }, { status: 415 }))
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-form' }))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await client.getUserProfile();

  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ 'content-type': 'application/json' })
  }));
  expect(fetchMock.mock.calls[1][0]).toBe('https://jumpserver.example.com/api/v1/authentication/auth/');
  expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ 'content-type': 'application/x-www-form-urlencoded' }),
    body: 'username=alan&password=secret'
  }));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/authentication/auth/'))).toHaveLength(2);
});

it('does not send form auth when JSON already returned a token', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-json' }))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await client.getUserProfile();

  const authCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/authentication/auth/'));
  expect(authCalls).toHaveLength(1);
  expect(authCalls[0][1]).toEqual(expect.objectContaining({
    headers: expect.objectContaining({ 'content-type': 'application/json' })
  }));
});
```

Existing tests that mock a **single** failed auth POST will now issue a second (form) request. For every such test, add a second `jsonResponse` failure (or let `mockResolvedValueOnce` chain include the form failure) so they still throw `JumpServerApiError`. Grep `authentication/auth` in `test/jumpserver/JumpServerClient.test.ts` and `JumpServerClientLogging.test.ts`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL — only one auth POST, or body still JSON on the second call.

- [ ] **Step 3: Implement `ensureAuthToken`**

Do **not** call `requireOkResponse` on the JSON response before the form retry (that would throw and skip form). Read JSON body only when `jsonResponse.ok`. If a token is present, return it. Otherwise POST form:

```ts
const form = new URLSearchParams({
  username: this.settings.username,
  password: this.settings.password
});
const formResponse = await this.request('/api/v1/authentication/auth/', {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  },
  body: form.toString()
}, false);
```

If form `ok` and `token` present, store it. If form is not ok, `await this.requireOkResponse(formResponse, '/api/v1/authentication/auth/', 'POST')`. If ok but no token, throw `JumpServerApiError` as today (payload message). If JSON failed and form is not attempted because… always attempt form when JSON lacked a token (including HTTP 401 JSON). KoKo CSRF POST is unchanged.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/JumpServerClient.ts test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts
git commit -m "$(cat <<'EOF'
fix: retry JumpServer password auth as form-urlencoded

EOF
)"
```

---

### Task 2: Bastion schema and display name

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `test/config/schema.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import {
  bastionDisplayName,
  parseCachedJumpServerAsset,
  parseJumpServerBastion,
  parseJumpServerBastionList
} from '../../src/config/schema';

it('parses a bastion and fills an empty name from the baseUrl hostname', () => {
  expect(
    parseJumpServerBastion({
      id: '11111111-1111-1111-1111-111111111111',
      name: '  ',
      baseUrl: 'https://jms.prod.example.com/',
      orgId: '',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    })
  ).toMatchObject({
    id: '11111111-1111-1111-1111-111111111111',
    name: 'jms.prod.example.com',
    baseUrl: 'https://jms.prod.example.com'
  });
});

it('keeps an explicit bastion display name', () => {
  expect(bastionDisplayName(' 生产 ', 'https://jms.example.com')).toBe('生产');
});

it('requires bastionId on cached assets and nodes', () => {
  expect(() => parseCachedJumpServerAsset({
    id: 'asset-1',
    name: 'web-1',
    raw: {}
  })).toThrow();
  expect(
    parseCachedJumpServerAsset({
      id: 'asset-1',
      name: 'web-1',
      bastionId: 'b1',
      raw: {}
    })
  ).toMatchObject({ bastionId: 'b1' });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/config/schema.test.ts`

Expected: FAIL — `parseJumpServerBastion` / `bastionDisplayName` missing.

- [ ] **Step 3: Implement**

```ts
export function bastionDisplayName(name: string, baseUrl: string): string {
  const trimmed = name.trim();
  if (trimmed) {
    return trimmed;
  }
  try {
    return new URL(baseUrl).hostname || baseUrl.replace(/\/+$/, '');
  } catch {
    return baseUrl.replace(/\/+$/, '') || 'JumpServer';
  }
}

export const jumpServerBastionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    baseUrl: httpUrlSchema,
    orgId: z.string().trim().optional().default(''),
    username: z.string().trim().min(1),
    verifyTls: z.boolean().default(true),
    updatedAt: z.number().int().nonnegative()
  })
  .strip()
  .transform((value) => ({
    ...value,
    name: bastionDisplayName(value.name, value.baseUrl)
  }));

export const jumpServerBastionListSchema = z.array(jumpServerBastionSchema);
```

Add `bastionId: z.string().min(1)` to `cachedJumpServerAssetSchema` and `cachedJumpServerNodeSchema`.

Export `parseJumpServerBastion`, `parseJumpServerBastionList`, types `JumpServerBastion`.

Keep `parseJumpServerSettings` for the form’s field subset (no id). Existing settings tests must still pass.

Existing `parseCachedJumpServerAsset` tests must include `bastionId: 'b1'` (or the test in Step 1 already covers throw-without-id). Update the “parses cached assets” / nodes tests in this file to pass `bastionId`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/config/schema.test.ts`

Expected: PASS. Other files that construct assets **without** `bastionId` will fail TypeScript/parse later; fix them in Tasks 3–4 when those tests run. If `npm test` is run early, add `bastionId: 'test-bastion'` to any fixture that now fails parse in this task’s follow-up — prefer fixing fixtures in the task that first executes them.

Grep `raw: {}` asset literals and add `bastionId` where `parseCachedJumpServerAsset` is used. Tree tests use raw objects (no parse) — TypeScript will require `bastionId` once the type has it. Add `bastionId: 'b1'` to those literals in **this** task if `tsc`/vitest collect fails, or in Task 4 with the tree rewrite. Safer: add `bastionId: 'legacy'` to every in-repo `CachedJumpServerAsset` object in this task so the suite still typechecks.

Run: `npx tsc --noEmit`  
If it fails on missing `bastionId`, fix those object literals here before committing.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/schema.test.ts
# plus any fixture files tsc required
git commit -m "$(cat <<'EOF'
feat: add JumpServer bastion schema and cache bastionId

EOF
)"
```

---

### Task 3: Config manager migration and bastion APIs

**Files:**
- Modify: `src/config/JumpServerConfigManager.ts`
- Modify: `test/config/JumpServerConfigManager.test.ts`

Constants:

```ts
const BASTIONS_KEY = 'jumpserverManager.bastions';
const SETTINGS_KEY = 'jumpserverManager.settings'; // legacy
const PASSWORD_KEY = 'jumpserverManager.password'; // legacy
const passwordKey = (id: string) => `jumpserverManager.password.${id}`;
```

Constructor: `(globalState, secrets, options?: { idFactory?: () => string })` with `idFactory` defaulting to `randomUUID` from `node:crypto`.

- [ ] **Step 1: Write failing tests** (keep MemoryMemento helpers)

```ts
it('migrates singleton settings into one bastion and moves the password', async () => {
  const globalState = new MemoryMemento();
  const secrets = new MemorySecretStore();
  await globalState.update('jumpserverManager.settings', settings());
  await secrets.store('jumpserverManager.password', 'super-secret');
  await globalState.update('jumpserverManager.cachedAssets', [asset({ id: 'asset-1' })]);
  const manager = new JumpServerConfigManager(globalState, secrets, {
    idFactory: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  });

  const bastions = await manager.listBastions();
  expect(bastions).toHaveLength(1);
  expect(bastions[0]).toMatchObject({
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    username: 'alan',
    baseUrl: 'https://jumpserver.example.com'
  });
  expect(await manager.requirePassword('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe('super-secret');
  expect(await secrets.get('jumpserverManager.password')).toBeUndefined();
  expect(globalState.data.has('jumpserverManager.settings')).toBe(false);
  expect(await manager.listCachedAssets('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toEqual([
    expect.objectContaining({ id: 'asset-1', bastionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  ]);
});

it('saves and deletes one bastion without touching another', async () => {
  const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore(), {
    idFactory: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  });
  await manager.saveBastion({
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Prod',
    baseUrl: 'https://prod.example.com',
    orgId: '',
    username: 'alan',
    verifyTls: true,
    updatedAt: 1
  }, 'prod-secret');
  await manager.saveBastion({
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Test',
    baseUrl: 'https://test.example.com',
    orgId: '',
    username: 'bob',
    verifyTls: true,
    updatedAt: 1
  }, 'test-secret');
  await manager.saveCachedAssets('11111111-1111-1111-1111-111111111111', [
    asset({ id: 'a', bastionId: '11111111-1111-1111-1111-111111111111' })
  ]);

  await manager.deleteBastion('11111111-1111-1111-1111-111111111111');

  expect(await manager.listBastions()).toEqual([
    expect.objectContaining({ id: '22222222-2222-2222-2222-222222222222' })
  ]);
  expect(await manager.listCachedAssets()).toEqual([]);
  await expect(manager.requirePassword('22222222-2222-2222-2222-222222222222')).resolves.toBe('test-secret');
});
```

Update existing `asset()` / `node()` helpers to include `bastionId: 'b1'` so old cache tests still parse. Change `saveCachedAssets` tests to `saveCachedAssets('b1', [...])` if the signature changes.

Keep the old “stores settings in global state” test working via adapters **or** rewrite it to `saveBastion`. Prefer rewriting those four existing tests onto `saveBastion` / `listBastions` / `requirePassword` so adapters are unused in tests except one adapter test:

```ts
it('legacy saveSettings creates the first bastion', async () => {
  const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore(), {
    idFactory: () => 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  });
  await manager.saveSettings(settings(), 'super-secret');
  expect(await manager.listBastions()).toHaveLength(1);
  expect(await manager.requirePassword('cccccccc-cccc-cccc-cccc-cccccccccccc')).toBe('super-secret');
});
```

- [ ] **Step 2: RED**

Run: `npm test -- test/config/JumpServerConfigManager.test.ts`

Expected: FAIL — `listBastions` is not a function.

- [ ] **Step 3: Implement**

`migrateIfNeeded()` (call from every public read/write):

- If `BASTIONS_KEY` is a non-empty parsed list, return.
- If `BASTIONS_KEY` is empty/missing **and** `SETTINGS_KEY` parses: create bastion with `idFactory()`, `name: bastionDisplayName('', settings.baseUrl)`, copy fields, move password, stamp caches, delete legacy keys.
- If no legacy settings, write `[]` once so later empty is not confused with “unmigrated”. Only migrate when `bastions` is missing **or** empty **and** legacy settings exist (spec). If `bastions` is `[]` and legacy is already gone, stay empty.

`saveCachedAssets(bastionId, assets)`: replace that bastion’s rows in the combined array; stamp `bastionId`; sanitize raw. `listCachedAssets()` all rows; `listCachedAssets(id)` filter.

Same for nodes.

`saveBastion`: upsert by id; if `password !== undefined`, `secrets.store(passwordKey(id), password)`.

`deleteBastion`: filter bastions and caches; `secrets.delete(passwordKey(id))`.

`requireBastion` / `requirePassword`: throw `JumpServer is not configured.` / `JumpServer password is not configured.` with the same English as today when missing.

- [ ] **Step 4: GREEN**

Run: `npm test -- test/config/JumpServerConfigManager.test.ts test/config/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/JumpServerConfigManager.ts test/config/JumpServerConfigManager.test.ts
git commit -m "$(cat <<'EOF'
feat: persist multiple JumpServer bastions with settings migration

EOF
)"
```

---

### Task 4: Asset tree grouped by bastion

**Files:**
- Create: `src/tree/BastionTreeItem.ts`
- Create: `src/tree/EmptyBastionTreeItem.ts` (or inline a class in TreeItems.ts — prefer one new file `BastionTreeItem.ts` exporting both)
- Modify: `src/tree/TreeItems.ts`
- Modify: `src/tree/JumpServerTreeProvider.ts`
- Modify: `test/tree/JumpServerTreeProvider.test.ts`

- [ ] **Step 1: Write failing tests**

Use two bastions, **same asset id**:

```ts
const prod = '11111111-1111-1111-1111-111111111111';
const testId = '22222222-2222-2222-2222-222222222222';
const shared = (bastionId: string, name: string) => ({
  id: 'asset-1',
  name,
  address: '10.0.0.10',
  platform: 'Linux',
  category: 'host',
  type: 'server',
  zoneName: 'DEFAULT',
  nodePath: ['DEFAULT'],
  protocolNames: ['ssh'],
  bastionId,
  raw: {}
});

it('uses one root per bastion and unique ids when asset ids collide', async () => {
  const provider = new JumpServerTreeProvider({
    listBastions: async () => [
      { id: prod, name: 'Prod JMS', baseUrl: 'https://prod.example.com', orgId: '', username: 'a', verifyTls: true, updatedAt: 1 },
      { id: testId, name: 'Test JMS', baseUrl: 'https://test.example.com', orgId: '', username: 'a', verifyTls: true, updatedAt: 1 }
    ],
    listCachedAssets: async () => [shared(prod, 'prod-web'), shared(testId, 'test-web')],
    listCachedAssetNodes: async () => []
  });

  const roots = await provider.getChildren();
  expect(roots.map((item) => item.label)).toEqual(['Prod JMS', 'Test JMS']);
  expect(roots[0].id).toBe(`bastion:${prod}`);
  const prodRoot = roots[0] as BastionTreeItem;
  const testRoot = roots[1] as BastionTreeItem;
  const prodDefault = (await provider.getChildren(prodRoot)).find((item) => item.label === 'DEFAULT') as GroupTreeItem;
  const testDefault = (await provider.getChildren(testRoot)).find((item) => item.label === 'DEFAULT') as GroupTreeItem;
  const [prodAsset] = await provider.getChildren(prodDefault);
  const [testAsset] = await provider.getChildren(testDefault);
  expect(prodAsset.id).toBe(`asset:${prod}/asset-1`);
  expect(testAsset.id).toBe(`asset:${testId}/asset-1`);
  expect((prodAsset as AssetTreeItem).asset.bastionId).toBe(prod);
});

it('shows an empty-state row when no bastions are configured', async () => {
  const provider = new JumpServerTreeProvider({
    listBastions: async () => [],
    listCachedAssets: async () => []
  });
  const roots = await provider.getChildren();
  expect(roots).toHaveLength(1);
  expect(roots[0].label).toBe('Add JumpServer to get started');
});
```

Rewrite existing grouping tests: wrap assets with `bastionId: prod` and `listBastions` of one bastion; `getChildren()` first returns the bastion root, then `getChildren(root)` returns DEFAULT/Production groups as before.

- [ ] **Step 2: RED**

Run: `npm test -- test/tree/JumpServerTreeProvider.test.ts`

Expected: FAIL — `listBastions` unused, roots still Default/Ops/Production.

- [ ] **Step 3: Implement**

`JumpServerAssetSource`:

```ts
listBastions(): Promise<JumpServerBastion[]>;
listCachedAssets(): Promise<CachedJumpServerAsset[]>;
listCachedAssetNodes?(): Promise<CachedJumpServerNode[]>;
```

`BastionTreeItem`: `contextValue = 'jumpserverBastion'`, `id = bastion:${id}`, `collapsibleState = Expanded`, `description = hostname from baseUrl`, `readonly bastion: JumpServerBastion`.

`EmptyBastionTreeItem`: `contextValue = 'jumpserverEmpty'`, command `jumpserverManager.addBastion` (or configure). Label `t('Add JumpServer to get started')`.

`GroupTreeItem`: constructor `(path: string[], bastionId: string)`, `id = group:${bastionId}/${path.join('/')}`.

`AssetTreeItem`: `id = asset:${asset.bastionId}/${asset.id}`.

`getChildren`:

- No element: if no bastions, `[EmptyBastionTreeItem]`; else map bastions to `BastionTreeItem` sorted by `name`.
- `BastionTreeItem`: existing group/asset logic on assets/nodes **filtered** `bastionId === element.bastion.id`. Pass `bastionId` into `GroupTreeItem`.
- `GroupTreeItem`: same as today with filter + that `bastionId`.

- [ ] **Step 4: GREEN**

Run: `npm test -- test/tree/JumpServerTreeProvider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tree/BastionTreeItem.ts src/tree/TreeItems.ts src/tree/JumpServerTreeProvider.ts test/tree/JumpServerTreeProvider.test.ts
git commit -m "$(cat <<'EOF'
feat: group JumpServer asset tree by bastion

EOF
)"
```

---

### Task 5: Config form display name and saveBastion

**Files:**
- Modify: `src/webview/JumpServerConfigPanel.ts`
- Modify: `webview/jumpserver-config/index.ts`
- Modify: `test/webview/JumpServerConfigPanel.test.ts`
- Modify: `l10n/bundle.l10n.zh-cn.json` (`Display name` → `显示名`)
- Run `npm run sync:l10n`

Store interface:

```ts
export interface JumpServerConfigPanelStore {
  getBastion(id: string): Promise<JumpServerBastion | undefined>;
  saveBastion(bastion: JumpServerBastion, password?: string): Promise<void>;
}
```

`open(context, store, input: { mode: 'add' } | { mode: 'edit'; bastionId: string }, idFactory = randomUUID)`

- [ ] **Step 1: Write failing tests**

- Render body includes `name="displayName"` (HTML name `displayName`).
- Save message payload includes `displayName` and `bastionId` for edit.
- Add mode: `saveBastion` called with a uuid, `name` from hostname if displayName empty, password set.

Keep using `createPanel` / `fireMessage`. Change mock store from `getSettings`/`saveSettings` to `getBastion`/`saveBastion`.

- [ ] **Step 2: RED**

Run: `npm test -- test/webview/JumpServerConfigPanel.test.ts`

Expected: FAIL — no displayName field / store methods.

- [ ] **Step 3: Implement**

Form label `t('Display name')`, input `name="displayName"`. Hidden input `name="bastionId"` when editing.

Webview post:

```ts
displayName: String(data.get('displayName') || ''),
bastionId: String(data.get('bastionId') || ''),
```

On save: `id = payload.bastionId || randomUUID()`, `name: bastionDisplayName(payload.displayName, payload.baseUrl)`, then `saveBastion`. After success, `executeCommand('jumpserverManager.refreshBastion', id)` if that command exists; **until Task 6**, call `jumpserverManager.refresh` (all). Task 6 switches to refresh-one. To avoid a dangling command, Task 5 may `executeCommand('jumpserverManager.refresh')`; Task 6 changes it to `refreshBastion`.

- [ ] **Step 4: GREEN**

Run: `npm test -- test/webview/JumpServerConfigPanel.test.ts test/i18n/nls.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/JumpServerConfigPanel.ts webview/jumpserver-config/index.ts \
  test/webview/JumpServerConfigPanel.test.ts l10n/ package.nls.zh-hans.json package.nls.zh.json
git commit -m "$(cat <<'EOF'
feat: save JumpServer bastion display name from the config form

EOF
)"
```

(`sync:l10n` may rewrite alias files — include them.)

---

### Task 6: Commands, validate/refresh, connect, dispose

**Files:**
- Modify: `package.json` (commands + `view/item/context` for `jumpserverBastion`)
- Modify: `package.nls.json`, `package.nls.zh-cn.json` (then `npm run sync:l10n`)
- Modify: `src/extension.ts`
- Modify: `src/webview/TerminalPanel.ts`
- Modify: `test/extension/ExtensionCommands.test.ts`
- Modify: `test/package.manifest.test.ts` (command id list)
- Modify: `test/tree` if Empty item command id is `addBastion`
- Modify: `l10n/bundle.l10n.zh-cn.json`

New commands (titles are nls keys):

| command | English title |
|---|---|
| `jumpserverManager.addBastion` | `JumpServer: Add Bastion` |
| `jumpserverManager.removeBastion` | `JumpServer: Remove Bastion` |
| `jumpserverManager.refreshBastion` | `JumpServer: Refresh Bastion` |
| `jumpserverManager.editBastion` | `JumpServer: Edit Bastion` |

Menus: `viewItem == jumpserverBastion` → refreshBastion, editBastion, removeBastion.

Chinese nls: `JumpServer: 添加堡垒机` / `删除堡垒机` / `刷新此堡垒机` / `编辑堡垒机`.

Runtime `t()` strings (bundle):

| English | zh-cn |
|---|---|
| `Add JumpServer to get started` | `添加 JumpServer 堡垒机以开始使用` |
| `Add JumpServer` | `添加堡垒机` |
| `Select a JumpServer bastion` | `选择 JumpServer 堡垒机` |
| `Delete JumpServer bastion {name}?` | `确定删除堡垒机 {name} 吗？` |
| `JumpServer assets refreshed: {ok} succeeded, {fail} failed ({names}).` | `JumpServer 资产已刷新：{ok} 台成功，{fail} 台失败（{names}）。` |
| `JumpServer assets refreshed: {ok} succeeded.` | `JumpServer 资产已刷新：{ok} 台成功。` |
| `Display name` | `显示名` |

`TerminalPanel.disposeSessionsForBastion(bastionId: string): string[]` — for each panel whose `asset.bastionId === bastionId`, `this.panel.dispose()` (add a private method `disposePanel()` if `panel` is private). Return terminal ids. Extension calls `sftpManager.removeTerminal` for each.

- [ ] **Step 1: Write failing command tests**

Extend `jumpServerClientMock` if needed. `contextWithSettings` must seed `jumpserverManager.bastions` + `jumpserverManager.password.<id>` instead of singleton settings (migration also works if tests still write legacy keys — prefer writing bastions directly).

Tests:

1. `configure` with zero bastions opens add panel (spy `JumpServerConfigPanel.open` with `mode: 'add'`). Mock the panel module like other tests, or assert `showQuickPick` not called.
2. `refresh` with two bastions: `JumpServerClient` mock constructor called twice; `listAllAssets` called twice.
3. `refreshBastion` with a `BastionTreeItem` argument: `listAllAssets` once.
4. `removeBastion`: QuickPick + confirm; `globalState` bastions length 1; `TerminalPanel.disposeSessionsForBastion` — mock TerminalPanel.
5. `validate` with two bastions: `showQuickPick` then `healthCheck` only after pick; org save only on chosen id.
6. `connect` uses client for `asset.bastionId` (two constructor calls with different baseUrls).

Update existing validate/refresh tests to one-bastion fixtures (no extra QuickPick).

- [ ] **Step 2: RED**

Run: `npm test -- test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts`

Expected: FAIL — new commands missing / refresh still one client.

- [ ] **Step 3: Implement**

`createClient(configManager, bastionId)`: `requireBastion` + `requirePassword` → `new JumpServerClient({ baseUrl, orgId, username, password, verifyTls })`.

`refreshBastion(id)`: `ensureOrgContext` for that bastion (pass `configManager` + client; `saveSettings` becomes `saveBastion` with updated `orgId`). Then `listAssetNodes` / `listAllAssets`; `saveCachedAssetNodes(id, …)` / `saveCachedAssets(id, assets.map(a => ({ ...a, bastionId: id })))`.

`refresh` all: `Promise.allSettled` over `listBastions()` mapped to `refreshBastion`. One toast:

- Kind `warning` if any bastion rejected **or** any inventory `truncated`; otherwise info.
- Message: `t('JumpServer assets refreshed: {ok} succeeded, {fail} failed ({names}).', { ok, fail, names })` when `fail > 0` (`names` = failed bastion names joined by `, `). When `fail === 0` and none truncated: `t('JumpServer assets refreshed: {ok} succeeded.', { ok })`. When `fail === 0` but truncated: `t('JumpServer assets refreshed: {ok} succeeded.', { ok })` plus the existing cap string for each truncated bastion in the same message, separated by space.

Do not abort remaining bastions when one throws.

`configure`: `listBastions()`; 0 → `JumpServerConfigPanel.open(..., { mode: 'add' })`; else QuickPick `{ label: name, description: baseUrl, bastionId }` plus `{ label: t('Add JumpServer'), bastionId: '' }`; empty pick returns; `bastionId === ''` → add; else edit.

`ensureOrgContext(configManager, client, bastion)`: copy today’s helper but `savedOrgId: bastion.orgId` and `saveBastion({ ...bastion, orgId, updatedAt })`.

Wire `extension.ts` tree source `listBastions: () => configManager.listBastions()`.

After config save in Task 5, switch to `refreshBastion` in this task.

- [ ] **Step 4: GREEN**

Run: `npm test -- test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts test/i18n/nls.test.ts test/tree/JumpServerTreeProvider.test.ts test/webview/JumpServerConfigPanel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package.nls.json package.nls.zh-cn.json l10n/ src/extension.ts \
  src/webview/TerminalPanel.ts test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts
git commit -m "$(cat <<'EOF'
feat: add, refresh, and validate JumpServer bastions independently

EOF
)"
```

---

### Task 7: MCP list_assets bastion fields

**Files:**
- Modify: `src/agent/JumpServerAgentToolService.ts`
- Modify: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/mcp/BridgeServer.ts` (only if invoke wiring needs a new field — schema parse is enough)
- Modify: `test/agent/JumpServerAgentToolService.test.ts`
- Modify: `test/mcp/BridgeServer.test.ts` if it asserts listAssets args

Dependencies:

```ts
configManager: Pick<JumpServerConfigManager, 'listCachedAssets' | 'listBastions'>;
```

- [ ] **Step 1: Write failing tests**

```ts
it('includes bastionId and bastionName and can filter by bastion', async () => {
  const service = serviceWith({
    configManager: {
      listBastions: async () => [
        { id: 'b1', name: 'Prod JMS', baseUrl: 'https://prod.example.com', orgId: '', username: 'a', verifyTls: true, updatedAt: 1 },
        { id: 'b2', name: 'Test JMS', baseUrl: 'https://test.example.com', orgId: '', username: 'a', verifyTls: true, updatedAt: 1 }
      ],
      listCachedAssets: async () => [
        asset({ id: 'a1', name: 'web', bastionId: 'b1' }),
        asset({ id: 'a1', name: 'web', bastionId: 'b2' })
      ]
    }
  });
  await expect(service.listAssets({ bastionId: 'b2' })).resolves.toMatchObject({
    total: 1,
    assets: [expect.objectContaining({ assetId: 'a1', bastionId: 'b2', bastionName: 'Test JMS' })]
  });
  await expect(service.listAssets({ search: 'Prod' })).resolves.toMatchObject({ total: 1 });
  await expect(service.listAssets({ bastionId: 'missing' })).resolves.toMatchObject({ assets: [], total: 0 });
});
```

Update `serviceWith` default `listBastions: async () => []` and fixture `asset()` with `bastionId: 'b1'` plus a default bastion in `listBastions` for old tests that expect `total: 1` without names — old tests should still pass if `bastionName` is extra. Add `bastionId` to `asset()` helper default `'b1'` and `listBastions: async () => [{ id: 'b1', name: 'Default', ... }]`.

- [ ] **Step 2: RED**

Run: `npm test -- test/agent/JumpServerAgentToolService.test.ts`

Expected: FAIL — summaries lack `bastionId`.

- [ ] **Step 3: Implement**

`listAssets` input `{ search?, limit?, offset?, bastionId? }`. Filter `bastionId` first (unknown → `[]`). Search haystack includes `bastionId` and bastion `name`. `assetSummary` adds `bastionId`, `bastionName` (Map from `listBastions`; fallback `bastionDisplayName('', '')` or `'JumpServer'`).

`listAssetsBridgeSchema`: `bastionId: z.string().min(1).optional()`.

Catalog description: mention `bastionId` / `bastionName` and optional filter.

- [ ] **Step 4: GREEN**

Run: `npm test -- test/agent/JumpServerAgentToolService.test.ts test/mcp/BridgeServer.test.ts test/mcp/toolCatalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/JumpServerAgentToolService.ts src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts \
  test/agent/JumpServerAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat: expose JumpServer bastion id on MCP asset lists

EOF
)"
```

---

### Task 8: README and full suite

**Files:**
- Modify: `README.md` Supported / Setup
- Grep leftover `getSettings` / `jumpserverManager.settings` in `src/` (should be migration-only)

Setup copy:

```
3. Run `JumpServer: Add Bastion` (or Configure) for each JumpServer URL, username, password, and TLS setting. Display name may stay empty. Org ID may stay empty until Validate.
4. Run `JumpServer: Validate Account` and pick the bastion if more than one is saved.
5. Run `JumpServer: Refresh Assets` to refresh every bastion, or right-click a bastion root to refresh only that one.
```

Supported: add “Multiple JumpServer bastions in one asset tree”. Not Supported: keep access key / SSO.

- [ ] **Step 1: Edit README** (docs only; no RED test required)

- [ ] **Step 2: Run the full suite**

Run: `npm test`

Expected: PASS, 0 failures. Do not edit historical CHANGELOG test-count sentences.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: explain multiple JumpServer bastions in setup

EOF
)"
```

---

## Spec coverage

| Spec | Task |
|---|---|
| D8 form retry | 1 |
| Bastion model, keys, migration | 2–3 |
| Tree ids, empty state, grouped roots | 4 |
| Form display name, one-bastion editor | 5 |
| D4 commands, D5 refresh, D2 connect, D7 org, dispose on delete | 6 |
| MCP bastionId | 7 |
| README | 8 |
| HMAC / list webview / SFTP tree / version | out of scope |

## Type names (do not drift)

- `JumpServerBastion`
- `listBastions` / `saveBastion` / `deleteBastion` / `requireBastion` / `requirePassword(id)`
- `saveCachedAssets(bastionId, assets)`
- `jumpserverManager.addBastion` / `removeBastion` / `refreshBastion` / `editBastion`
- `disposeSessionsForBastion`
- Tree ids: `bastion:<id>`, `group:<bastionId>/<path>`, `asset:<bastionId>/<assetId>`
