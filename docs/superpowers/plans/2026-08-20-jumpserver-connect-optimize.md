# JumpServer Connect Optimize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing per-bastion client pool actually skip JumpServer login on parallel and later connects, stop auto-opening SFTP on SSH connect, prefetch asset detail and cache the KoKo endpoint, and open KoKo WebSocket with an existing web session before doing HTML warmup.

**Architecture:** Keep one `JumpServerClient` per bastion. Serialize `ensureAuthToken` and `warmupKokoConnectPage` with in-flight promises. Treat only login-page redirects as “needs Django form”. Bind the Files view to a terminal without creating an SFTP session until the first list/refresh. Cache `getAssetDetail` and `getSmartEndpoint` on the client. If a `sessionid` cookie exists, try the KoKo WebSocket first and warm up only when the handshake fails.

**Tech Stack:** TypeScript, Vitest, VS Code TreeView, existing `log` sink (redacts `token=` / cookies).

**Spec:** Chat + [jumpserver-connect-optimize.canvas.tsx](/Users/clkj/.cursor/projects/Users-clkj-at/canvases/jumpserver-connect-optimize.canvas.tsx) batches 1–4. Out of scope: reusing connection-tokens, persisting Bearer/session to disk, HMAC, version bump, CHANGELOG.

**TDD:** Every task writes a failing test first, watches RED, then implements. Do not commit unless the user asked.

**Branch:** Stay on the current feature branch (`feat/multi-bastion-form-auth`). The client pool is already in the tree.

---

## File map

| File | Responsibility |
|---|---|
| Modify `src/jumpserver/JumpServerClient.ts` | Auth/warmup inflight, login-only 302, detail + endpoint caches, WS-first when session cookie exists, timing logs |
| Modify `src/jumpserver/JumpServerClientPool.ts` | Log acquire hit/miss (bastionId only) |
| Modify `src/jumpserver/JumpServerSession.ts` | Log connect step timings (no token URLs) |
| Modify `src/sftp/JumpServerSftpManager.ts` | `openAsset` binds without connecting; `getState` gains `pending` |
| Modify `src/tree/SftpTreeProvider.ts` | Placeholder for `pending` without listing |
| Modify `src/extension.ts` | Keep bind-on-connect; prefetch on asset tree selection |
| Modify `test-fixtures/vscode.ts` | `createTreeView` returns a view with `onDidChangeSelection` |
| Modify `l10n/bundle.l10n.zh-cn.json` then `npm run sync:l10n` | Pending Files copy |
| Tests listed per task | |

Do not log passwords, Bearer values, cookie values, or KoKo URLs that carry `token=`. Use asset name / HTTP status / elapsed ms / “reused” vs “login”.

---

### Task 1: Serialize REST Bearer login

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`ensureAuthToken`)
- Modify: `test/jumpserver/JumpServerClient.test.ts`
- Modify: `test/jumpserver/JumpServerClientLogging.test.ts`

- [ ] **Step 1: Write failing tests**

In `test/jumpserver/JumpServerClient.test.ts`, next to the existing auth tests:

```ts
it('runs one REST login when two callers find an empty token', async () => {
  let authStarts = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/authentication/auth/')) {
      authStarts += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ token: 'bearer-1' });
    }
    return jsonResponse({ id: 'user-1' });
  });
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await Promise.all([client.getUserProfile(), client.getUserProfile()]);

  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/authentication/auth/'))).toHaveLength(1);
  expect(authStarts).toBe(1);
});
```

In `test/jumpserver/JumpServerClientLogging.test.ts`:

```ts
it('logs REST bearer reuse after the first login', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValue(jsonResponse({ id: 'user-1' }));
  const client = new JumpServerClient(settings, fetchMock);

  await client.getUserProfile();
  await client.getUserProfile();

  expect(lines.some((line) => line === 'info REST bearer login')).toBe(true);
  expect(lines.some((line) => line === 'info REST bearer reused')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: FAIL — two overlapping `getUserProfile` calls POST auth twice; reuse log line missing.

- [ ] **Step 3: Implement**

In `JumpServerClient`:

```ts
private authInflight: Promise<string> | undefined;

async ensureAuthToken(): Promise<string> {
  if (this.authToken) {
    log.info('REST bearer reused');
    return this.authToken;
  }
  if (this.authInflight) {
    return this.authInflight;
  }
  this.authInflight = this.loginRestBearer().finally(() => {
    this.authInflight = undefined;
  });
  return this.authInflight;
}

