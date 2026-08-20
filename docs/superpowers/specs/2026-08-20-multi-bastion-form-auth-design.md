# Multi-bastion + form-auth fallback Design

**Date:** 2026-08-20  
**Status:** Approved — implementation plan: `docs/superpowers/plans/2026-08-20-multi-bastion-form-auth.md`  
**Prerequisite:** REST alignment on `feat/jumpserver-rest-alignment` (401 vs 403, org QuickPick, DRF `next`, `all=1&display=1`, 429 backoff, `GET /api/health/`). Those behaviors stay; this spec does not re-implement them.

---

## 1. Goal

Let one VS Code / Cursor / Antigravity window manage **several JumpServer bastions at once**: grouped asset tree, per-bastion credentials and org, concurrent terminals. Password login tries JSON first and, if that does not yield a token, retries once as `application/x-www-form-urlencoded`.

## 2. Decisions (locked)

| # | Decision |
|---|----------|
| D1 | One tree, roots are bastions; node/asset layout under each root is unchanged. |
| D2 | Concurrent sessions: terminals (and their SFTP sessions) to different bastions may stay open together. |
| D3 | HMAC / Access Key is **out of this spec**. Password per bastion remains required for KoKo. |
| D4 | Configure UX is commands + one-bastion form, not a list webview. Tree root context: refresh this / edit / delete. |
| D5 | Toolbar **Refresh Assets** refreshes **all** bastions (parallel, isolated failures). Root context refresh refreshes **one**. |
| D6 | Files view stays **one active SFTP session**, not a second tree per bastion. |
| D7 | Each bastion keeps its own `orgId` and existing org resolution (reserved auto-select / QuickPick). |
| D8 | JSON auth first; form-urlencoded retry **once** only when JSON did not produce a `token`. |

## 3. Data model

### Bastion (no secrets)

```ts
interface JumpServerBastion {
  id: string;          // UUID, stable
  name: string;        // display label; empty allowed in form, stored as hostname fallback
  baseUrl: string;
  orgId: string;
  username: string;
  verifyTls: boolean;
  updatedAt: number;
}
```

`name` after save: `trim()`; if empty, `new URL(baseUrl).hostname` (or the raw host if URL parse fails). Never persist an empty name.

Password: SecretStorage key `jumpserverManager.password.${id}` (same empty-on-edit-means-keep-old rule as today).

### Persistence keys

| Key | Store | Value |
|---|---|---|
| `jumpserverManager.bastions` | globalState | `JumpServerBastion[]` |
| `jumpserverManager.password.<id>` | secrets | password string |
| `jumpserverManager.cachedAssets` | globalState | assets **each including `bastionId`** |
| `jumpserverManager.cachedAssetNodes` | globalState | nodes **each including `bastionId`** |

Stop writing `jumpserverManager.settings` and `jumpserverManager.password` (no suffix) after migration.

### Cached rows

`CachedJumpServerAsset` and `CachedJumpServerNode` gain required `bastionId: string`. Tree item ids and MCP summaries use it.

Tree ids (must be unique across bastions):

- Bastion root: `bastion:<id>`
- Group: `group:<bastionId>/<path joined by />`
- Asset: `asset:<bastionId>/<assetId>`

`contextValue` for roots: `jumpserverBastion`. Asset context values unchanged.

### Migration (once, on activate / first config read)

If `jumpserverManager.bastions` is missing or empty **and** old `jumpserverManager.settings` parses:

1. Allocate a new UUID `id`.
2. Write one bastion from old settings (`name` from hostname).
3. Move password from `jumpserverManager.password` to `jumpserverManager.password.<id>`.
4. Stamp existing cached assets/nodes with that `bastionId` (drop rows that fail schema).
5. Delete old `jumpserverManager.settings` and old `jumpserverManager.password`.

If old settings are absent, start with an empty bastion list (empty-tree prompt). Do not invent a bastion.

## 4. Config manager

Replace the single-settings API with bastion-scoped methods. Callers never see the old singleton shape after migration.

Required surface (names may match this set):

- `listBastions()`, `getBastion(id)`, `requireBastion(id)`
- `saveBastion(bastion, password?: string)` — create or update; optional password
- `deleteBastion(id)` — settings, secret, that bastion’s cached assets/nodes; does not wipe other bastions
- `requirePassword(id)`
- `saveCachedAssets(id, assets)`, `listCachedAssets()` (all), `listCachedAssets(id)` (one)
- `saveCachedAssetNodes(id, nodes)`, `listCachedAssetNodes()` / `(id)`

`createClient(id)` in `extension.ts`: `requireBastion` + `requirePassword` → `new JumpServerClient({ ...bastion, password })`. Reuse one in-memory client per id for the lifetime of a command where practical; **each TerminalPanel / SFTP session keeps the client it was given** so two bastions stay independent.

## 5. UI and commands

### Form

