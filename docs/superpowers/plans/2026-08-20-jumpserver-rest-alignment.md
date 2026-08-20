# JumpServer REST Client Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `at-jumpserver-series` REST calls with official [jumpserver/skills](https://github.com/jumpserver/skills) contracts (401 vs 403, org as a required scope, API error bodies, Date header, DRF `next`, listing query params, 429 backoff) without changing KoKo sessions or switching to admin asset APIs.

**Architecture:** Keep `JumpServerClient` as the HTTP/KoKo facade. Extract three focused modules: `apiError.ts` (status classification + structured errors), `orgs.ts` / `orgContext.ts` (org IDs, list/current, reserved auto-select), and `pagination.ts` (page signature, `next` rewrite, throttle wait). Validate/Refresh in `extension.ts` become the only UI entry that may persist a chosen org. Self-permission endpoints, cookie warmup, and parallel offset paging stay.

**Tech Stack:** TypeScript, Node `fetch`-compatible `restTransport`, Vitest, VS Code `window.showQuickPick`, `vscode.l10n` via `t()`.

**Branch:** `feat/jumpserver-rest-alignment` (do not implement until the user confirms this plan).

---

## Spec (locked for this branch)

### In scope

1. Treat HTTP 401 as expired Bearer (refresh once). Treat HTTP 403 as forbidden / wrong org (do not re-login).
2. Parse JSON/text error bodies (`detail`, `msg`, `error`, `message`) into `JumpServerApiError`. Keep pathname-only routes in logs; never put query strings (connection tokens) in messages.
3. Send RFC 1123 GMT `Date` on every REST request the client prepares (needed later for HMAC; harmless on Bearer).
4. Org is a first-class scope: `GET /api/v1/orgs/orgs/`, `GET /api/v1/orgs/orgs/current/`, reserved UUIDs from official skills. Empty `orgId` + multiple accessible orgs blocks business calls until the user picks one (QuickPick). Auto-write Default `...0002` only when the accessible set is exactly `{0002}` or `{0002,0004}`.
5. Asset listing: add `all=1&display=1`; follow DRF `next` with same-host rewrite; keep count-based parallel offset when `next` is absent; keep `MAX_SYNCED_ASSETS` and concurrency 4; detect identical list pages to stop loops.
6. Retry listing pages on HTTP 429 using `Expected available in N second` (default 5s, max 3 attempts).
7. Validate: `GET /api/health/` (404 = skip), then auth + profile, then org context. Show the effective org name on success.

### Out of scope (do not implement on this branch)

- Access Key HMAC / private token / SSO / MFA.
- Switching asset inventory to `/api/v1/assets/assets/` or `/perms/users/{id}/assets/` (admin/other-user APIs).
- Changing `verifyTls` default away from `true`.
- Changing default page size from 200 to 100.
- Form-urlencoded password auth (JSON POST stays).
- KoKo connect warmup, cookies, WebSocket.
- Config webview org dropdown (QuickPick is enough).
- Version bump / CHANGELOG / marketplace release notes (do those only if the user asks to release).

### Official constants (copy exactly)

```ts
export const GLOBAL_ORG_ID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000002';
export const RESERVED_INTERNAL_ORG_ID = '00000000-0000-0000-0000-000000000004';
```

---

## File Map

| File | Responsibility |
|---|---|
| Create `src/jumpserver/apiError.ts` | `classifyRestFailure`, `JumpServerApiError`, payload message extraction |
| Create `src/jumpserver/orgs.ts` | Org UUID constants, `JumpServerOrg` type, reserved-set helper |
| Create `src/jumpserver/orgContext.ts` | Pure `resolveOrgContext` from listed orgs + saved `orgId` |
| Create `src/jumpserver/pagination.ts` | Page SHA-1 signature, `next` rewrite, throttle wait, asset list path |
| Create `test/jumpserver/apiError.test.ts` | Error class + classification |
| Create `test/jumpserver/orgContext.test.ts` | Reserved auto-select and selection-required |
| Create `test/jumpserver/pagination.test.ts` | Path, rewrite, loop signature, 429 wait |
| Modify `src/jumpserver/JumpServerClient.ts` | Use new modules; 401-only refresh; Date header; org/health APIs; listing |
| Modify `src/utils/errors.ts` | No change unless `JumpServerApiError` should live here — it extends `UserVisibleError` from this file |
| Modify `src/extension.ts` | Validate/refresh org resolution + QuickPick + persist |
| Modify `test/jumpserver/JumpServerClient.test.ts` | 403, Date, health, orgs, `next`, query params |
| Modify `test/jumpserver/JumpServerClientLogging.test.ts` | 403 is `forbidden`; error log still pathname-only |
| Modify `test/extension/ExtensionCommands.test.ts` | Validate/refresh org flow |
| Modify `test-fixtures/vscode.ts` | `window.showQuickPick` |
| Modify `l10n/bundle.l10n.zh-cn.json` | Every new `t('...')` source string |
| Modify `README.md` | Org is no longer a silent optional field |

`JumpServerClient.ts` stays the facade. Do not move KoKo or cookie code.

---

### Task 1: Structured REST errors and 403 ≠ 401

