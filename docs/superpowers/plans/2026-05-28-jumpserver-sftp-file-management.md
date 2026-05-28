# JumpServer SFTP File Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-phase JumpServer SFTP file management with a Files tree, upload/download, and basic file operations, after proving the KoKo SFTP WebSocket protocol with a standalone probe.

**Architecture:** Reuse the existing JumpServer REST/cookie/session client, add KoKo SFTP WebSocket helpers, then build a small SFTP domain layer that exposes stable manager/session methods to VS Code tree commands. Phase-one UI supports file management only; remote edit auto-sync is documented and reserved through `stat`, `readFile`, `writeFile`, and `createFile` interfaces.

**Tech Stack:** TypeScript, VS Code extension API, Node `fetch`, `ws`, Vitest, existing JumpServer REST and KoKo WebSocket patterns.

---

## File Structure

- `tools/probe-jumpserver-sftp.mjs`: standalone real-instance probe. It must run before extension implementation proceeds.
- `src/jumpserver/types.ts`: add `sftp` to connection protocol types.
- `src/jumpserver/JumpServerClient.ts`: add SFTP token payload, SFTP WebSocket URL, SFTP WebSocket opener.
- `test/jumpserver/JumpServerClient.test.ts`: unit tests for SFTP payload and URL helpers.
- `src/sftp/RemotePath.ts`: path joining, dirname, and safe filename helpers.
- `src/sftp/SftpTypes.ts`: shared SFTP entry/session/manager types.
- `src/sftp/SftpProtocol.ts`: KoKo SFTP message constants, message parsing, raw/base64 helpers, entry normalization.
- `test/sftp/RemotePath.test.ts`: path helper tests.
- `test/sftp/SftpProtocol.test.ts`: message/entry/raw helper tests.
- `src/sftp/JumpServerSftpSession.ts`: KoKo WebSocket-backed SFTP session.
- `test/sftp/JumpServerSftpSession.test.ts`: session command, pending promise, error, upload/download tests.
- `src/sftp/TransferService.ts`: progress wrapper for upload/download commands.
- `src/sftp/VscodeTransferReporter.ts`: VS Code notification progress adapter.
- `src/sftp/JumpServerSftpManager.ts`: asset-keyed session manager.
- `test/sftp/JumpServerSftpManager.test.ts`: manager state and operation routing tests.
- `src/tree/SftpTreeItems.ts`: VS Code tree item classes for SFTP entries.
- `src/tree/SftpTreeProvider.ts`: Files tree provider.
- `test/tree/SftpTreeProvider.test.ts`: tree rendering tests.
- `src/extension.ts`: create the Files view and register SFTP commands.
- `package.json`: add Files view, commands, and menus.
- `test/extension/ExtensionCommands.test.ts`: command/view registration and basic command behavior tests.
- `test/package.manifest.test.ts`: update manifest assertions from "no SFTP" to first-phase SFTP commands.
- `README.md`: document supported SFTP file management and phase-two remote editing.

## Scope Gate

Task 1 is a hard gate. Run the probe against a real JumpServer asset before starting Task 2. If the probe cannot list files, stop and update the protocol assumptions instead of implementing extension UI.

---

### Task 1: Real JumpServer SFTP Probe

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\tools\probe-jumpserver-sftp.mjs`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\package.json`

- [ ] **Step 1: Create the probe script**

Create `tools/probe-jumpserver-sftp.mjs` with this structure:

```js
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { basename, posix } from 'node:path';

const required = ['JUMPSERVER_BASE_URL', 'JUMPSERVER_USERNAME', 'JUMPSERVER_PASSWORD', 'JUMPSERVER_ASSET_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(2);
}

const config = {
  baseUrl: process.env.JUMPSERVER_BASE_URL.replace(/\/+$/, ''),
  username: process.env.JUMPSERVER_USERNAME,
  password: process.env.JUMPSERVER_PASSWORD,
  assetId: process.env.JUMPSERVER_ASSET_ID,
  orgId: process.env.JUMPSERVER_ORG_ID || '',
  verifyTls: process.env.JUMPSERVER_VERIFY_TLS !== 'false',
  testPath: process.env.JUMPSERVER_SFTP_TEST_PATH || '',
  uploadFile: process.env.JUMPSERVER_SFTP_UPLOAD_FILE || ''
};

const cookies = new Map();

function origin() {
  const parsed = new URL(config.baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function captureCookies(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) return;
  for (const part of raw.split(/,(?=\s*[^;,]+=)/g)) {
    const [nameValue] = part.split(';');
    const index = nameValue.indexOf('=');
    if (index > 0) cookies.set(nameValue.slice(0, index).trim(), nameValue.slice(index + 1).trim());
  }
}

async function request(pathOrUrl, init = {}, requireOk = true) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${origin()}${pathOrUrl}`;
  const headers = { ...(init.headers || {}) };
  if (cookieHeader() && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    headers.Cookie = cookieHeader();
  }
  const response = await fetch(url, { ...init, headers });
  captureCookies(response);
  if (requireOk && !response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function authToken() {
  const response = await request('/api/v1/authentication/auth/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password })
  });
  const body = await response.json();
  if (!body.token) throw new Error('Authentication response did not include token.');
  return body.token;
}

function restHeaders(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (config.orgId) headers['X-JMS-ORG'] = config.orgId;
  return headers;
}

function protocolNames(detail) {
  const raw = Array.isArray(detail.permed_protocols) ? detail.permed_protocols : Array.isArray(detail.protocols) ? detail.protocols : [];
  return raw.map((item) => String(item?.name || '')).filter(Boolean);
}

function firstAccount(detail) {
  const accounts = Array.isArray(detail.permed_accounts) ? detail.permed_accounts : Array.isArray(detail.accounts) ? detail.accounts : [];
  const account = accounts.find((item) => item?.has_secret === true && !String(item?.alias || '').startsWith('@')) || accounts[0];
  if (!account?.id) throw new Error('No usable account returned for asset.');
  return {
    id: String(account.id),
    alias: account.alias ? String(account.alias) : undefined,
    username: String(account.username || account.name || account.alias || '')
  };
}

async function createSftpToken(token, assetId, account) {
  const variants = [
    {
      name: 'sftp-connect-method',
      payload: {
        asset: assetId,
        account: account.id,
        protocol: 'sftp',
        input_username: account.username,
        input_secret: '',
        connect_method: 'sftp',
        connect_options: { token_reusable: false, disableautohash: false }
      }
    },
    {
      name: 'no-connect-method',
      payload: {
        asset: assetId,
        account: account.id,
        protocol: 'sftp',
        input_username: account.username,
        input_secret: '',
        connect_options: { token_reusable: false, disableautohash: false }
      }
    }
  ];
  let lastError;
  for (const variant of variants) {
    const response = await request('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { ...restHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(variant.payload)
    }, false);
    if (response.ok) {
      const body = await response.json();
      console.log(`SFTP token payload accepted: ${variant.name}`);
      console.log(`Accepted payload shape: ${JSON.stringify({ ...variant.payload, input_secret: '<redacted>' })}`);
      if (!body.id) throw new Error('Connection token response did not include id.');
      return String(body.id);
    }
    lastError = `variant ${variant.name} failed HTTP ${response.status}: ${await response.text()}`;
    console.warn(lastError);
  }
  throw new Error(lastError || 'No SFTP connection-token payload variant succeeded.');
}