Keep `JumpServerConfigPanel` as a **single bastion** form. Add display-name field. Save writes `saveBastion`. After save, refresh **that** bastion’s assets (not necessarily all).

### Commands

| Command | Behavior |
|---|---|
| `jumpserverManager.configure` | 0 bastions → add form. ≥1 → QuickPick of bastions **plus** an “Add JumpServer” entry → edit or add form. |
| `jumpserverManager.addBastion` | Empty add form. |
| `jumpserverManager.removeBastion` | QuickPick → confirm → `deleteBastion` → dispose terminals whose asset `bastionId` matches. |
| `jumpserverManager.refresh` | Parallel refresh all bastions; one failure does not abort others; one summary toast (success count + failed names/reasons). |
| `jumpserverManager.refreshBastion` | Argument: bastion tree item or id; refresh only that id. |
| `jumpserverManager.validate` | ≥2 bastions: QuickPick (no “all”). Run existing health → auth → org flow for that id only; persist org on that bastion only. |

Tree root context menu: Refresh this, Edit (opens form for that id), Delete (same as remove with confirm).

Empty tree: one placeholder item with a short “Add JumpServer to get started” label; no fake bastion id.

### Connect / SFTP

`jumpserverManager.connect` uses `item.asset.bastionId` to obtain that bastion’s client. Two terminals on two bastions remain open.

SFTP: still bound to the terminal / connection key in `JumpServerSftpManager`. No extra Files tree per bastion.

## 6. Form-urlencoded auth fallback

In `JumpServerClient.ensureAuthToken`:

1. POST `/api/v1/authentication/auth/` JSON `{ username, password }` (unchanged).
2. If `response.ok` and body has `token`, use it. Stop.
3. Otherwise **one** POST to the same path with `content-type: application/x-www-form-urlencoded` and body `username` + `password` (URLSearchParams).
4. If form yields a token, use it. If not, throw `JumpServerApiError` from the **form** attempt if it ran, else from the JSON attempt (include parsed `detail`/`msg`/`error`/`message` as today).

Do not retry form after a successful JSON token. Do not change KoKo CSRF login. Do not add HMAC.

## 7. MCP

`jumpserver_list_assets`:

- Union of all bastions’ cached assets.
- Each summary includes `bastionId` and `bastionName` (from the bastion record; if missing, hostname).
- `search` matches existing fields **and** `bastionId` / `bastionName`.
- Optional `bastionId` argument: filter to that bastion. Unknown id → empty list, not an error.

Terminal and SFTP tools stay keyed by `terminalId` / `connectionKey`. No new “connect to bastion” MCP tool.

Catalog description for `jumpserver_list_assets` must mention `bastionId` so agents can disambiguate duplicate asset names.

## 8. Errors and l10n

- Refresh-all summary is user-visible (success count; each failure named). Per-bastion refresh failure uses the existing command error toast for that bastion only.
- Delete confirmation names the bastion.
- Every new `t('...')` English source is added to `l10n/bundle.l10n.zh-cn.json`; `npm run sync:l10n` (or equivalent) keeps `zh-hans` / `zh` aliases identical.
- `package.nls.json` + `package.nls.zh-cn.json` for new command titles; aliases copied the same way.

## 9. Tests (required)

| Area | Must fail if the behavior is missing |
|---|---|
| Migration | Old singleton settings + password + caches become one bastion; old keys gone; assets tagged with the new id |
| Tree ids | Two bastions with the same asset id produce two tree items with distinct `id`s; connect uses the matching `bastionId` |
| Refresh | Toolbar refresh calls listing for **both** clients; root refresh calls **one** |
| Delete | Removes only that bastion’s secret/cache; disconnects only that bastion’s terminals |
| Auth | JSON without token → form POST; JSON with token → no form POST |
| MCP | `list_assets` includes `bastionId`/`bastionName`; `bastionId` filter works; search hits bastion name |
| Org | Validate on bastion A does not rewrite bastion B’s `orgId` |
| i18n | New `t()` keys exist in zh-cn (existing nls test) |

## 10. Out of scope

- Access Key HMAC, private token, SSO, MFA
- Admin asset APIs (`/api/v1/assets/assets/`)
- Config webview as a multi-row bastion table
- Per-bastion SFTP tree
- Changing `verifyTls` default, default page size, KoKo protocol
- Version bump, CHANGELOG, marketplace release notes
- Re-doing REST `next` / `all=1` / 429 / health (already shipped)

## 11. Architecture sketch

```text
JumpServerConfigManager
  bastions[] + password.<id> + caches with bastionId
        │
        ├─ Tree: BastionTreeItem → existing Group/Asset items (ids scoped)
        ├─ createClient(id) → JumpServerClient (JSON then form auth)
        ├─ TerminalPanel / SftpSession hold that client
        └─ MCP list_assets unions caches; tools use connected terminal
```

`JumpServerClient` remains one-host. Multi-bastion is a configuration and tree concern, not a second HTTP stack.