**Files:**
- Create: `src/jumpserver/apiError.ts`
- Create: `test/jumpserver/apiError.test.ts`
- Modify: `src/jumpserver/JumpServerClient.ts` (`classifyRestFailure` currently ~62–79)
- Modify: `test/jumpserver/JumpServerClientLogging.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/jumpserver/apiError.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  JumpServerApiError,
  apiErrorMessageFromPayload,
  classifyRestFailure
} from '../../src/jumpserver/apiError';

describe('classifyRestFailure', () => {
  it('treats 401 as expired credentials and 403 as forbidden', () => {
    expect(classifyRestFailure(401)).toBe('auth-rejected');
    expect(classifyRestFailure(403)).toBe('forbidden');
    expect(classifyRestFailure(404)).toBe('not-found');
    expect(classifyRestFailure(429)).toBe('throttled');
    expect(classifyRestFailure(502)).toBe('server-error');
    expect(classifyRestFailure(418)).toBe('client-error');
  });
});

describe('apiErrorMessageFromPayload', () => {
  it('prefers detail, then msg, error, message', () => {
    expect(apiErrorMessageFromPayload({ detail: 'token expired' }, 'fallback')).toBe('token expired');
    expect(apiErrorMessageFromPayload({ msg: 'nope' }, 'fallback')).toBe('nope');
    expect(apiErrorMessageFromPayload('plain', 'fallback')).toBe('plain');
    expect(apiErrorMessageFromPayload(null, 'fallback')).toBe('fallback');
  });
});

describe('JumpServerApiError', () => {
  it('keeps HTTP status in the user message and omits query strings from path', () => {
    const error = new JumpServerApiError('token expired', {
      statusCode: 401,
      method: 'GET',
      path: '/api/v1/users/profile/',
      reason: 'auth-rejected'
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).toContain('token expired');
    expect(error.path).toBe('/api/v1/users/profile/');
    expect(error.reason).toBe('auth-rejected');
  });
});
```

In `test/jumpserver/JumpServerClientLogging.test.ts`, change the 403 expectation:

```ts
expect(classifyRestFailure(403)).toBe('forbidden');
```

Import `classifyRestFailure` from `../../src/jumpserver/apiError` (or keep a re-export from `JumpServerClient` — pick one import site and use it in both tests).

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/jumpserver/apiError.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: FAIL because `src/jumpserver/apiError.ts` does not exist, and logging still expects `auth-rejected` for 403.

- [ ] **Step 3: Implement `apiError.ts` and switch classification**

`src/jumpserver/apiError.ts`:

```ts
import { UserVisibleError } from '../utils/errors';

export type JumpServerFailureClass =
  | 'auth-rejected'
  | 'forbidden'
  | 'not-found'
  | 'throttled'
  | 'server-error'
  | 'client-error'
  | 'unexpected-status';

export function classifyRestFailure(status: number): JumpServerFailureClass {
  if (status === 401) {
    return 'auth-rejected';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 408 || status === 429) {
    return 'throttled';
  }
  if (status >= 500) {
    return 'server-error';
  }
  if (status >= 400) {
    return 'client-error';
  }
  return 'unexpected-status';
}

export function apiErrorMessageFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['detail', 'msg', 'error', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

export class JumpServerApiError extends UserVisibleError {
  readonly statusCode?: number;
  readonly method?: string;
  readonly path?: string;
  readonly reason: JumpServerFailureClass;
  readonly details?: unknown;

  constructor(
    detail: string,
    input: {
      statusCode?: number;
      method?: string;
      path?: string;
      reason: JumpServerFailureClass;
      details?: unknown;
    }
  ) {
    const statusPart = input.statusCode !== undefined ? `HTTP ${input.statusCode}` : 'request failed';
    super(`JumpServer request failed with ${statusPart}: ${detail}`);
    this.name = 'JumpServerApiError';
    this.statusCode = input.statusCode;
    this.method = input.method;
    this.path = input.path;
    this.reason = input.reason;
    this.details = input.details;
  }
}
```

In `JumpServerClient.ts`: delete the local `classifyRestFailure` function body and re-export:

```ts
export { classifyRestFailure, JumpServerApiError } from './apiError';
```

Keep the existing comment that `"HTTP 502" in a log line tells a user nothing` above the re-export, or move that comment onto `apiError.ts`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/apiError.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: PASS. Existing logging test that throws `/HTTP 503/` still passes because `JumpServerApiError` includes that substring — **do not change `requireOkResponse` in this task**.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/apiError.ts src/jumpserver/JumpServerClient.ts \
  test/jumpserver/apiError.test.ts test/jumpserver/JumpServerClientLogging.test.ts
git commit -m "$(cat <<'EOF'
fix: classify JumpServer 403 as forbidden, not expired auth

EOF
)"
```

---

### Task 2: Parse error bodies and send Date

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`requireOkResponse` ~852–861, `withRestHeaders` / `restHeaders` ~787–870, auth failure path ~518–532)
- Modify: `test/jumpserver/JumpServerClient.test.ts`
- Modify: `test/jumpserver/JumpServerClientLogging.test.ts` if the thrown message gains a `detail` suffix (keep `/HTTP 503/` matching)

- [ ] **Step 1: Write failing tests**

Add to `describe('JumpServerClient REST flow')` in `test/jumpserver/JumpServerClient.test.ts`:

```ts
it('surfaces the JumpServer detail field instead of a bare status', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ detail: 'You do not have permission to perform this action.' }, { status: 403 }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: 'org-1',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await expect(client.getAssetDetail('asset-1')).rejects.toThrow(
    /You do not have permission to perform this action/
  );
  await expect(client.getAssetDetail('asset-1')).rejects.toBeInstanceOf(JumpServerApiError);
});