async function warmup(tokenId) {
  const loginPath = '/core/auth/login/?next=/koko/connect/';
  const loginPage = await request(loginPath, { headers: { Accept: 'text/html' } }, false);
  const html = await loginPage.text();
  const csrf = html.match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/i)?.[1];
  if (!csrf) throw new Error('Unable to find csrfmiddlewaretoken.');
  await request(loginPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Referer: `${origin()}${loginPath}`,
      Origin: origin(),
      Cookie: cookieHeader()
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      username: config.username,
      password: config.password,
      auto_login: 'on'
    }).toString(),
    redirect: 'manual'
  }, false);
  await request('/api/v1/users/profile/', { headers: { Accept: 'application/json' } }, false);
  await request(`/koko/connect/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${Date.now()}`, {
    headers: { Accept: 'text/html', Cookie: cookieHeader() },
    redirect: 'manual'
  }, false);
}

async function smartEndpoint(token, tokenId) {
  const response = await request(`/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`, {
    headers: restHeaders(token)
  });
  return response.json();
}

function sftpWsUrl(endpoint, tokenId) {
  const parsed = new URL(config.baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80)) ? `${host}:${port}` : host;
  return `${scheme}://${authority}/koko/ws/sftp/?token=${encodeURIComponent(tokenId)}&_=${Date.now()}`;
}

function decodeRaw(raw) {
  if (!raw) return Buffer.alloc(0);
  if (typeof raw === 'string') return Buffer.from(raw, 'base64');
  if (Array.isArray(raw)) return Buffer.from(raw);
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) return Buffer.from(raw.data);
  return Buffer.from(String(raw), 'base64');
}