private async loginRestBearer(): Promise<string> {
  log.info('REST bearer login');
  // move the existing JSON-then-form body here; assign this.authToken as today
  return this.authToken;
}
```

On 401 `resetRestAuth`, keep clearing `this.authToken` so the next `ensureAuthToken` logs in again.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: PASS

- [ ] **Step 5: Commit only if the user asked**

---

### Task 2: KoKo warmup — login-only 302, inflight, keep cookies

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`warmupKokoConnectPage`, `tryWarmupKokoConnectPage`)
- Modify: `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Write failing tests**

Export a helper (test it as a pure function):

```ts
export function isKokoLoginRedirect(location: string | null): boolean {
  if (!location) {
    return false;
  }
  return /\/(?:core\/)?auth\/login(?:\/|\?|$)/i.test(location);
}
```

Tests:

```ts
it('treats a non-login KoKo redirect as an authenticated warmup', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { location: '/koko/elfinder/?token=token-1' }
    }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await client.warmupKokoConnectPage('token-1', 1000);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.some(([, init]) => init && (init as RequestInit).method === 'POST')).toBe(false);
});

it('runs one KoKo form login when two warmups start together', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { location: '/core/auth/login/?next=/koko/connect/' }
    }))
    .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', {
      headers: { 'set-cookie': 'csrftoken=abc; Path=/' }
    }))
    .mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' }
    }))
    .mockResolvedValueOnce(textResponse('ok'))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
    .mockResolvedValue(textResponse('<html>koko</html>'));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await Promise.all([
    client.warmupKokoConnectPage('token-a', 1000),
    client.warmupKokoConnectPage('token-b', 1001)
  ]);

  const loginPosts = fetchMock.mock.calls.filter(([, init]) =>
    Boolean(init && (init as RequestInit).method === 'POST')
  );
  expect(loginPosts).toHaveLength(1);
});
```

Keep the existing test that 302 to `/core/auth/login/` still does CSRF POST.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL — non-login 302 currently POSTs login; overlapping warmups POST twice.

- [ ] **Step 3: Implement**

```ts
private warmupInflight: Promise<void> | undefined;

async warmupKokoConnectPage(tokenId: string, timestamp = Date.now()): Promise<void> {
  if (this.warmupInflight) {
    await this.warmupInflight;
    const again = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
    if (again) {
      return;
    }
  }
  this.warmupInflight = this.runWarmup(tokenId, timestamp).finally(() => {
    this.warmupInflight = undefined;
  });
  await this.warmupInflight;
}

private async runWarmup(tokenId: string, timestamp: number): Promise<void> {
  const started = Date.now();
  const hadSession = this.hasWebSessionCookie();
  const authenticated = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
  if (authenticated) {
    log.info(`KoKo warmup ok in ${Date.now() - started}ms`);
    return;
  }
  if (hadSession) {
    this.cookies = this.cookies.filter((cookie) => cookie.name !== 'sessionid');
  }
  const retried = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
  if (!retried) {
    throw new Error('KoKo web session is not authenticated.');
  }
  log.info(`KoKo warmup login in ${Date.now() - started}ms`);
}
```

In `tryWarmupKokoConnectPage`, after the first GET:

- `ok` → `log.info('KoKo warmup skipped (already authenticated)')` → return true
- redirect and `!isKokoLoginRedirect(location)` → return true (do not POST credentials)
- redirect to login → existing CSRF form flow

`hasWebSessionCookie()`: any cookie named `sessionid` (JumpServer Django default).

Do not clear the whole jar on retry — only drop `sessionid` so `csrftoken` can stay.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: PASS, including existing warmup / retry / cross-origin tests.

- [ ] **Step 5: Commit only if the user asked**

---

### Task 3: Connect-step timing logs

**Files:**
- Modify: `src/jumpserver/JumpServerSession.ts`
- Modify: `src/jumpserver/JumpServerClientPool.ts`
- Modify: `test/jumpserver/JumpServerSession.test.ts`
- Modify: `test/jumpserver/JumpServerClientPool.test.ts`
- Modify: `test/jumpserver/JumpServerClientLogging.test.ts` if session tests do not install a sink

- [ ] **Step 1: Write failing tests**

Pool:

```ts
it('logs whether acquire reused a client', () => {
  const lines: string[] = [];
  setLogSink({
    trace: (m) => lines.push(m),
    debug: (m) => lines.push(m),
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m)
  });
  const { pool } = poolWithStubs();
  pool.acquire('bastion-1', settings());
  pool.acquire('bastion-1', settings());
  expect(lines).toContain('JumpServer client created for bastion bastion-1');
  expect(lines).toContain('JumpServer client reused for bastion bastion-1');
});
```

Session: install `setLogSink`, run `connect()`, expect a line matching `/KoKo terminal connect for web-1 finished in \d+ms/`.

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — log lines absent.

- [ ] **Step 3: Implement**

Pool `acquire`: log created vs reused with `bastionId` only.

`JumpServerSession.connect`:

```ts
const started = Date.now();
this.input.events.status('Loading asset');
const detail = await this.input.client.getAssetDetail(...);
// existing token + endpoint + openKokoWebSocket
log.info(`KoKo terminal connect for ${this.input.asset.name} finished in ${Date.now() - started}ms`);
```

Do not put token ids in the message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/jumpserver/JumpServerSession.test.ts test/jumpserver/JumpServerClientPool.test.ts`

Expected: PASS

- [ ] **Step 5: Commit only if the user asked**

---

### Task 4: Do not auto-connect SFTP on SSH connect

**Files:**
- Modify: `src/sftp/JumpServerSftpManager.ts`
- Modify: `src/tree/SftpTreeProvider.ts`
- Modify: `l10n/bundle.l10n.zh-cn.json` then `npm run sync:l10n`
- Modify: `test/sftp/JumpServerSftpManager.test.ts`
- Modify: `test/tree/SftpTreeProvider.test.ts`
- Modify: `test/extension/ExtensionCommands.test.ts`
- Modify: `README.md` (one sentence under Setup step 7)

- [ ] **Step 1: Write failing tests**

Manager — change the existing “async session factories” expectation and add:

```ts
it('binds an asset without opening the SFTP session', async () => {
  const fakeSession = session();
  const createSession = vi.fn(() => fakeSession);
  const manager = new JumpServerSftpManager({ createSession });
  await manager.openAsset(asset());

  expect(createSession).not.toHaveBeenCalled();
  expect(manager.getState()).toEqual({
    kind: 'pending',
    asset: expect.objectContaining({ id: 'asset-1' })
  });
  await manager.listDirectory();
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(fakeSession.connect).toHaveBeenCalledTimes(1);
});
```

Update `'accepts async session factories'`: `openAsset` must not call `connect`; `ensureRoot` / `listDirectory` must.

Tree:

```ts
it('shows a pending placeholder without listing the remote root', async () => {
  const provider = new SftpTreeProvider({
    getState: () => ({ kind: 'pending', asset: { name: 'web-1' } as never }),
    listDirectory: async () => { throw new Error('must not list'); }
  });
  const children = await provider.getChildren();
  expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
  expect(children[0].label).toBe('Files for web-1 connect on first refresh');
});
```

Extension: keep calling `openAsset` on connect (bind the terminal), but document that this no longer creates a session. Existing `'automatically opens the SFTP file tree...'` still expects `openAsset` — leave that assertion; manager tests prove it is lazy.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/sftp/JumpServerSftpManager.test.ts test/tree/SftpTreeProvider.test.ts`

Expected: FAIL — `openAsset` still `ensureRoot`s; no `pending` kind.

- [ ] **Step 3: Implement**

`JumpServerSftpTreeState` add:

```ts
| { kind: 'pending'; asset: CachedJumpServerAsset }
```

`openAsset`: keep the connection map + `activeTerminalId` assignment; **delete** `await this.ensureRoot()`.

`getState`:

```ts
if (active.rootPath) { return { kind: 'active', ... }; }
if (active.snapshot) { return { kind: 'disconnected', ... }; }
if (active.asset) { return { kind: 'pending', asset: active.asset }; }
return { kind: 'none' };
```

`ensureSession` still connects on first `listDirectory` / `ensureRoot` / mutations (unchanged).

`SftpTreeProvider.getChildren`: if `pending`, return placeholder `t('Files for {name} connect on first refresh', { name: state.asset.name })` and **do not** call `listDirectory`.

Toolbar `jumpserverManager.sftp.refresh` already calls `listDirectory` — that becomes the first SFTP connect. MCP SFTP tools already go through `ensureSession`.

`l10n/bundle.l10n.zh-cn.json`:

```json
"Files for {name} connect on first refresh": "文件（{name}）将在首次刷新时连接"
```

Then `npm run sync:l10n`.