it('sends an RFC 1123 Date header on REST calls', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await client.getUserProfile();

  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'https://jumpserver.example.com/api/v1/users/profile/',
    expect.objectContaining({
      headers: expect.objectContaining({
        Date: expect.stringMatching(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
      })
    })
  );
});
```

Import `JumpServerApiError` in that test file.

Note: `getAssetDetail` is called twice in the first test if you copy it verbatim — write it as a single `rejects` plus `await client.getAssetDetail(...).catch(err => err)` or use `expect(promise).rejects.toMatchObject`. Prefer:

```ts
const error = await client.getAssetDetail('asset-1').catch((caught: unknown) => caught);
expect(error).toBeInstanceOf(JumpServerApiError);
expect(String(error)).toMatch(/You do not have permission to perform this action/);
expect((error as JumpServerApiError).reason).toBe('forbidden');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL — current `requireOkResponse` throws `JumpServer request failed with HTTP 403.` with no detail, and no `Date` header.

- [ ] **Step 3: Implement header + error decode**

Add a helper in `JumpServerClient.ts` (or `apiError.ts`):

```ts
export function rfc1123Date(now = new Date()): string {
  return now.toUTCString().replace(/UTC$/, 'GMT');
}
```

`Date.prototype.toUTCString()` already ends with `GMT` in Node. Use that directly if tests pass; do not invent a custom formatter unless Node's output fails the regex.

In `restHeaders()` / `withRestHeaders()`, always set:

```ts
Date: rfc1123Date()
```

Add `private async readErrorPayload(response: Response): Promise<unknown>` that clones or reads `response.text()` then `JSON.parse` when possible (the body can only be read once — `requireOkResponse` currently does not read it). Change `requireOkResponse` to async:

```ts
private async requireOkResponse(response: Response, pathOrUrl: string, method = 'GET'): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const payload = await this.readErrorPayload(response);
  const route = logRoute(resolveJumpServerUrl(this.settings.baseUrl, pathOrUrl));
  const reason = classifyRestFailure(response.status);
  const detail = apiErrorMessageFromPayload(payload, `HTTP ${response.status}`);
  log.warn(`REST ${reason} (HTTP ${response.status}): ${route}`);
  throw new JumpServerApiError(detail, {
    statusCode: response.status,
    method,
    path: route,
    reason,
    details: payload
  });
}
```

Update every `return this.requireOkResponse(...)` to `return await this.requireOkResponse(...)`.

Do the same for failed auth in `ensureAuthToken` when `!response.ok` or missing `token` (use `apiErrorMessageFromPayload`).

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: PASS. Logging still contains `warn REST server-error (HTTP 503): /api/v1/perms/users/self/assets/asset-1/`. Thrown error may now also include `nope` from the 503 fixture — that is fine.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/JumpServerClient.ts src/jumpserver/apiError.ts \
  test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts
git commit -m "$(cat <<'EOF'
fix: parse JumpServer error bodies and send Date on REST calls

EOF
)"
```

---

### Task 3: Refresh Bearer only on 401

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`isUnauthorizedResponse` ~920–922, `authenticatedRequest` ~836–850)
- Modify: `test/jumpserver/JumpServerClient.test.ts` (existing 401 refresh test ~829)

- [ ] **Step 1: Write the failing 403 test**

Next to the existing `'refreshes an expired Bearer token once when a REST request returns unauthorized'` test:

```ts
it('does not treat HTTP 403 as an expired Bearer token', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ detail: 'forbidden' }, { status: 403 }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: 'wrong-org',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await expect(client.listAssetNodes()).rejects.toMatchObject({ reason: 'forbidden', statusCode: 403 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL — `isUnauthorizedResponse` treats 403 as refresh, so a third auth POST happens.

- [ ] **Step 3: Change unauthorized detection**

```ts
function isUnauthorizedResponse(response: Response): boolean {
  return response.status === 401;
}
```

Do not refresh on 403.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: PASS. The existing 401 refresh test still logs in twice.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/JumpServerClient.ts test/jumpserver/JumpServerClient.test.ts
git commit -m "$(cat <<'EOF'
fix: refresh JumpServer Bearer tokens only after HTTP 401

EOF
)"
```

---

### Task 4: Pagination helpers (path, next rewrite, loop, 429 wait)

**Files:**
- Create: `src/jumpserver/pagination.ts`
- Create: `test/jumpserver/pagination.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSelfAssetListPath,
  pageSignature,
  rewritePaginationRef,
  throttleWaitMs
} from '../../src/jumpserver/pagination';

describe('buildSelfAssetListPath', () => {
  it('asks JumpServer for the full effective asset list like the official skill', () => {
    expect(buildSelfAssetListPath(200, 0)).toBe(
      '/api/v1/perms/users/self/assets/?all=1&display=1&limit=200&offset=0'
    );
  });
});