async function wsCommand(ws, cmd, data, extra = {}) {
  const id = `${Date.now()}-${Math.random()}`;
  ws.send(JSON.stringify({ id, type: 'SFTP_DATA', cmd, data: JSON.stringify(data), ...extra }));
  const binaries = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${cmd}`)), 30_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'PING') {
        ws.send(JSON.stringify({ id: message.id || '', type: 'PONG', data: 'pong' }));
        return;
      }
      if (message.id !== id) return;
      if (message.err) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(new Error(message.err));
        return;
      }
      if (message.type === 'SFTP_BINARY') {
        binaries.push(decodeRaw(message.raw));
        return;
      }
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ message, binary: Buffer.concat(binaries) });
    };
    ws.on('message', onMessage);
  });
}

async function main() {
  console.log(`API docs: ${config.baseUrl}/api/docs/`);
  const token = await authToken();
  const profile = await (await request('/api/v1/users/profile/', { headers: restHeaders(token) })).json();
  const detail = await (await request(`/api/v1/perms/users/${encodeURIComponent(String(profile.id || profile.username))}/assets/${encodeURIComponent(config.assetId)}/`, { headers: restHeaders(token) })).json();
  const protocols = protocolNames(detail).map((name) => name.toLowerCase());
  console.log(`Asset: ${detail.name || config.assetId}`);
  console.log(`Protocols: ${protocols.join(', ') || '<none>'}`);
  if (!protocols.includes('sftp')) throw new Error('Asset does not expose sftp.');
  const account = firstAccount(detail);
  console.log(`Account: ${JSON.stringify({ id: account.id, alias: account.alias, username: account.username })}`);
  const tokenId = await createSftpToken(token, config.assetId, account);
  const endpoint = await smartEndpoint(token, tokenId);
  await warmup(tokenId);
  const ws = new WebSocket(sftpWsUrl(endpoint, tokenId), ['JMS-KOKO'], {
    origin: origin(),
    headers: { Cookie: cookieHeader(), 'User-Agent': 'AT JumpServer SFTP Probe' },
    rejectUnauthorized: config.verifyTls
  });
  await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type !== 'CONNECT') reject(new Error(`Expected CONNECT, got ${raw}`));
      else resolve();
    });
  });
  const listed = await wsCommand(ws, 'list', { path: config.testPath });
  const entries = JSON.parse(listed.message.data || '[]');
  console.log(`List returned ${entries.length} entries`);
  console.log(JSON.stringify(entries.slice(0, 20), null, 2));
  if (config.uploadFile) {
    const bytes = await readFile(config.uploadFile);
    const remotePath = posix.join(config.testPath || '/', `probe-${Date.now()}-${basename(config.uploadFile).replaceAll('\\', '/')}`);
    await wsCommand(ws, 'upload', { path: remotePath, size: bytes.byteLength }, { raw: bytes.toString('base64') });
    const downloaded = await wsCommand(ws, 'download', { path: remotePath, is_dir: false });
    if (!downloaded.binary.equals(bytes)) throw new Error(`Downloaded bytes differ for ${remotePath}`);
    await wsCommand(ws, 'rm', { path: remotePath });
    console.log(`Upload/download/delete verified: ${remotePath}`);
  }
  ws.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: Add a package script**

Modify `package.json` scripts:

```json
"probe:sftp": "node tools/probe-jumpserver-sftp.mjs"
```

- [ ] **Step 3: Run syntax check**

Run: `node --check tools/probe-jumpserver-sftp.mjs`

Expected: PASS with no output.

- [ ] **Step 4: Run the real probe**

Run with real values:

```powershell
$env:JUMPSERVER_BASE_URL='https://jumpserver.example.com'
$env:JUMPSERVER_USERNAME='your-user'
$env:JUMPSERVER_PASSWORD='your-password'
$env:JUMPSERVER_ASSET_ID='asset-uuid'
$env:JUMPSERVER_ORG_ID=''
npm run probe:sftp
```

Expected: PASS. Output includes:

```text
API docs: https://jumpserver.example.com/api/docs/
SFTP token payload accepted: ...
List returned N entries
```

If this does not pass, stop the implementation and update `docs/superpowers/specs/2026-05-28-jumpserver-sftp-design.md` with the corrected protocol findings.

- [ ] **Step 5: Commit**

Run:

```powershell
git add -f tools/probe-jumpserver-sftp.mjs package.json package-lock.json
git commit -m "test: add JumpServer SFTP probe"
```

---

### Task 2: JumpServer Client SFTP Helpers

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\types.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\JumpServerClient.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\test\jumpserver\JumpServerClient.test.ts`

- [ ] **Step 1: Write failing tests**

Add imports in `test/jumpserver/JumpServerClient.test.ts`:

```ts
import {
  buildSftpConnectionTokenPayload,
  buildKokoSftpWsUrl,
  DEFAULT_SFTP_CONNECT_OPTIONS
} from '../../src/jumpserver/JumpServerClient';
```

Add tests inside `JumpServerClient pure helpers`:

```ts
it('builds KoKo SFTP websocket URL from smart endpoint', () => {
  expect(
    buildKokoSftpWsUrl('https://jumpserver.example.com', { host: 'koko.example.com', https_port: 8443 }, 'token-1', 1000)
  ).toBe('wss://koko.example.com:8443/koko/ws/sftp/?token=token-1&_=1000');
});

it('builds SFTP connection-token payload with the probe-confirmed method', () => {
  expect(buildSftpConnectionTokenPayload({
    assetId: 'asset-1',
    account: { id: 'account-1', username: 'root' }
  })).toEqual({
    asset: 'asset-1',
    account: 'account-1',
    protocol: 'sftp',
    input_username: 'root',
    input_secret: '',
    connect_method: 'sftp',
    connect_options: DEFAULT_SFTP_CONNECT_OPTIONS
  });
});
```

Add REST-flow test:

```ts
it('opens KoKo SFTP websocket with warmed cookies', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', { headers: { 'set-cookie': 'csrftoken=abc; Path=/' } }))
    .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' } }))
    .mockResolvedValueOnce(textResponse('ok'))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
    .mockResolvedValueOnce(textResponse('<html>koko</html>'));
  const socket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
  const webSocketFactory = vi.fn(async () => socket);
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await client.openKokoSftpWebSocket({
    endpoint: { host: 'koko.example.com', https_port: 443 },
    tokenId: 'token-1',
    webSocketFactory
  });

  expect(webSocketFactory).toHaveBeenCalledWith('wss://koko.example.com/koko/ws/sftp/?token=token-1&_=1000', expect.objectContaining({
    origin: 'https://jumpserver.example.com',
    rejectUnauthorized: true,
    headers: expect.objectContaining({ Cookie: 'csrftoken=abc; sessionid=session-1' })
  }));
});
```

Use a fake timestamp by passing `1000` through an optional timestamp argument if needed; otherwise use `expect.stringContaining('/koko/ws/sftp/?token=token-1')`.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL because SFTP helpers do not exist.

- [ ] **Step 3: Implement helpers**

Modify `src/jumpserver/types.ts`:

```ts
export type JumpServerConnectionProtocol = 'ssh' | 'mysql' | 'sftp';
```

Add to `src/jumpserver/JumpServerClient.ts`:

```ts
export const DEFAULT_SFTP_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export function buildKokoSftpWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now()
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  return `${scheme}://${authority}/koko/ws/sftp/?token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function buildSftpConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: 'sftp',
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'sftp',
    connect_options: DEFAULT_SFTP_CONNECT_OPTIONS
  };
}
```

Update `buildConnectionTokenPayload`:

```ts
if (input.protocol === 'mysql') {
  return buildMysqlConnectionTokenPayload(input);
}
if (input.protocol === 'sftp') {
  return buildSftpConnectionTokenPayload(input);
}
```

Add method to `JumpServerClient`:

```ts
async openKokoSftpWebSocket(input: {
  endpoint: JumpServerEndpoint;
  tokenId: string;
  webSocketFactory?: WebSocketFactory;
}): Promise<KokoWebSocket> {
  await this.warmupKokoConnectPage(input.tokenId);
  const url = buildKokoSftpWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId);
  const factory = input.webSocketFactory ?? defaultWebSocketFactory;
  return factory(url, {
    origin: buildOrigin(this.settings.baseUrl),
    headers: {
      Cookie: this.cookieHeader(),
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': 'AT JumpServer SFTP'
    },
    rejectUnauthorized: this.settings.verifyTls
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\jumpserver\types.ts src\jumpserver\JumpServerClient.ts test\jumpserver\JumpServerClient.test.ts
git commit -m "feat: add JumpServer SFTP protocol helpers"
```

---

### Task 3: SFTP Protocol Types And Normalizers

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\RemotePath.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\SftpTypes.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\SftpProtocol.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\test\sftp\RemotePath.test.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\test\sftp\SftpProtocol.test.ts`

- [ ] **Step 1: Write failing path tests**

Create `test/sftp/RemotePath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dirname, joinRemotePath, remoteBasename } from '../../src/sftp/RemotePath';

describe('RemotePath', () => {
  it('joins POSIX paths without duplicate separators', () => {
    expect(joinRemotePath('/', 'app.txt')).toBe('/app.txt');
    expect(joinRemotePath('/home/deploy/', '/app.txt')).toBe('/home/deploy/app.txt');
  });

  it('returns parent directories', () => {
    expect(dirname('/home/deploy/app.txt')).toBe('/home/deploy');
    expect(dirname('/home')).toBe('/');
    expect(dirname('/')).toBe('/');
  });

  it('returns a safe basename fallback', () => {
    expect(remoteBasename('/home/deploy/app.txt')).toBe('app.txt');
    expect(remoteBasename('/')).toBe('remote-file');
  });
});
```

- [ ] **Step 2: Write failing protocol tests**

Create `test/sftp/SftpProtocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeSftpRaw, normalizeSftpEntries, parseSftpMessage } from '../../src/sftp/SftpProtocol';

describe('SftpProtocol', () => {
  it('parses JSON websocket messages', () => {
    expect(parseSftpMessage(Buffer.from('{"id":"1","type":"PING","data":"ping"}'))).toEqual({
      id: '1',
      type: 'PING',
      data: 'ping'
    });
  });

  it('decodes raw payloads from base64 strings and byte arrays', () => {
    expect(decodeSftpRaw(Buffer.from('hello').toString('base64')).equals(Buffer.from('hello'))).toBe(true);
    expect(decodeSftpRaw([104, 105]).equals(Buffer.from('hi'))).toBe(true);
    expect(decodeSftpRaw({ type: 'Buffer', data: [111, 107] }).equals(Buffer.from('ok'))).toBe(true);
  });

  it('normalizes KoKo SFTP file entries', () => {
    expect(normalizeSftpEntries('/home/deploy', [
      { name: 'app', is_dir: true, size: '', mod_time: '1714280000' },
      { name: 'readme.txt', is_dir: false, size: '12', mod_time: '1714280001' },
      { name: 'link', type: 'symlink', size: 1 }
    ])).toEqual([
      { name: 'app', path: '/home/deploy/app', type: 'directory', modifiedAt: 1714280000 },
      { name: 'readme.txt', path: '/home/deploy/readme.txt', type: 'file', size: 12, modifiedAt: 1714280001 },
      { name: 'link', path: '/home/deploy/link', type: 'symlink', size: 1 }
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- test/sftp/RemotePath.test.ts test/sftp/SftpProtocol.test.ts`

Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement types and helpers**

Create `src/sftp/RemotePath.ts`:

```ts
export function joinRemotePath(parent: string, child: string): string {
  const cleanParent = parent === '/' ? '' : parent.replace(/\/+$/, '');
  const cleanChild = child.replace(/^\/+/, '');
  return `${cleanParent}/${cleanChild}` || '/';
}

export function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function remoteBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() || 'remote-file';
}
```

Create `src/sftp/SftpTypes.ts`:

```ts
import type { CachedJumpServerAsset } from '../config/schema';

export type JumpServerSftpEntryType = 'file' | 'directory' | 'symlink';

export interface JumpServerSftpEntry {
  name: string;
  path: string;
  type: JumpServerSftpEntryType;
  size?: number;
  modifiedAt?: number;
}

export interface JumpServerSftpFileStat {
  size: number;
  modifiedAt: number;
}

export interface JumpServerSftpSnapshot {
  asset: CachedJumpServerAsset;
  rootPath: string;
  entries: JumpServerSftpEntry[];
}

export interface JumpServerSftpCommandProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}
```

Create `src/sftp/SftpProtocol.ts`:

```ts
import { joinRemotePath } from './RemotePath';
import type { JumpServerSftpEntry, JumpServerSftpEntryType } from './SftpTypes';

export type SftpMessageType = 'CONNECT' | 'CLOSE' | 'ERROR' | 'PING' | 'PONG' | 'SFTP_DATA' | 'SFTP_BINARY';
export type SftpCommand = 'list' | 'download' | 'upload' | 'rm' | 'rename' | 'mkdir';

export interface KokoSftpMessage {
  id?: string;
  type?: SftpMessageType | string;
  cmd?: SftpCommand | string;
  data?: string;
  raw?: unknown;
  err?: string;
  current_path?: string;
}

export function parseSftpMessage(input: Buffer | string): KokoSftpMessage {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('KoKo SFTP message is not an object.');
  }
  return parsed as KokoSftpMessage;
}

export function decodeSftpRaw(raw: unknown): Buffer {
  if (!raw) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'base64');
  }
  if (Array.isArray(raw)) {
    return Buffer.from(raw);
  }
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as { type?: unknown; data?: unknown };
    if (record.type === 'Buffer' && Array.isArray(record.data)) {
      return Buffer.from(record.data);
    }
  }
  return Buffer.from(String(raw), 'base64');
}

export function encodeSftpRaw(bytes: Buffer): string {
  return bytes.toString('base64');
}

export function normalizeSftpEntries(parentPath: string, value: unknown): JumpServerSftpEntry[] {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    .map((row) => normalizeSftpEntry(parentPath, row));
}

function normalizeSftpEntry(parentPath: string, row: Record<string, unknown>): JumpServerSftpEntry {
  const name = String(row.name || row.filename || '');
  const size = optionalNumber(row.size);
  const modifiedAt = optionalNumber(row.mod_time ?? row.modifiedAt ?? row.mtime);
  const type = entryType(row);
  return {
    name,
    path: joinRemotePath(parentPath || '/', name),
    type,
    ...(size === undefined ? {} : { size }),
    ...(modifiedAt === undefined ? {} : { modifiedAt })
  };
}

function entryType(row: Record<string, unknown>): JumpServerSftpEntryType {
  if (row.is_dir === true || String(row.type || '').toLowerCase() === 'dir' || String(row.type || '').toLowerCase() === 'directory') {
    return 'directory';
  }
  if (String(row.type || '').toLowerCase() === 'symlink' || String(row.type || '').toLowerCase() === 'link') {
    return 'symlink';
  }
  return 'file';
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test -- test/sftp/RemotePath.test.ts test/sftp/SftpProtocol.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\sftp\RemotePath.ts src\sftp\SftpTypes.ts src\sftp\SftpProtocol.ts test\sftp\RemotePath.test.ts test\sftp\SftpProtocol.test.ts
git commit -m "feat: add JumpServer SFTP protocol utilities"
```

---

### Task 4: KoKo WebSocket SFTP Session

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\JumpServerSftpSession.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\test\sftp\JumpServerSftpSession.test.ts`

- [ ] **Step 1: Write failing session tests**

Create `test/sftp/JumpServerSftpSession.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { JumpServerSftpSession } from '../../src/sftp/JumpServerSftpSession';

class FakeSocket extends EventEmitter {
  readonly send = vi.fn();
  readonly close = vi.fn();
  emitMessage(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }
}

function client(socket: FakeSocket) {
  return {
    getAssetDetail: vi.fn(async () => ({
      permed_protocols: [{ name: 'sftp' }],
      permed_accounts: [{ id: 'account-1', username: 'root', has_secret: true }]
    })),
    createConnectionToken: vi.fn(async () => ({ id: 'token-1' })),
    getSmartEndpoint: vi.fn(async () => ({ host: 'koko.example.com', https_port: 443 })),
    openKokoSftpWebSocket: vi.fn(async () => socket)
  };
}

describe('JumpServerSftpSession', () => {
  it('connects with SFTP token flow and lists a directory', async () => {
    const socket = new FakeSocket();
    const fakeClient = client(socket);
    const session = new JumpServerSftpSession({
      asset: { id: 'asset-1', name: 'web-1' },
      client: fakeClient
    });

    const connect = session.connect();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;
    const list = session.listDirectory('/home/root');
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(sent).toMatchObject({ type: 'SFTP_DATA', cmd: 'list' });
    expect(JSON.parse(sent.data)).toEqual({ path: '/home/root' });
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/home/root',
      data: JSON.stringify([{ name: 'app', is_dir: true }])
    });

    await expect(list).resolves.toEqual([{ name: 'app', path: '/home/root/app', type: 'directory' }]);
    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'asset-1',
      account: { id: 'account-1', username: 'root', hasSecret: true },
      protocol: 'sftp'
    });
  });

  it('responds to PING with PONG', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    socket.emitMessage({ id: 'ping-1', type: 'PING', data: 'ping' });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ id: 'ping-1', type: 'PONG', data: 'pong' }));
  });

  it('downloads binary chunks before the final SFTP_DATA response', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const download = session.downloadFile('/tmp/a.txt');
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_BINARY', cmd: 'download', raw: Buffer.from('hello').toString('base64') });
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'download', data: 'a.txt' });

    await expect(download).resolves.toEqual(Buffer.from('hello'));
  });

  it('rejects pending commands on CLOSE', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const list = session.listDirectory('/');
    socket.emitMessage({ type: 'CLOSE', err: 'Session expired or not found' });

    await expect(list).rejects.toThrow('Session expired or not found');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/sftp/JumpServerSftpSession.test.ts`

Expected: FAIL because `JumpServerSftpSession` does not exist.

- [ ] **Step 3: Implement session**

Create `src/sftp/JumpServerSftpSession.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import { extractProtocolNames, resolveFirstUsableAccount, type KokoWebSocket } from '../jumpserver/JumpServerClient';
import type { JumpServerConnectionProtocol } from '../jumpserver/types';
import { decodeSftpRaw, encodeSftpRaw, normalizeSftpEntries, parseSftpMessage, type KokoSftpMessage, type SftpCommand } from './SftpProtocol';
import type { JumpServerSftpEntry } from './SftpTypes';

export interface JumpServerSftpSessionAsset {
  id: string;
  name: string;
}

export interface JumpServerSftpSessionClient {
  getAssetDetail(assetId: string): Promise<Record<string, any>>;
  createConnectionToken(input: {
    assetId: string;
    account: { id: string; alias?: string; username: string; hasSecret?: boolean };
    protocol: JumpServerConnectionProtocol;
  }): Promise<{ id: string }>;
  getSmartEndpoint(tokenId: string): Promise<Record<string, any>>;
  openKokoSftpWebSocket(input: { endpoint: Record<string, any>; tokenId: string }): Promise<KokoWebSocket>;
}

interface PendingCommand {
  cmd: SftpCommand;
  chunks: Buffer[];
  resolve(value: any): void;
  reject(error: Error): void;
}

export class JumpServerSftpSession {
  private socket: KokoWebSocket | undefined;
  private connected = false;
  private connectResolver: (() => void) | undefined;
  private connectRejecter: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  private currentPath = '/';

  constructor(private readonly input: {
    asset: JumpServerSftpSessionAsset;
    client: JumpServerSftpSessionClient;
  }) {}

  async connect(): Promise<void> {
    const detail = await this.input.client.getAssetDetail(this.input.asset.id);
    const protocols = extractProtocolNames(detail).map((name) => name.toLowerCase());
    if (!protocols.includes('sftp')) {
      throw new Error('Selected asset does not expose SFTP protocol.');
    }
    const account = resolveFirstUsableAccount(detail);
    const token = await this.input.client.createConnectionToken({
      assetId: this.input.asset.id,
      account,
      protocol: 'sftp'
    });
    const endpoint = await this.input.client.getSmartEndpoint(token.id);
    this.socket = await this.input.client.openKokoSftpWebSocket({ endpoint, tokenId: token.id });
    this.bindSocket(this.socket);
    await new Promise<void>((resolve, reject) => {
      this.connectResolver = resolve;
      this.connectRejecter = reject;
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async realpath(path = '.'): Promise<string> {
    if (path === '.') {
      return this.currentPath || '/';
    }
    const entries = await this.listDirectory(path);
    return entries.length >= 0 ? path : path;
  }

  listDirectory(path: string): Promise<JumpServerSftpEntry[]> {
    return this.sendCommand('list', { path }).then((message) => {
      this.currentPath = message.current_path || path || this.currentPath;
      return normalizeSftpEntries(this.currentPath, JSON.parse(message.data || '[]'));
    });
  }

  mkdir(path: string): Promise<void> {
    return this.sendCommand('mkdir', { path }).then(() => undefined);
  }

  rename(path: string, newName: string): Promise<void> {
    return this.sendCommand('rename', { path, new_name: newName }).then(() => undefined);
  }

  deleteEntry(path: string): Promise<void> {
    return this.sendCommand('rm', { path }).then(() => undefined);
  }

  downloadFile(path: string, isDir = false): Promise<Buffer> {
    return this.sendCommand('download', { path, is_dir: isDir }).then((_message, command) => Buffer.concat(command.chunks));
  }

  uploadBytes(path: string, bytes: Buffer): Promise<void> {
    return this.sendCommand('upload', { path, size: bytes.byteLength }, { raw: encodeSftpRaw(bytes) }).then(() => undefined);
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number }> {
    const parent = path.replace(/\/+[^/]*$/, '') || '/';
    const name = path.split('/').filter(Boolean).pop();
    const entry = (await this.listDirectory(parent)).find((item) => item.name === name || item.path === path);
    if (!entry) {
      throw new Error(`Remote path not found: ${path}`);
    }
    return { size: entry.size ?? 0, modifiedAt: entry.modifiedAt ?? 0 };
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const content = await this.downloadFile(path, false);
    if (content.byteLength > maxBytes) {
      throw new Error(`Remote file exceeds preview limit: ${path}`);
    }
    return content;
  }

  writeFile(path: string, content: Buffer): Promise<void> {
    return this.uploadBytes(path, content);
  }

  createFile(path: string): Promise<void> {
    return this.uploadBytes(path, Buffer.alloc(0));
  }

  dispose(): void {
    this.rejectAll(new Error('SFTP session disposed.'));
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  private sendCommand(cmd: SftpCommand, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<KokoSftpMessage> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('SFTP connection is not available.'));
    }
    const id = randomUUID();
    const payload = { id, type: 'SFTP_DATA', cmd, data: JSON.stringify(data), ...extra };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { cmd, chunks: [], resolve, reject });
      this.socket?.send(JSON.stringify(payload));
    });
  }

  private bindSocket(socket: KokoWebSocket): void {
    socket.on('message', (message: Buffer | string) => this.handleSocketMessage(message));
    socket.on('close', () => this.handleClose(new Error('SFTP websocket closed.')));
    socket.on('error', (error) => this.handleClose(error instanceof Error ? error : new Error(String(error))));
  }

  private handleSocketMessage(raw: Buffer | string): void {
    let message: KokoSftpMessage;
    try {
      message = parseSftpMessage(raw);
    } catch (error) {
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (message.type === 'CONNECT') {
      this.connected = true;
      this.connectResolver?.();
      this.connectResolver = undefined;
      this.connectRejecter = undefined;
      return;
    }
    if (message.type === 'PING') {
      this.socket?.send(JSON.stringify({ id: message.id || '', type: 'PONG', data: 'pong' }));
      return;
    }
    if (message.type === 'CLOSE' || message.type === 'ERROR') {
      this.handleClose(new Error(message.err || 'SFTP session closed.'));
      return;
    }
    const id = message.id || '';
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    if (message.err) {
      this.pending.delete(id);
      pending.reject(new Error(message.err));
      return;
    }
    if (message.type === 'SFTP_BINARY') {
      pending.chunks.push(decodeSftpRaw(message.raw));
      return;
    }
    if (message.type === 'SFTP_DATA') {
      this.pending.delete(id);
      pending.resolve(message);
    }
  }

  private handleClose(error: Error): void {
    this.connected = false;
    this.connectRejecter?.(error);
    this.connectResolver = undefined;
    this.connectRejecter = undefined;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/sftp/JumpServerSftpSession.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\sftp\JumpServerSftpSession.ts test\sftp\JumpServerSftpSession.test.ts
git commit -m "feat: add KoKo SFTP session"
```

---

### Task 5: SFTP Manager And Transfer Progress

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\TransferService.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\VscodeTransferReporter.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\sftp\JumpServerSftpManager.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\test\sftp\JumpServerSftpManager.test.ts`

- [ ] **Step 1: Write failing manager tests**

Create `test/sftp/JumpServerSftpManager.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { JumpServerSftpManager } from '../../src/sftp/JumpServerSftpManager';
import type { CachedJumpServerAsset } from '../../src/config/schema';

function asset(overrides: Partial<CachedJumpServerAsset> = {}): CachedJumpServerAsset {
  return {
    id: 'asset-1',
    name: 'web-1',
    address: '10.0.0.1',
    platform: 'Linux',
    category: 'host',
    type: 'server',
    zoneName: '',
    nodePath: [],
    protocolNames: ['ssh', 'sftp'],
    raw: {},
    ...overrides
  };
}

function session() {
  return {
    connect: vi.fn(),
    realpath: vi.fn(async () => '/home/root'),
    listDirectory: vi.fn(async () => [{ name: 'app', path: '/home/root/app', type: 'directory' as const }]),
    mkdir: vi.fn(),
    rename: vi.fn(),
    deleteEntry: vi.fn(),
    uploadBytes: vi.fn(),
    downloadFile: vi.fn(async () => Buffer.from('hello')),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    dispose: vi.fn()
  };
}

describe('JumpServerSftpManager', () => {
  it('starts with no active file tree', () => {
    const manager = new JumpServerSftpManager({ createSession: vi.fn() });
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('opens an asset and lists its root lazily', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });
    await manager.openAsset(asset());

    expect(await manager.ensureRoot()).toBe('/home/root');
    await expect(manager.listDirectory()).resolves.toEqual([{ name: 'app', path: '/home/root/app', type: 'directory' }]);
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/root', asset: expect.objectContaining({ id: 'asset-1' }) });
  });

  it('routes mutations and refreshes current path inputs', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });
    await manager.openAsset(asset());
    await manager.ensureRoot();

    await manager.mkdir('/home/root/new-dir');
    await manager.rename('/home/root/old', '/home/root/new');
    await manager.deleteEntry({ name: 'new', path: '/home/root/new', type: 'file' });

    expect(fakeSession.mkdir).toHaveBeenCalledWith('/home/root/new-dir');
    expect(fakeSession.rename).toHaveBeenCalledWith('/home/root/old', '/home/root/new');
    expect(fakeSession.deleteEntry).toHaveBeenCalledWith('/home/root/new');
  });

  it('keeps a disconnected snapshot after dispose active session', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });
    await manager.openAsset(asset());
    await manager.listDirectory();
    manager.closeActive();

    expect(manager.getState()).toEqual({
      kind: 'disconnected',
      rootPath: '/home/root',
      entries: [{ name: 'app', path: '/home/root/app', type: 'directory' }],
      asset: expect.objectContaining({ id: 'asset-1' })
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/sftp/JumpServerSftpManager.test.ts`

Expected: FAIL because manager does not exist.

- [ ] **Step 3: Implement transfer service and manager**

Create `src/sftp/TransferService.ts`:

```ts
export interface TransferProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}

export interface TransferReporter {
  withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T>;
  notifySuccess(message: string): Promise<void>;
}

const noopProgress: TransferProgress = { report: () => undefined };

export class TransferService {
  constructor(private readonly reporter?: TransferReporter) {}

  async run<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    const result = this.reporter
      ? await this.reporter.withProgress(label, job)
      : await job(noopProgress);
    await this.reporter?.notifySuccess(`${label} completed.`);
    return result;
  }
}
```

Create `src/sftp/VscodeTransferReporter.ts`:

```ts
import * as vscode from 'vscode';
import { showTimedNotification } from '../utils/notifications';
import type { TransferProgress, TransferReporter } from './TransferService';

export class VscodeTransferReporter implements TransferReporter {
  async withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: label,
      cancellable: false
    }, async (progress) => {
      return await job({
        report(event) {
          const increment = event.totalBytes > 0 ? (event.transferredBytes / event.totalBytes) * 100 : 0;
          progress.report({ increment, message: `${event.transferredBytes}/${event.totalBytes} bytes` });
        }
      });
    });
  }

  async notifySuccess(message: string): Promise<void> {
    await showTimedNotification(message);
  }
}
```

Create `src/sftp/JumpServerSftpManager.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import type { CachedJumpServerAsset } from '../config/schema';
import { dirname } from './RemotePath';
import type { JumpServerSftpEntry, JumpServerSftpFileStat } from './SftpTypes';
import { TransferService, type TransferReporter } from './TransferService';

export interface JumpServerSftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<JumpServerSftpEntry[]>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteEntry(path: string): Promise<void>;
  uploadBytes(path: string, bytes: Buffer): Promise<void>;
  downloadFile(path: string, isDir?: boolean): Promise<Buffer>;
  stat(path: string): Promise<JumpServerSftpFileStat>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  createFile(path: string): Promise<void>;
  dispose(): void;
}

export type JumpServerSftpTreeState =
  | { kind: 'none' }
  | { kind: 'active'; asset: CachedJumpServerAsset; rootPath: string }
  | { kind: 'disconnected'; asset: CachedJumpServerAsset; rootPath: string; entries: JumpServerSftpEntry[] };

interface ManagedConnection {
  asset: CachedJumpServerAsset;
  session: JumpServerSftpSessionLike | undefined;
  rootPath: string | undefined;
  snapshot: { rootPath: string; entries: JumpServerSftpEntry[] } | undefined;
}

export class JumpServerSftpManager {
  private active: ManagedConnection | undefined;
  private readonly transfers: TransferService;

  constructor(private readonly options: {
    createSession(asset: CachedJumpServerAsset): JumpServerSftpSessionLike | Promise<JumpServerSftpSessionLike>;
    reporter?: TransferReporter;
  }) {
    this.transfers = new TransferService(options.reporter);
  }

  async openAsset(asset: CachedJumpServerAsset): Promise<void> {
    this.closeActive();
    this.active = { asset, session: undefined, rootPath: undefined, snapshot: undefined };
    await this.ensureRoot();
  }

  closeActive(): void {
    this.active?.session?.dispose();
    if (this.active?.snapshot) {
      this.active.session = undefined;
      this.active.rootPath = undefined;
      return;
    }
    this.active = undefined;
  }

  dispose(): void {
    this.active?.session?.dispose();
    this.active = undefined;
  }

  getState(): JumpServerSftpTreeState {
    if (!this.active) return { kind: 'none' };
    if (this.active.rootPath) return { kind: 'active', asset: this.active.asset, rootPath: this.active.rootPath };
    if (this.active.snapshot) return { kind: 'disconnected', asset: this.active.asset, ...this.active.snapshot };
    return { kind: 'none' };
  }

  async ensureRoot(): Promise<string> {
    const connection = this.requireConnection();
    const session = await this.ensureSession(connection);
    connection.rootPath = await session.realpath('.');
    return connection.rootPath;
  }

  async listDirectory(path?: string): Promise<JumpServerSftpEntry[]> {
    const connection = this.requireConnection();
    const root = connection.rootPath ?? await this.ensureRoot();
    const target = path ?? root;
    const entries = await (await this.ensureSession(connection)).listDirectory(target);
    if (target === root) {
      connection.snapshot = { rootPath: root, entries };
    }
    return entries;
  }

  async changeDirectory(path: string): Promise<string> {
    const connection = this.requireConnection();
    connection.rootPath = await (await this.ensureSession(connection)).realpath(path);
    return connection.rootPath;
  }

  async changeToParentDirectory(): Promise<string> {
    const state = this.getState();
    if (state.kind !== 'active') throw new Error('No active JumpServer SFTP asset.');
    return await this.changeDirectory(dirname(state.rootPath));
  }

  async mkdir(path: string): Promise<void> {
    await (await this.ensureSession(this.requireConnection())).mkdir(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await (await this.ensureSession(this.requireConnection())).rename(oldPath, newPath);
  }

  async deleteEntry(entry: JumpServerSftpEntry): Promise<void> {
    await (await this.ensureSession(this.requireConnection())).deleteEntry(entry.path);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.transfers.run(`Upload ${remotePath}`, async () => {
      const bytes = await readFile(localPath);
      await (await this.ensureSession(this.requireConnection())).uploadBytes(remotePath, bytes);
    });
  }

  async downloadFile(remotePath: string, localPath: string, isDir = false): Promise<void> {
    await this.transfers.run(`Download ${remotePath}`, async () => {
      const bytes = await (await this.ensureSession(this.requireConnection())).downloadFile(remotePath, isDir);
      await writeFile(localPath, bytes);
    });
  }

  stat(path: string): Promise<JumpServerSftpFileStat> {
    return this.ensureSession(this.requireConnection()).then((session) => session.stat(path));
  }

  readFile(path: string, maxBytes: number): Promise<Buffer> {
    return this.ensureSession(this.requireConnection()).then((session) => session.readFile(path, maxBytes));
  }

  writeFile(path: string, content: Buffer): Promise<void> {
    return this.ensureSession(this.requireConnection()).then((session) => session.writeFile(path, content));
  }

  createFile(path: string): Promise<void> {
    return this.ensureSession(this.requireConnection()).then((session) => session.createFile(path));
  }

  private requireConnection(): ManagedConnection {
    if (!this.active) throw new Error('No active JumpServer SFTP asset.');
    return this.active;
  }

  private async ensureSession(connection: ManagedConnection): Promise<JumpServerSftpSessionLike> {
    if (connection.session) return connection.session;
    const session = await this.options.createSession(connection.asset);
    connection.session = session;
    await session.connect();
    return session;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/sftp/JumpServerSftpManager.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\sftp\TransferService.ts src\sftp\VscodeTransferReporter.ts src\sftp\JumpServerSftpManager.ts test\sftp\JumpServerSftpManager.test.ts
git commit -m "feat: add JumpServer SFTP manager"
```

---

### Task 6: SFTP Tree View Provider

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\tree\SftpTreeItems.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\tree\SftpTreeProvider.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\test\tree\SftpTreeProvider.test.ts`

- [ ] **Step 1: Write failing tree tests**

Create `test/tree/SftpTreeProvider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SftpTreeProvider } from '../../src/tree/SftpTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpPlaceholderTreeItem } from '../../src/tree/SftpTreeItems';

const entries = [
  { name: 'app', path: '/home/root/app', type: 'directory' as const },
  { name: 'readme.txt', path: '/home/root/readme.txt', type: 'file' as const, size: 12 }
];

describe('SftpTreeProvider', () => {
  it('shows a placeholder with no active SFTP asset', async () => {
    const provider = new SftpTreeProvider({ getState: () => ({ kind: 'none' }) });
    const children = await provider.getChildren();

    expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
    expect(children[0].label).toBe('Open files from a JumpServer asset');
  });

  it('renders active root entries with a parent entry', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/root', asset: {} as never }),
      listDirectory: async () => entries
    });

    const children = await provider.getChildren();

    expect(children[0].label).toBe('..');
    expect(children[1]).toBeInstanceOf(SftpDirectoryTreeItem);
    expect(children[2]).toBeInstanceOf(SftpFileTreeItem);
  });

  it('renders disconnected snapshot entries', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'disconnected', rootPath: '/home/root', entries, asset: {} as never })
    });

    const children = await provider.getChildren();

    expect(children.map((child) => child.contextValue)).toEqual(['jumpserverSftpDisconnectedDirectory', 'jumpserverSftpDisconnectedFile']);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/tree/SftpTreeProvider.test.ts`

Expected: FAIL because tree provider does not exist.

- [ ] **Step 3: Implement tree items and provider**

Create `src/tree/SftpTreeItems.ts`:

```ts
import * as vscode from 'vscode';
import type { JumpServerSftpEntry } from '../sftp/SftpTypes';

export class SftpPlaceholderTreeItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'jumpserverSftpPlaceholder';
  }
}

export class SftpParentDirectoryTreeItem extends vscode.TreeItem {
  constructor() {
    super('..', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'jumpserverSftpParentDirectory';
    this.command = { command: 'jumpserverManager.sftp.goUp', title: 'Go Up' };
  }
}

export class SftpDirectoryTreeItem extends vscode.TreeItem {
  constructor(readonly entry: JumpServerSftpEntry, disconnected = false) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = disconnected ? 'jumpserverSftpDisconnectedDirectory' : 'jumpserverSftpDirectory';
    this.tooltip = entry.path;
  }
}

export class SftpFileTreeItem extends vscode.TreeItem {
  constructor(readonly entry: JumpServerSftpEntry, disconnected = false) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = disconnected ? 'jumpserverSftpDisconnectedFile' : 'jumpserverSftpFile';
    this.description = entry.size === undefined ? undefined : `${entry.size} B`;
    this.tooltip = entry.path;
  }
}
```

Create `src/tree/SftpTreeProvider.ts`:

```ts
import * as vscode from 'vscode';
import type { JumpServerSftpEntry } from '../sftp/SftpTypes';
import type { JumpServerSftpTreeState } from '../sftp/JumpServerSftpManager';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpParentDirectoryTreeItem, SftpPlaceholderTreeItem } from './SftpTreeItems';