README Setup step 7: after connecting SSH, use Files and Refresh to open the SFTP session.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/sftp/JumpServerSftpManager.test.ts test/tree/SftpTreeProvider.test.ts test/extension/ExtensionCommands.test.ts`

Expected: PASS. MCP SFTP tests still pass because they list after open.

- [ ] **Step 5: Commit only if the user asked**

---

### Task 5: Prefetch asset detail on tree selection

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`getAssetDetail`)
- Modify: `src/extension.ts`
- Modify: `test-fixtures/vscode.ts`
- Modify: `test/jumpserver/JumpServerClient.test.ts`
- Modify: `test/extension/ExtensionCommands.test.ts`

- [ ] **Step 1: Write failing tests**

Client:

```ts
it('reuses asset detail already fetched for the same asset id', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root', has_secret: true }],
      permed_protocols: [{ name: 'ssh' }]
    }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  const first = await client.getAssetDetail('asset-1');
  const second = await client.getAssetDetail('asset-1');

  expect(second).toBe(first);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/self/assets/asset-1/'))).toHaveLength(1);
});
```

Fixture: `createTreeView` must return `{ onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })) }` so `activate` can subscribe. If tests currently get `undefined`, adding the subscription without this change throws — fix the fixture in the same task as the first RED for extension prefetch.

Extension: mock `getAssetDetail` on the client stub, capture `onDidChangeSelection` from `createTreeView`’s return value, fire `{ selection: [new AssetTreeItem(sshAsset())] }`, expect `getAssetDetail` called with the asset id. Swallow errors (do not toast).

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — second `getAssetDetail` hits the network; selection does not prefetch.

- [ ] **Step 3: Implement**

```ts
private assetDetails = new Map<string, Record<string, any>>();

async getAssetDetail(assetId: string): Promise<Record<string, any>> {
  const cached = this.assetDetails.get(assetId);
  if (cached) {
    log.info(`asset detail reused for ${assetId}`);
    return cached;
  }
  await this.ensureAuthToken();
  const response = await this.authenticatedRequest(`/api/v1/perms/users/self/assets/${encodeURIComponent(assetId)}/`);
  const detail = await response.json() as Record<string, any>;
  this.assetDetails.set(assetId, detail);
  return detail;
}
```

Drop the map when `resetRestAuth` runs (stale org/token).

`extension.ts`:

```ts
const assetsView = vscode.window.createTreeView('jumpserverManager.assets', {
  treeDataProvider: treeProvider,
  showCollapseAll: true
});
context.subscriptions.push(
  assetsView,
  assetsView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (!(item instanceof AssetTreeItem)) {
      return;
    }
    void prefetchAssetDetail(configManager, item.asset);
  })
);

async function prefetchAssetDetail(
  configManager: JumpServerConfigManager,
  asset: CachedJumpServerAsset
): Promise<void> {
  try {
    const client = await createClient(configManager, asset.bastionId);
    await client.getAssetDetail(asset.id);
  } catch (error) {
    log.debug(`asset detail prefetch failed: ${errorMessage(error)}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/extension/ExtensionCommands.test.ts`

Expected: PASS; `activate` no longer throws.

- [ ] **Step 5: Commit only if the user asked**

---

### Task 6: Cache smart endpoint per client

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`getSmartEndpoint`)
- Modify: `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Write failing test**

```ts
it('reuses the smart endpoint host after the first lookup', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ host: 'koko.example.com', https_port: 443 }))
    .mockResolvedValueOnce(jsonResponse({ id: 'token-2' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  const first = await client.getSmartEndpoint('token-1');
  const second = await client.getSmartEndpoint('token-2');

  expect(second).toEqual(first);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/terminal/endpoints/smart/'))).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — two smart HTTP calls.

- [ ] **Step 3: Implement**

```ts
private smartEndpoint: JumpServerEndpoint | undefined;

async getSmartEndpoint(tokenId: string): Promise<JumpServerEndpoint> {
  if (this.smartEndpoint) {
    log.info('KoKo endpoint reused');
    return this.smartEndpoint;
  }
  await this.ensureAuthToken();
  const response = await this.authenticatedRequest(
    `/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`
  );
  this.smartEndpoint = await response.json() as JumpServerEndpoint;
  return this.smartEndpoint;
}
```

Still pass the **new** connection-token into the WebSocket URL. Only the host/port is reused. Clear `smartEndpoint` in `resetRestAuth`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: PASS, including existing MySQL/Redis token tests.

- [ ] **Step 5: Commit only if the user asked**

---

### Task 7: Open KoKo WebSocket with session cookie before HTML warmup

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`openKokoWebSocket`, `openKokoSftpWebSocket`)
- Modify: `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Write failing tests**

Reuse the existing cookie-warmup sequence to plant `sessionid`, then:

```ts
it('opens the KoKo terminal socket without HTML warmup when a session cookie exists', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { location: '/core/auth/login/?next=/koko/connect/' }
    }))
    .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', {
      headers: { 'set-cookie': 'csrftoken=abc; Path=/' }
    }))
    .mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' }
    }))
    .mockResolvedValueOnce(textResponse('ok'))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
    .mockResolvedValueOnce(textResponse('<html>koko</html>'));
  const socket = { send: vi.fn(), close: vi.fn(), on: vi.fn(), ping: vi.fn(), terminate: vi.fn(), bufferedAmount: 0 };
  const webSocketFactory = vi.fn(async () => socket);
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await client.warmupKokoConnectPage('token-1', 1000);
  fetchMock.mockClear();
  await client.openKokoWebSocket({
    endpoint: { host: 'koko.example.com', https_port: 443 },
    tokenId: 'token-2',
    cols: 80,
    rows: 24,
    webSocketFactory
  });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(webSocketFactory).toHaveBeenCalledTimes(1);
});