describe('rewritePaginationRef', () => {
  it('rewrites a DRF next URL onto the configured origin', () => {
    expect(
      rewritePaginationRef(
        'https://jumpserver.example.com',
        'https://internal.example.com/api/v1/perms/users/self/assets/?all=1&limit=200&offset=200'
      )
    ).toBe('https://jumpserver.example.com/api/v1/perms/users/self/assets/?all=1&limit=200&offset=200');
  });

  it('keeps same-origin next URLs and relative paths', () => {
    expect(
      rewritePaginationRef(
        'https://jumpserver.example.com',
        '/api/v1/perms/users/self/assets/?offset=200'
      )
    ).toBe('https://jumpserver.example.com/api/v1/perms/users/self/assets/?offset=200');
  });
});

describe('pageSignature', () => {
  it('is stable for the same records and changes when an id changes', () => {
    const first = pageSignature([{ id: 'a' }, { id: 'b' }]);
    const second = pageSignature([{ id: 'a' }, { id: 'b' }]);
    const third = pageSignature([{ id: 'a' }, { id: 'c' }]);
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toBe(createHash('sha1').update(JSON.stringify([{ id: 'a' }, { id: 'b' }])).digest('hex'));
  });
});

describe('throttleWaitMs', () => {
  it('reads JumpServer retry hints and falls back to 5 seconds', () => {
    expect(throttleWaitMs('Expected available in 9 seconds.')).toBe(9000);
    expect(throttleWaitMs('slow down', { detail: 'Expected available in 3 second' })).toBe(3000);
    expect(throttleWaitMs('nope')).toBe(5000);
  });
});
```

`pageSignature` in production should `JSON.stringify(records, Object.keys(...))` only if needed. Official skills use `json.dumps(..., sort_keys=True)`. In Node, stringify does not sort keys. For tests, pass already-sorted plain objects as above so `JSON.stringify(records)` is deterministic. Document that the loop detector only needs stability for identical arrays, not canonicalization across key order.

- [ ] **Step 2: Run test to verify RED**

Run: `npm test -- test/jumpserver/pagination.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `pagination.ts`**

```ts
import { createHash } from 'node:crypto';
import { buildOrigin } from './JumpServerClient';
```

Avoid a circular import: `buildOrigin` lives in `JumpServerClient.ts`. Either:

- Duplicate the one-liner `new URL(baseUrl)` origin in `pagination.ts`, or
- Move `buildOrigin` to `src/jumpserver/urls.ts` in this task.

**Required:** move `buildOrigin` (and only that helper, plus `resolveJumpServerUrl` if you touch it) to `src/jumpserver/urls.ts` and re-export from `JumpServerClient.ts` so `pagination.ts` does not import the client class file.

```ts
// src/jumpserver/urls.ts
export function buildOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export function rewritePaginationRef(baseUrl: string, nextRef: string): string {
  const origin = buildOrigin(baseUrl);
  const absolute = nextRef.startsWith('http://') || nextRef.startsWith('https://')
    ? nextRef
    : `${origin}${nextRef.startsWith('/') ? '' : '/'}${nextRef}`;
  const parsed = new URL(absolute);
  parsed.protocol = new URL(origin).protocol;
  parsed.host = new URL(origin).host;
  return parsed.toString();
}
```

`buildSelfAssetListPath`:

```ts
export function buildSelfAssetListPath(limit: number, offset: number): string {
  const params = new URLSearchParams({
    all: '1',
    display: '1',
    limit: String(limit),
    offset: String(offset)
  });
  return `/api/v1/perms/users/self/assets/?${params.toString()}`;
}
```

`pageSignature`:

```ts
export function pageSignature(records: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(records)).digest('hex');
}
```

`throttleWaitMs`:

```ts
const WAIT_RE = /Expected available in (\d+) second/i;

export function throttleWaitMs(message: string, details?: unknown): number {
  const extra = details && typeof details === 'object' && 'detail' in details
    ? String((details as { detail?: unknown }).detail ?? '')
    : '';
  const match = WAIT_RE.exec(`${message} ${extra}`);
  if (!match) {
    return 5_000;
  }
  return Math.max(Number(match[1]), 1) * 1_000;
}
```

Re-export `buildOrigin` from `JumpServerClient.ts` so existing tests that import it from there keep compiling:

```ts
export { buildOrigin } from './urls';
```

Remove the original `buildOrigin` function from `JumpServerClient.ts`. Keep `resolveJumpServerUrl` in the client file **or** move it to `urls.ts` too if that is less churn — existing tests import it from `JumpServerClient`. Re-export whichever file owns it.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/pagination.test.ts test/jumpserver/JumpServerClient.test.ts`

Expected: PASS. URL helper move must not break `resolveJumpServerUrl` tests.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/pagination.ts src/jumpserver/urls.ts src/jumpserver/JumpServerClient.ts \
  test/jumpserver/pagination.test.ts test/jumpserver/JumpServerClient.test.ts
git commit -m "$(cat <<'EOF'
feat: add JumpServer pagination and Date-compatible URL helpers

EOF
)"
```

---