export interface SftpTreeSource {
  getState(): JumpServerSftpTreeState;
  listDirectory?(path?: string): Promise<JumpServerSftpEntry[]>;
}

export type SftpTreeNode = SftpPlaceholderTreeItem | SftpParentDirectoryTreeItem | SftpDirectoryTreeItem | SftpFileTreeItem;

export class SftpTreeProvider implements vscode.TreeDataProvider<SftpTreeNode> {
  private readonly changed = new vscode.EventEmitter<SftpTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: SftpTreeSource) {}

  refresh(item?: SftpTreeNode): void {
    this.changed.fire(item);
  }

  getTreeItem(element: SftpTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SftpTreeNode): Promise<SftpTreeNode[]> {
    const state = this.source.getState();
    if (state.kind === 'none') {
      return element ? [] : [new SftpPlaceholderTreeItem('Open files from a JumpServer asset')];
    }
    if (state.kind === 'disconnected') {
      return element ? [] : state.entries.map((entry) => this.toTreeItem(entry, true));
    }
    const path = element instanceof SftpDirectoryTreeItem ? element.entry.path : state.rootPath;
    const entries = await this.source.listDirectory?.(path) ?? [];
    const children = entries.map((entry) => this.toTreeItem(entry, false));
    return element || state.rootPath === '/' ? children : [new SftpParentDirectoryTreeItem(), ...children];
  }

  private toTreeItem(entry: JumpServerSftpEntry, disconnected: boolean): SftpTreeNode {
    return entry.type === 'directory'
      ? new SftpDirectoryTreeItem(entry, disconnected)
      : new SftpFileTreeItem(entry, disconnected);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/tree/SftpTreeProvider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\tree\SftpTreeItems.ts src\tree\SftpTreeProvider.ts test\tree\SftpTreeProvider.test.ts
git commit -m "feat: add JumpServer SFTP file tree"
```

---

### Task 7: Manifest And Extension Command Wiring

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\package.json`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\extension.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\test-fixtures\vscode.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\test\extension\ExtensionCommands.test.ts`

- [ ] **Step 1: Extend VS Code test fixture**

Modify `test-fixtures/vscode.ts`:

```ts
export const window = {
  createTreeView: vi.fn(),
  createWebviewPanel: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  withProgress: vi.fn((_options, task) => task({ report: vi.fn() }))
};

export const env = {
  clipboard: {
    writeText: vi.fn()
  }
};
```

- [ ] **Step 2: Write failing extension tests**

In `test/extension/ExtensionCommands.test.ts`, update JumpServerClient mock to include SFTP methods:

```ts
openKokoSftpWebSocket: vi.fn()
```

Add test:

```ts
it('registers JumpServer SFTP file tree and commands', () => {
  const context = contextWithSettings();
  activate(context);

  expect(vscode.window.createTreeView).toHaveBeenCalledWith('jumpserverManager.sftpFiles', expect.any(Object));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.open', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.refresh', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.upload', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.download', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.delete', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.rename', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.newFolder', expect.any(Function));
  expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.copyPath', expect.any(Function));
});
```

Add unsupported SFTP asset test:

```ts
it('shows a clear error when opening files for an asset without SFTP', async () => {
  const context = contextWithSettings();
  activate(context);
  const openFiles = registeredCommand('jumpserverManager.sftp.open');

  await openFiles({ asset: { id: 'redis-1', name: 'redis-1', protocolNames: ['redis'] } });

  expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Asset does not support SFTP: redis-1', 'error');
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- test/extension/ExtensionCommands.test.ts`

Expected: FAIL because SFTP view and commands are not registered.

- [ ] **Step 4: Modify package manifest**

In `package.json`, add the Files view under `contributes.views.jumpserverManager`:

```json
{
  "id": "jumpserverManager.sftpFiles",
  "name": "Files"
}
```

Add commands:

```json
{ "command": "jumpserverManager.sftp.open", "title": "JumpServer: Open Files", "icon": "$(folder-opened)" },
{ "command": "jumpserverManager.sftp.refresh", "title": "JumpServer Files: Refresh", "icon": "$(refresh)" },
{ "command": "jumpserverManager.sftp.goToPath", "title": "JumpServer Files: Go To Path" },
{ "command": "jumpserverManager.sftp.goUp", "title": "JumpServer Files: Go Up", "icon": "$(arrow-up)" },
{ "command": "jumpserverManager.sftp.upload", "title": "JumpServer Files: Upload", "icon": "$(cloud-upload)" },
{ "command": "jumpserverManager.sftp.download", "title": "JumpServer Files: Download", "icon": "$(cloud-download)" },
{ "command": "jumpserverManager.sftp.delete", "title": "JumpServer Files: Delete", "icon": "$(trash)" },
{ "command": "jumpserverManager.sftp.rename", "title": "JumpServer Files: Rename", "icon": "$(edit)" },
{ "command": "jumpserverManager.sftp.newFolder", "title": "JumpServer Files: New Folder", "icon": "$(new-folder)" },
{ "command": "jumpserverManager.sftp.copyPath", "title": "JumpServer Files: Copy Path", "icon": "$(copy)" }
```

Add menus:

```json
"view/title": [
  { "command": "jumpserverManager.sftp.refresh", "when": "view == jumpserverManager.sftpFiles", "group": "navigation@1" },
  { "command": "jumpserverManager.sftp.upload", "when": "view == jumpserverManager.sftpFiles", "group": "navigation@2" },
  { "command": "jumpserverManager.sftp.goUp", "when": "view == jumpserverManager.sftpFiles", "group": "navigation@3" }
],
"view/item/context": [
  { "command": "jumpserverManager.sftp.open", "when": "view == jumpserverManager.assets && (viewItem == jumpserverAsset || viewItem == jumpserverUnsupportedAsset)", "group": "inline@2" },
  { "command": "jumpserverManager.sftp.download", "when": "view == jumpserverManager.sftpFiles && viewItem == jumpserverSftpFile", "group": "inline@1" },
  { "command": "jumpserverManager.sftp.upload", "when": "view == jumpserverManager.sftpFiles && viewItem == jumpserverSftpDirectory", "group": "inline@1" },
  { "command": "jumpserverManager.sftp.newFolder", "when": "view == jumpserverManager.sftpFiles && (viewItem == jumpserverSftpDirectory || viewItem == jumpserverSftpPlaceholder)", "group": "inline@2" },
  { "command": "jumpserverManager.sftp.rename", "when": "view == jumpserverManager.sftpFiles && (viewItem == jumpserverSftpDirectory || viewItem == jumpserverSftpFile)", "group": "inline@3" },
  { "command": "jumpserverManager.sftp.delete", "when": "view == jumpserverManager.sftpFiles && (viewItem == jumpserverSftpDirectory || viewItem == jumpserverSftpFile)", "group": "inline@4" },
  { "command": "jumpserverManager.sftp.copyPath", "when": "view == jumpserverManager.sftpFiles && (viewItem == jumpserverSftpDirectory || viewItem == jumpserverSftpFile)", "group": "inline@5" }
]
```

Merge these entries into existing `menus` arrays; do not remove existing terminal commands.

- [ ] **Step 5: Wire extension**

Modify `src/extension.ts` imports:

```ts
import { JumpServerSftpManager } from './sftp/JumpServerSftpManager';
import { JumpServerSftpSession } from './sftp/JumpServerSftpSession';
import { joinRemotePath, dirname } from './sftp/RemotePath';
import { VscodeTransferReporter } from './sftp/VscodeTransferReporter';
import { SftpTreeProvider } from './tree/SftpTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from './tree/SftpTreeItems';
```

Inside `activate`, create manager and tree provider:

```ts
const createSftpSession = async (asset: CachedJumpServerAsset): Promise<JumpServerSftpSession> => {
  const client = await createClient(configManager);
  return new JumpServerSftpSession({ asset, client });
};

const sftpManager = new JumpServerSftpManager({
  createSession: createSftpSession,
  reporter: new VscodeTransferReporter()
});
const sftpTreeProvider = new SftpTreeProvider({
  getState: () => sftpManager.getState(),
  listDirectory: (path) => sftpManager.listDirectory(path)
});
```

Register the Files tree:

```ts
vscode.window.createTreeView('jumpserverManager.sftpFiles', {
  treeDataProvider: sftpTreeProvider,
  showCollapseAll: true
})
```

Register commands with this behavior:

```ts
vscode.commands.registerCommand('jumpserverManager.sftp.open', async (item?: AssetTreeItem) => {
  if (!item) return;
  await runCommand(async () => {
    if (!item.asset.protocolNames.map((name) => name.toLowerCase()).includes('sftp')) {
      await showTimedNotification(`Asset does not support SFTP: ${item.asset.name}`, 'error');
      return;
    }
    await sftpManager.openAsset(item.asset);
    sftpTreeProvider.refresh();
  });
});
```

For upload/download/new folder/rename/delete/copy path, follow this exact mapping:

```ts
vscode.commands.registerCommand('jumpserverManager.sftp.refresh', () => sftpTreeProvider.refresh());
vscode.commands.registerCommand('jumpserverManager.sftp.goUp', async () => {
  await runCommand(async () => {
    await sftpManager.changeToParentDirectory();
    sftpTreeProvider.refresh();
  });
});
vscode.commands.registerCommand('jumpserverManager.sftp.goToPath', async () => {
  await runCommand(async () => {
    const state = sftpManager.getState();
    const nextPath = await vscode.window.showInputBox({ prompt: 'Remote path', value: state.kind === 'active' ? state.rootPath : '/' });
    if (!nextPath?.trim()) return;
    await sftpManager.changeDirectory(nextPath.trim());
    sftpTreeProvider.refresh();
  });
});
```

Use `vscode.window.showOpenDialog`, `showSaveDialog`, `showInputBox`, and confirmation via `showWarningMessage` for the remaining operations. Use `dirname` and `joinRemotePath` to choose target paths.

- [ ] **Step 6: Run tests to verify pass**

Run: `npm test -- test/extension/ExtensionCommands.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add package.json src\extension.ts test-fixtures\vscode.ts test\extension\ExtensionCommands.test.ts
git commit -m "feat: wire JumpServer SFTP commands"
```

---

### Task 8: Manifest Tests And README

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\test\package.manifest.test.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\README.md`

- [ ] **Step 1: Update package manifest tests**

Change the test name from:

```ts
it('declares a standalone JumpServer terminal extension without SSH/SFTP/MCP commands', () => {
```

to:

```ts
it('declares JumpServer terminal and first-phase SFTP file commands without MCP commands', () => {
```

Replace:

```ts
expect(JSON.stringify(manifest)).not.toContain('sftp');
```

with:

```ts
expect(manifest.contributes.views.jumpserverManager).toEqual(expect.arrayContaining([
  expect.objectContaining({ id: 'jumpserverManager.sftpFiles', name: 'Files' })
]));
expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
  expect.objectContaining({ command: 'jumpserverManager.sftp.open' }),
  expect.objectContaining({ command: 'jumpserverManager.sftp.upload' }),
  expect.objectContaining({ command: 'jumpserverManager.sftp.download' })
]));
expect(JSON.stringify(manifest)).not.toContain('mcp');
```

- [ ] **Step 2: Update README**

In `README.md`, move SFTP from unsupported to supported:

```md
- SFTP file tree for permitted assets
- SFTP upload, download, new folder, rename, delete, copy path, and path navigation through JumpServer KoKo
```

Keep remote editing unsupported:

```md
- Remote file editing and save-to-upload sync
```

Add manual SFTP verification:

```md
- Open files for an SFTP-capable SSH asset.
- Navigate into a directory and back up.
- Upload a small text file.
- Download the file and compare content.
- Rename and delete the test file.
- Create and delete a test directory.
- Verify an asset without SFTP shows a clear unsupported message.
```

Add a development probe note:

```md
Before changing the SFTP implementation, validate a real JumpServer instance with `npm run probe:sftp`. The probe reads `JUMPSERVER_BASE_URL`, `JUMPSERVER_USERNAME`, `JUMPSERVER_PASSWORD`, and `JUMPSERVER_ASSET_ID` from the environment.
```

- [ ] **Step 3: Run tests**

Run: `npm test -- test/package.manifest.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```powershell
git add test\package.manifest.test.ts README.md
git commit -m "docs: document JumpServer SFTP file management"
```

---

### Task 9: Full Verification

**Files:**
- No file edits expected.

- [ ] **Step 1: Run focused SFTP tests**

Run:

```powershell
npm test -- test/jumpserver/JumpServerClient.test.ts test/sftp/RemotePath.test.ts test/sftp/SftpProtocol.test.ts test/sftp/JumpServerSftpSession.test.ts test/sftp/JumpServerSftpManager.test.ts test/tree/SftpTreeProvider.test.ts test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Re-run real probe**

Run: `npm run probe:sftp` with the same real environment from Task 1.

Expected: PASS and list output.

- [ ] **Step 6: Manual VS Code verification**

Use an Extension Development Host and verify:

- Configure a real JumpServer account.
- Validate account.
- Refresh assets.
- Open files for an SFTP-capable asset.
- List root/current directory.
- Go to a typed path.
- Go up.
- Upload a small file.
- Download the uploaded file.
- Rename the uploaded file.
- Delete the uploaded file.
- Create and delete a folder.
- Try an asset without SFTP and confirm the error message.
- Open SSH and MySQL terminals to confirm they still work.

- [ ] **Step 7: Final commit if verification required small fixes**

If verification required fixes, commit them:

```powershell
git add <changed-files>
git commit -m "fix: stabilize JumpServer SFTP file management"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: probe gate, SFTP client helpers, session, manager, tree view, commands, manifest, README, tests, and phase-two reserved interfaces are covered.
- Placeholder scan: no unresolved marker tokens are intentionally present in implementation tasks.
- Type consistency: the core entry type is `JumpServerSftpEntry`; the session interface exposes `stat`, `readFile`, `writeFile`, and `createFile` for phase two; phase-one commands use `listDirectory`, `uploadBytes`, `downloadFile`, `mkdir`, `rename`, and `deleteEntry`.
- Risk: the real JumpServer instance may accept a different SFTP connection-token payload than the current probe-confirmed default. Task 1 is deliberately a hard gate so the implementation follows observed behavior.