it('warms up and retries when the cached-cookie handshake fails', async () => {
  // plant sessionid as above, then:
  // webSocketFactory rejects once, then resolves
  // expect warmup GET /koko/connect/ after the failed handshake
  // expect webSocketFactory called twice
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — `openKokoWebSocket` always GETs `/koko/connect/` first.

- [ ] **Step 3: Implement**

```ts
async openKokoWebSocket(input: { ... }): Promise<KokoWebSocket> {
  return this.openKokoSocket({
    kind: 'terminal',
    ...input
  });
}

private async openKokoSocket(input: {
  kind: 'terminal' | 'sftp';
  endpoint: JumpServerEndpoint;
  tokenId: string;
  cols?: number;
  rows?: number;
  timestamp?: number;
  webSocketFactory?: WebSocketFactory;
}): Promise<KokoWebSocket> {
  const open = () => {
    const url = input.kind === 'sftp'
      ? buildKokoSftpWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId, input.timestamp)
      : buildKokoWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId);
    const factory = input.webSocketFactory ?? this.timedWebSocketFactory();
    return factory(url, { /* existing headers + Cookie */ });
  };
  if (this.hasWebSessionCookie()) {
    try {
      log.info(`KoKo ${input.kind} websocket with cached session`);
      return await open();
    } catch (error) {
      log.info(`KoKo ${input.kind} websocket handshake failed; warming up`);
    }
  }
  await this.warmupKokoConnectPage(input.tokenId);
  return open();
}
```

`openKokoSftpWebSocket` delegates to the same helper. First connect (no cookie) still warms up then opens, unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/sftp/JumpServerSftpSession.test.ts`

Expected: PASS

- [ ] **Step 5: Commit only if the user asked**

---

### Task 8: Full verification

**Files:** none except fixes if a test failed

- [ ] **Step 1: Run the full suite and typecheck**

Run:

```bash
cd at-jumpserver-series
npm test
npm run typecheck
```

Expected: all tests PASS (MCP installer tests that mkdir `~/.cursor` need a non-sandbox shell). No new `tsc` errors.

- [ ] **Step 2: Manual log check (human)**

Reload the extension, connect two SSH assets on the same bastion, then Refresh Files.

Expect in **AT JumpServer Terminal**:

1. First connect: `REST bearer login`, `KoKo warmup login` or `KoKo warmup skipped`, `KoKo terminal websocket` (maybe after warmup), `finished in Nms`. No SFTP connect until Refresh.
2. Second connect: `JumpServer client reused`, `REST bearer reused`, `asset detail reused` if the row was selected, `KoKo endpoint reused`, `KoKo terminal websocket with cached session`, no `REST bearer login`.

- [ ] **Step 3: Commit only if the user asked**

---

## Self-review

| Batch | Task |
|---|---|
| 1 auth lock + skip form + logs | Tasks 1–3 |
| 2 no auto SFTP | Task 4 |
| 3 prefetch detail + cache endpoint | Tasks 5–6 |
| 4 WS before warmup | Task 7 |
| verify | Task 8 |

No HMAC, no `token_reusable: true`, no SecretStorage for cookies.