### Task 5: Wire listing to `all=1`, `next`, loop detection, 429 retry

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts` (`fetchAssetPage`, `listAllAssets`, `listAssets`)
- Modify: `test/jumpserver/JumpServerClient.test.ts` (paged URL assertions)

- [ ] **Step 1: Update existing URL assertions (they will go RED)**

Every expected asset list URL of the form:

```
https://jumpserver.example.com/api/v1/perms/users/self/assets/?limit=200&offset=0
```

becomes:

```
https://jumpserver.example.com/api/v1/perms/users/self/assets/?all=1&display=1&limit=200&offset=0
```

Use `buildSelfAssetListPath` in tests if that is less brittle.

Add new tests:

```ts
it('follows a DRF next link rewritten onto the configured origin', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({
      count: 2,
      next: 'https://internal.example.com/api/v1/perms/users/self/assets/?all=1&display=1&limit=1&offset=1',
      results: [{ id: 'asset-0', name: 'a' }]
    }))
    .mockResolvedValueOnce(jsonResponse({
      count: 2,
      next: null,
      results: [{ id: 'asset-1', name: 'b' }]
    }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  const inventory = await client.listAllAssets({ pageSize: 1, treePaths: new Map() });

  expect(inventory.assets.map((asset) => asset.id)).toEqual(['asset-0', 'asset-1']);
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    'https://jumpserver.example.com/api/v1/perms/users/self/assets/?all=1&display=1&limit=1&offset=1',
    expect.any(Object)
  );
});

it('stops when JumpServer repeats the same list page', async () => {
  const page = [{ id: 'asset-0', name: 'a' }];
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValue(jsonResponse(page));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  const inventory = await client.listAllAssets({ pageSize: 1, maxAssets: 50, treePaths: new Map() });

  expect(inventory.assets).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/self/assets/')).length).toBeLessThan(5);
});

it('retries a throttled asset page using the JumpServer wait hint', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ detail: 'Expected available in 0 second' }, { status: 429 }))
    .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'asset-0', name: 'a' }], count: 1 }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  const inventory = await client.listAllAssets({ pageSize: 200, treePaths: new Map() });

  expect(inventory.assets).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/self/assets/')).length).toBe(2);
});
```

**Required implementation:** `fetchAssetPage` retries throttled pages using an injectable sleeper. Extend the existing third constructor argument (today `Partial<JumpServerTimeouts>`) to:

```ts
options: Partial<JumpServerTimeouts> & { sleep?: (ms: number) => Promise<void> } = {}
```

Default `sleep` is `(ms) => new Promise((resolve) => setTimeout(resolve, ms))`. The 429 test passes `{ sleep: async () => undefined }`. Existing tests that pass `{ requestMs, listingMs }` stay valid.

Keep `Math.max(n, 1)` in `throttleWaitMs` so a real 0-second hint still yields 1s; the no-op sleeper keeps the unit test fast.

When `next` is present, **do not** also fan out parallel offsets for that listing (would duplicate rows). Parallel offset remains the path when the first page has `count` and no `next`.

Loop detection: if a page's `pageSignature(records)` was already seen, stop paging.

`LISTING_RETRY_LIMIT = 3` (initial try + 2 retries).

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL on old query strings and missing `next` follow.

- [ ] **Step 3: Implement listing**

`fetchAssetPage` uses `buildSelfAssetListPath`. On `JumpServerApiError` with `reason === 'throttled'`, sleep `throttleWaitMs(error.message, error.details)` and retry.

`listAllAssets`:

1. Auth once, fetch first page + tree paths in parallel (unchanged).
2. If first payload had `next` (store it on the page result), walk `next` sequentially with rewrite + signature set + maxAssets cap.
3. Else keep today's count-based parallel offsets / short-page walk.
4. Dedupe by id (already present).

`listAssets` (single page) must use the same path builder so one-page callers also send `all=1&display=1`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerClientLogging.test.ts`

Expected: PASS. Logging page-count test still walks 3 pages of size 2.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/JumpServerClient.ts test/jumpserver/JumpServerClient.test.ts
git commit -m "$(cat <<'EOF'
feat: follow JumpServer asset next links and retry throttled pages

EOF
)"
```

---

### Task 6: Org constants, list/current, health

**Files:**
- Create: `src/jumpserver/orgs.ts`
- Create: `src/jumpserver/orgContext.ts`
- Create: `test/jumpserver/orgContext.test.ts`
- Modify: `src/jumpserver/JumpServerClient.ts`
- Modify: `test/jumpserver/JumpServerClient.test.ts`

- [ ] **Step 1: Write failing tests**

`test/jumpserver/orgContext.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_ID, RESERVED_INTERNAL_ORG_ID } from '../../src/jumpserver/orgs';
import { resolveOrgContext } from '../../src/jumpserver/orgContext';

const defaultOrg = { id: DEFAULT_ORG_ID, name: 'Default' };
const internal = { id: RESERVED_INTERNAL_ORG_ID, name: 'Internal' };
const prod = { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' };

describe('resolveOrgContext', () => {
  it('uses a saved org when it is still accessible', () => {
    const context = resolveOrgContext({
      savedOrgId: prod.id,
      accessibleOrgs: [defaultOrg, prod]
    });
    expect(context.selectionRequired).toBe(false);
    expect(context.effectiveOrg).toMatchObject({ id: prod.id, source: 'env' });
    expect(context.reservedAutoSelectEligible).toBe(false);
  });

  it('auto-selects Default when only reserved orgs are visible', () => {
    expect(
      resolveOrgContext({ savedOrgId: '', accessibleOrgs: [defaultOrg] }).effectiveOrg
    ).toMatchObject({ id: DEFAULT_ORG_ID, source: 'reserved_auto_select' });
    expect(
      resolveOrgContext({ savedOrgId: '', accessibleOrgs: [defaultOrg, internal] }).effectiveOrg
    ).toMatchObject({ id: DEFAULT_ORG_ID, source: 'reserved_auto_select' });
  });

  it('requires a choice when several real orgs exist and none is saved', () => {
    const context = resolveOrgContext({
      savedOrgId: '',
      accessibleOrgs: [defaultOrg, prod]
    });
    expect(context.selectionRequired).toBe(true);
    expect(context.effectiveOrg).toBeUndefined();
    expect(context.candidateOrgs).toHaveLength(2);
  });

  it('requires a new choice when the saved org disappeared', () => {
    const context = resolveOrgContext({
      savedOrgId: prod.id,
      accessibleOrgs: [defaultOrg]
    });
    expect(context.selectionRequired).toBe(true);
    expect(context.selectedOrgAccessible).toBe(false);
  });
});
```

Import org UUID constants from `orgs.ts` only. Do not re-export them from the test file.

Client tests:

```ts
it('reads health, orgs, and the current org', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ results: [{ id: DEFAULT_ORG_ID, name: 'Default' }] }))
    .mockResolvedValueOnce(jsonResponse({ id: DEFAULT_ORG_ID, name: 'Default' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await expect(client.healthCheck()).resolves.toEqual({ status: 'ok' });
  const orgs = await client.listAccessibleOrgs();
  expect(orgs).toEqual([{ id: DEFAULT_ORG_ID, name: 'Default' }]);
  await expect(client.getCurrentOrg()).resolves.toMatchObject({ id: DEFAULT_ORG_ID });
  expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://jumpserver.example.com/api/health/', expect.any(Object));
  expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/api/v1/orgs/orgs/', expect.any(Object));
  expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://jumpserver.example.com/api/v1/orgs/orgs/current/', expect.any(Object));
});

it('treats a missing health endpoint as optional', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);

  await expect(client.healthCheck()).resolves.toEqual({ skipped: true });
});
```

`listAccessibleOrgs` should use `list_paginated` behavior already in `listAllAssets` **or** a small `listPaginated(path)` private method. Official follows `next` on `/api/v1/orgs/orgs/`. Reuse page walking: if the body is `{ results, next }`, follow `next`; if `{ results, count }`, offset; if array, return it. Keep this modest: one helper `private async getPaginated(path: string): Promise<unknown[]>` used by orgs (and not yet by assets, to avoid a risky rewrite of Task 5). Assets already have their own walker.

If org list is a bare array, return it. Normalize each item to `{ id: string, name: string }` skipping entries without `id`.

`healthCheck` uses `request('/api/health/', ..., false)` so 404 is not thrown; do **not** send Bearer if the token is empty (health runs before login). Skip cookies-only is fine.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/jumpserver/orgContext.test.ts test/jumpserver/JumpServerClient.test.ts`

Expected: FAIL — new modules/methods missing.

- [ ] **Step 3: Implement**

`src/jumpserver/orgs.ts`:

```ts
export const GLOBAL_ORG_ID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000002';
export const RESERVED_INTERNAL_ORG_ID = '00000000-0000-0000-0000-000000000004';

export interface JumpServerOrg {
  id: string;
  name: string;
  source?: 'api' | 'env' | 'reserved_auto_select';
}

export function isReservedAutoSelectSet(ids: Iterable<string>): boolean {
  const set = new Set([...ids].filter(Boolean));
  if (set.size === 1 && set.has(DEFAULT_ORG_ID)) {
    return true;
  }
  return set.size === 2 && set.has(DEFAULT_ORG_ID) && set.has(RESERVED_INTERNAL_ORG_ID);
}
```

`src/jumpserver/orgContext.ts`:

```ts
import {
  DEFAULT_ORG_ID,
  isReservedAutoSelectSet,
  type JumpServerOrg
} from './orgs';

export interface OrgContext {
  accessibleOrgs: JumpServerOrg[];
  candidateOrgs: JumpServerOrg[];
  effectiveOrg?: JumpServerOrg;
  selectionRequired: boolean;
  reservedAutoSelectEligible: boolean;
  selectedOrgAccessible: boolean;
}

export function resolveOrgContext(input: {
  savedOrgId: string;
  accessibleOrgs: JumpServerOrg[];
}): OrgContext {
  const accessibleOrgs = input.accessibleOrgs;
  const byId = new Map(accessibleOrgs.map((org) => [org.id, org]));
  const reservedAutoSelectEligible = isReservedAutoSelectSet(accessibleOrgs.map((org) => org.id));
  const saved = input.savedOrgId.trim();
  const selected = saved ? byId.get(saved) : undefined;
  if (selected) {
    return {
      accessibleOrgs,
      candidateOrgs: accessibleOrgs,
      effectiveOrg: { ...selected, source: 'env' },
      selectionRequired: false,
      reservedAutoSelectEligible,
      selectedOrgAccessible: true
    };
  }
  if (reservedAutoSelectEligible && !saved) {
    const auto = byId.get(DEFAULT_ORG_ID) ?? { id: DEFAULT_ORG_ID, name: 'Default' };
    return {
      accessibleOrgs,
      candidateOrgs: accessibleOrgs,
      effectiveOrg: { ...auto, source: 'reserved_auto_select' },
      selectionRequired: false,
      reservedAutoSelectEligible: true,
      selectedOrgAccessible: true
    };
  }
  return {
    accessibleOrgs,
    candidateOrgs: accessibleOrgs,
    effectiveOrg: undefined,
    selectionRequired: true,
    reservedAutoSelectEligible,
    selectedOrgAccessible: false
  };
}
```

Implement `healthCheck`, `listAccessibleOrgs`, `getCurrentOrg` on `JumpServerClient`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- test/jumpserver/orgContext.test.ts test/jumpserver/JumpServerClient.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jumpserver/orgs.ts src/jumpserver/orgContext.ts src/jumpserver/JumpServerClient.ts \
  test/jumpserver/orgContext.test.ts test/jumpserver/JumpServerClient.test.ts
git commit -m "$(cat <<'EOF'
feat: add JumpServer org listing, current org, and health check

EOF
)"
```

---

### Task 7: Validate and refresh resolve org (QuickPick + persist)

**Files:**
- Modify: `src/extension.ts` (`jumpserverManager.validate`, `jumpserverManager.refresh`, `createClient`)
- Modify: `test/extension/ExtensionCommands.test.ts`
- Modify: `test-fixtures/vscode.ts`
- Modify: `l10n/bundle.l10n.zh-cn.json`

New English source strings (must be added to the zh-cn bundle or `test/i18n/nls.test.ts` fails):

| English key | zh-cn |
|---|---|
| `JumpServer account verified. Organization: {org}.` | `JumpServer 账号校验成功。当前组织：{org}。` |
| `Select the JumpServer organization to query.` | `请选择要查询的 JumpServer 组织。` |
| `Organization selection was cancelled.` | `已取消组织选择。` |
| `Saved JumpServer organization {org} is no longer accessible.` | `已保存的 JumpServer 组织 {org} 当前不可访问。` |

- [ ] **Step 1: Add `showQuickPick` to the VS Code fixture and write failing command tests**

In `test-fixtures/vscode.ts` `window` object, add:

```ts
showQuickPick: vi.fn(),
```

Extend `jumpServerClientMock` in `test/extension/ExtensionCommands.test.ts`:

```ts
healthCheck: vi.fn(),
listAccessibleOrgs: vi.fn(),
getCurrentOrg: vi.fn(),
setOrgId: vi.fn(),
```

In `beforeEach`, default:

```ts
jumpServerClientMock.healthCheck.mockResolvedValue({ skipped: true });
jumpServerClientMock.listAccessibleOrgs.mockResolvedValue([
  { id: '00000000-0000-0000-0000-000000000002', name: 'Default' }
]);
jumpServerClientMock.getCurrentOrg.mockResolvedValue({
  id: '00000000-0000-0000-0000-000000000002',
  name: 'Default'
});
```

Add those four functions to `jumpServerClientMock.JumpServerClient.mockImplementation(() => ({ ... }))` next to `getUserProfile`.

Replace the validate assertion:

```ts
expect(jumpServerClientMock.healthCheck).toHaveBeenCalledTimes(1);
expect(jumpServerClientMock.getUserProfile).toHaveBeenCalledTimes(1);
expect(jumpServerClientMock.listAccessibleOrgs).toHaveBeenCalledTimes(1);
expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
  'JumpServer account verified. Organization: Default.'
);
```

Add:

```ts
it('asks the user to pick an organization when several are visible and none is saved', async () => {
  const context = contextWithSettings();
  jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
    { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
    { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
  ]);
  vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
    label: 'Prod',
    description: '11111111-1111-1111-1111-111111111111',
    orgId: '11111111-1111-1111-1111-111111111111',
    name: 'Prod'
  } as never);

  activate(context);
  await registeredCommand('jumpserverManager.validate')();

  expect(vscode.window.showQuickPick).toHaveBeenCalled();
  expect(context.globalState.update).toHaveBeenCalledWith(
    'jumpserverManager.settings',
    expect.objectContaining({ orgId: '11111111-1111-1111-1111-111111111111' })
  );
  expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
});

it('stops validate when organization selection is cancelled', async () => {
  jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
    { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
    { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
  ]);
  vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

  await registeredCommand('jumpserverManager.validate')();

  expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
    'Organization selection was cancelled.',
    'error'
  );
  expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
});
```

`contextWithSettings()` already uses `orgId: ''`. Persist goes through `JumpServerConfigManager.saveSettings` → `globalState.update('jumpserverManager.settings', ...)`. There is no `configManager` mock.

Refresh must call the same org helper **before** `listAssetNodes` / `listAllAssets`. Add one refresh test: cancelled QuickPick does not list assets.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/extension/ExtensionCommands.test.ts test/i18n/nls.test.ts`

Expected: FAIL — validate still shows `JumpServer account verified.` and `showQuickPick` is undefined.

- [ ] **Step 3: Implement `ensureOrgContext` in `extension.ts`**

Add a helper in `src/extension.ts` (keep it in this file; do not add a fourth org module):

```ts
async function ensureOrgContext(
  configManager: JumpServerConfigManager,
  client: JumpServerClient
): Promise<{ id: string; name: string } | undefined> {
  const settings = await configManager.requireSettings();
  const accessible = await client.listAccessibleOrgs();
  const context = resolveOrgContext({ savedOrgId: settings.orgId, accessibleOrgs: accessible });
  if (context.effectiveOrg && context.effectiveOrg.source === 'reserved_auto_select') {
    await configManager.saveSettings({ ...settings, orgId: context.effectiveOrg.id, updatedAt: Date.now() });
    return context.effectiveOrg;
  }
  if (context.effectiveOrg && !context.selectionRequired) {
    return context.effectiveOrg;
  }
  const picked = await vscode.window.showQuickPick(
    context.candidateOrgs.map((org) => ({
      label: org.name || org.id,
      description: org.id,
      orgId: org.id,
      name: org.name || org.id
    })),
    { title: t('Select the JumpServer organization to query.'), ignoreFocusOut: true }
  );
  if (!picked) {
    showTimedNotification(t('Organization selection was cancelled.'), 'error');
    return undefined;
  }
  await configManager.saveSettings({ ...settings, orgId: picked.orgId, updatedAt: Date.now() });
  return { id: picked.orgId, name: picked.name };
}
```

**Important:** after persisting `orgId`, the same `client` instance still has the old org header. Recreating the client is not required: call `client.setOrgId(org.id)` (Task 7 unit test above).

**Required:** add `setOrgId(orgId: string): void` on `JumpServerClient`. Keep `settings` readonly; store `private orgId = settings.orgId` and read that in `restHeaders()`. Add this unit test in `JumpServerClient.test.ts`:

```ts
it('sends the updated X-JMS-ORG after setOrgId', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
    .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }));
  const client = new JumpServerClient({
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  }, fetchMock);
  client.setOrgId('org-2');
  await client.getUserProfile();
  expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
    headers: expect.objectContaining({ 'X-JMS-ORG': 'org-2' })
  }));
});
```

Validate command:

```ts
await client.healthCheck();
await client.ensureAuthToken();
await client.getUserProfile();
const org = await ensureOrgContext(configManager, client);
if (!org) {
  return;
}
client.setOrgId(org.id);
showTimedNotification(t('JumpServer account verified. Organization: {org}.', { org: org.name }));
```

Refresh:

```ts
const org = await ensureOrgContext(configManager, client);
if (!org) {
  return;
}
client.setOrgId(org.id);
const nodes = await client.listAssetNodes();
// ... existing save + listAllAssets
```

If saved org is inaccessible, QuickPick still runs (`selectionRequired: true`). Optionally prepend the toast `Saved JumpServer organization {org} is no longer accessible.` before QuickPick when `settings.orgId` is set and `!context.selectedOrgAccessible`. Include that toast so the string is not dead.

- [ ] **Step 4: Add l10n entries and run GREEN**

Add the four English keys to `l10n/bundle.l10n.zh-cn.json`.

If validate success string changed, grep for `JumpServer account verified.` and update every test/docs mention in this repo that asserts the old toast.

Run: `npm test -- test/extension/ExtensionCommands.test.ts test/i18n/nls.test.ts test/jumpserver/JumpServerClient.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/jumpserver/JumpServerClient.ts test-fixtures/vscode.ts \
  test/extension/ExtensionCommands.test.ts l10n/bundle.l10n.zh-cn.json \
  test/jumpserver/JumpServerClient.test.ts
git commit -m "$(cat <<'EOF'
feat: require a JumpServer organization before validate and refresh

EOF
)"
```

---

### Task 8: README and full suite

**Files:**
- Modify: `README.md` (Setup steps 3–5)

- [ ] **Step 1: Update Setup copy**

Replace the org sentence in Setup:

```
3. Enter JumpServer base URL, username, password, optional org ID, and TLS verification.
4. Run `JumpServer: Validate Account`.
```

with:

```
3. Enter JumpServer base URL, username, password, and TLS verification. Org ID can stay empty.
4. Run `JumpServer: Validate Account`. If the account can see more than one organization, pick one; the Default organization is saved automatically only on a reserved single-org deployment.
5. Run `JumpServer: Refresh Assets`.
```

Renumber the following steps. Mention that an empty org plus multiple organizations will prompt on Validate/Refresh, not silently mix inventories.

Keep the "Not Supported" bullet for access key / private token / SSO.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: PASS, 0 failures. If the count in `CHANGELOG.md` / `docs/releases/0.1.8.md` still says "424 tests", **do not** edit those historical release notes. Only README in this task.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: explain JumpServer organization selection on validate

EOF
)"
```

---

## Self-review

| Spec item | Task |
|---|---|
| 401 refresh / 403 no refresh | Task 1 + Task 3 |
| Error body + Date | Task 2 |
| `next` rewrite, loop, `all=1`, 429 | Task 4 + Task 5 |
| Org list/current, reserved auto-select, QuickPick | Task 6 + Task 7 |
| Health + validate message | Task 6 + Task 7 |
| README | Task 8 |
| HMAC / admin APIs / TLS default / KoKo | Explicitly out of scope |

No TBD/TODO placeholders. `setOrgId` is introduced in Task 7 because the client snapshots settings at construction — later tasks must not assume a new `JumpServerClient` is created after QuickPick unless they also recreate it; the plan requires `setOrgId` so either approach is not mixed.

`JumpServerApiError.message` always contains `HTTP ${status}` so existing `/HTTP 503/` assertions survive Task 2.

---

## Execution (only after the user confirms)

Do not start Tasks 1–8 until the user replies to implement. Then choose:

1. **Subagent-Driven (recommended)** — `superpowers:subagent-driven-development`, one subagent per task, review between tasks.
2. **Inline Execution** — `superpowers:executing-plans` in this session with checkpoints.
