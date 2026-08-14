# JumpServer SFTP File Management Design

## Goal

Add first-phase SFTP file management to AT JumpServer Terminal using JumpServer's existing file management service. The implementation must be gated by a real JumpServer protocol probe: query and document the relevant interfaces first, write a standalone test script, verify the script against a real JumpServer asset, and only then implement the VS Code extension feature.

First phase scope:

- Browse a selected asset's remote file tree.
- Navigate into directories, go to parent, and jump to a typed path.
- Upload local files to the current or selected remote directory.
- Download remote files or directories when JumpServer permits it.
- Create directories.
- Rename files and directories.
- Delete files and directories.
- Copy remote paths.

Second phase direction:

- Remote file preview and edit sessions.
- Save-to-upload synchronization.
- Conflict checks before upload.
- Read/write/stat interfaces must be reserved in phase one so phase two does not require reshaping the whole SFTP layer.

## Current Context

The current project is a VS Code extension for browser-style JumpServer SSH and MySQL sessions. The existing `JumpServerClient` already handles:

- Username/password REST authentication.
- Cookie capture and reuse.
- Current-user lookup.
- Permitted asset listing and asset detail lookup.
- Connection token creation for SSH and MySQL.
- KoKo smart endpoint lookup.
- KoKo web-session warmup.
- KoKo terminal WebSocket connection.

`README.md` explicitly lists SFTP and remote file editing as unsupported. This change removes SFTP file management from that unsupported list after phase one, while remote editing remains documented as phase two.

The reference project at `C:\Users\alan\Desktop\ssh-plugins` has a mature SFTP UX built around:

- `src/sftp/SftpManager.ts`
- `src/sftp/SftpSession.ts`
- `src/sftp/TransferService.ts`
- `src/tree/SftpTreeProvider.ts`
- `src/tree/SftpTreeItems.ts`
- preview and edit managers
- drag-and-drop upload

Its lower-level session uses native `ssh2` SFTP and cannot be copied directly. The useful part is the interface shape, command set, tree UX, transfer progress model, and test structure.

## Interface Findings

JumpServer exposes file management through KoKo, not just a raw SFTP port.

Primary sources checked:

- Running JumpServer instances expose OpenAPI-style API docs at `/api/docs/`; the probe script should print this URL for the configured instance and use the same REST endpoints already used by this project.
- KoKo source routes show `/koko/ws/sftp/` for WebSocket file management.
- KoKo source routes also show `/koko/elfinder/sftp/` and `/koko/elfinder/connector/:host/` for the browser elFinder integration.
- KoKo UI source `useFileManage.ts` connects to `${BASE_WS_URL}/koko/ws/sftp/?token=${token}` with subprotocol `JMS-KOKO`.

The WebSocket SFTP protocol uses JSON messages:

- Incoming control: `CONNECT`, `PING`, `PONG`, `CLOSE`, `ERROR`.
- Data responses: `SFTP_DATA`.
- Binary responses: `SFTP_BINARY`.
- Commands: `list`, `download`, `upload`, `rm`, `rename`, `mkdir`.

The KoKo server handles request payload fields:

- `path`
- `new_name`
- `chunk`
- `merge`
- `offset`
- `size`
- `is_dir`

For phase one, prefer `/koko/ws/sftp/?token=...` over elFinder because it maps cleanly to a VS Code tree and command model. Keep elFinder as a fallback research reference only.

## Recommended Approach

Use a KoKo WebSocket SFTP adapter with an internal interface modeled after the `ssh-plugins` SFTP manager.

The feature has three layers:

1. JumpServer protocol layer
   Extend `JumpServerClient` with helper methods for SFTP token creation, SFTP WebSocket URL construction, and SFTP WebSocket opening. Reuse current authentication, cookie, TLS, origin, and smart-endpoint behavior.

2. SFTP domain layer
   Add `src/sftp/*` modules that translate KoKo WebSocket commands into stable TypeScript methods:
   - `connect`
   - `realpath`
   - `listDirectory`
   - `mkdir`
   - `rename`
   - `deleteEntry`
   - `uploadFile`
   - `downloadFile`
   - reserved: `stat`
   - reserved: `readFile`
   - reserved: `writeFile`
   - reserved: `createFile`

3. VS Code integration layer
   Add a file tree view and commands under the existing AT JumpServer activity bar. Commands should mirror the useful subset from `ssh-plugins`, adapted to JumpServer wording and command ids.

## Architecture

### JumpServerClient Additions

Add pure URL helpers:

- `buildKokoSftpWsUrl(baseUrl, endpoint, tokenId, timestamp?)`

Expected URL:

- Scheme follows current KoKo logic: `https` becomes `wss`, `http` becomes `ws`.
- Host and port use the smart endpoint the same way terminal WebSocket does.
- Path is `/koko/ws/sftp/`.
- Query includes `token=<id>` and a timestamp cache buster.

Add token payload support:

- SFTP token creation should use the existing `/api/v1/authentication/connection-token/` endpoint.
- Payload should use `protocol: "sftp"`.
- Account resolution should reuse `resolveFirstUsableAccount`.
- Connect method must be confirmed by the probe before implementation. Candidate values are `"sftp"` or the server default for protocol `"sftp"`. The probe must log the accepted payload shape.

Add WebSocket opener:

- `openKokoSftpWebSocket({ endpoint, tokenId, webSocketFactory? })`.
- It must call the existing web-session warmup before opening the socket.
- It must send the `JMS-KOKO` subprotocol and current cookie header.
- It must honor `verifyTls`.

### SFTP Session

Create `JumpServerSftpSession` around a single KoKo SFTP WebSocket.

Responsibilities:

- Fetch asset detail.
- Verify `sftp` is listed in `permed_protocols` or equivalent protocol metadata.
- Resolve a usable account.
- Create a SFTP connection token.
- Look up a smart endpoint.
- Open the KoKo SFTP WebSocket.
- Track connection state.
- Respond to `PING` with `PONG`.
- Resolve command promises by message id.
- Surface `ERROR`, `CLOSE`, and command-level `err` fields as useful errors.
- Dispose the socket and reject pending commands on close.

Command mapping:

- `list(path)` sends `{ id, type: "SFTP_DATA", cmd: "list", data: "{\"path\":\"...\"}" }`.
- `mkdir(path)` sends `cmd: "mkdir"`.
- `rename(path, newName)` sends `cmd: "rename"` with `new_name`.
- `rm(path)` sends `cmd: "rm"`.
- `download(path, isDir)` sends `cmd: "download"` and collects `SFTP_BINARY` chunks until the final `SFTP_DATA` with filename.
- `upload(path, bytes)` sends `cmd: "upload"`, either single-message upload for small files or chunk/merge messages for larger files.

Binary handling:

- KoKo browser UI expects `raw` to be base64 when messages are JSON encoded.
- The Node `ws` client may receive JSON where `raw` is a base64 string or decoded buffer-like data depending on server behavior. The probe must record the exact response shape.
- The implementation should decode defensively and cover both base64 strings and byte arrays in tests.

Entry normalization:

Map KoKo file entries into:

```ts
export type JumpServerSftpEntryType = 'file' | 'directory' | 'symlink';

export interface JumpServerSftpEntry {
  name: string;
  path: string;
  type: JumpServerSftpEntryType;
  size?: number;
  modifiedAt?: number;
}
```

Expected source fields from KoKo include `name`, `size`, `mod_time`, `type`, and `is_dir`. The normalizer should tolerate missing and string-valued fields.

### SFTP Manager

Create a manager similar to `ssh-plugins` `SftpManager`, but keyed by JumpServer asset id instead of SSH terminal server id.

State:

- No active SFTP asset.
- Active asset with current root path.
- Disconnected snapshot for the last listed directory.

Responsibilities:

- Lazily create one SFTP session for the selected asset.
- Keep the current root/current path.
- Cache the latest listed entries for disconnected display.
- Provide methods used by commands and tree provider.
- Dispose sessions on extension shutdown or when asset context changes.

Unlike the SSH reference project, phase one does not need to depend on an active terminal tab. SFTP can be opened from an asset tree item directly as long as the asset supports the `sftp` protocol.

### Tree View And Commands

Add a new view under `jumpserverManager`, for example:

- View id: `jumpserverManager.sftpFiles`
- Name: `Files`

Commands:

- `jumpserverManager.sftp.open`
- `jumpserverManager.sftp.refresh`
- `jumpserverManager.sftp.goToPath`
- `jumpserverManager.sftp.goUp`
- `jumpserverManager.sftp.upload`
- `jumpserverManager.sftp.download`
- `jumpserverManager.sftp.delete`
- `jumpserverManager.sftp.rename`
- `jumpserverManager.sftp.newFolder`
- `jumpserverManager.sftp.copyPath`

Asset context menu:

- Show `Open Files` on SSH assets that expose or may expose SFTP.
- If the selected asset does not expose SFTP, show a clear error instead of opening an empty tree.

SFTP file tree context menu:

- Directories: open/expand, upload, new folder, rename, delete, copy path.
- Files: download, rename, delete, copy path.
- View title: refresh, upload, go up, go to path.

Transfer UX:

- Use VS Code progress notifications for upload and download.
- Show concise success and error notifications.
- Refresh the tree after mutating operations.

## Probe Script Requirement

Before implementing extension code, add a standalone probe script under `tools/`, for example:

- `tools/probe-jumpserver-sftp.mjs`

Inputs should come from environment variables so no secrets are committed:

- `JUMPSERVER_BASE_URL`
- `JUMPSERVER_USERNAME`
- `JUMPSERVER_PASSWORD`
- `JUMPSERVER_ASSET_ID`
- optional `JUMPSERVER_ORG_ID`
- optional `JUMPSERVER_VERIFY_TLS`
- optional `JUMPSERVER_SFTP_TEST_PATH`
- optional `JUMPSERVER_SFTP_UPLOAD_FILE`

The probe must:

1. Print the instance API docs URL: `${baseUrl}/api/docs/`.
2. Authenticate with `/api/v1/authentication/auth/`.
3. Fetch current profile.
4. Fetch the target permitted asset detail.
5. Print sanitized protocol/account metadata.
6. Confirm `sftp` support.
7. Try SFTP connection token payload variants only if needed, logging which one succeeds without printing secrets.
8. Warm up the KoKo web session using the existing login page flow.
9. Connect to `/koko/ws/sftp/?token=...` using `JMS-KOKO`.
10. Wait for `CONNECT`.
11. Send `list` for the requested path or root.
12. Print normalized entries.
13. If an upload file is configured, upload it to a safe test path, list it, download it, compare bytes, then delete it.

The implementation plan must treat this script as a gate. If it cannot successfully list files on a real JumpServer asset, do not implement the VS Code feature yet; update the protocol assumptions first.

## Testing Strategy

Unit tests:

- URL helper builds `/koko/ws/sftp/` with correct scheme, host, port, token, and timestamp.
- SFTP connection token payload uses the probe-confirmed shape.
- File entry normalizer handles directories, files, symlinks, string sizes, missing modified time, and root/child path joins.
- SFTP session responds to `CONNECT` and `PING`.
- SFTP session resolves `list`, `mkdir`, `rename`, `rm`, `download`, and `upload` command responses.
- SFTP session rejects pending commands on `ERROR`, `CLOSE`, socket close, and command-level `err`.
- Manager keeps active state, snapshots, and disposes stale sessions.
- Tree provider renders placeholder, parent entry, directories, files, and disconnected snapshots.
- Extension command registration and package manifest expose the new view and commands.

Manual tests:

- Configure a real JumpServer account.
- Refresh assets.
- Open files for an SFTP-capable asset.
- List root/current directory.
- Navigate into a directory and back up.
- Upload a small text file.
- Download it and compare content.
- Rename it.
- Delete it.
- Create and delete a directory.
- Confirm unsupported assets show a clear error.
- Confirm terminal SSH/MySQL flows still work.

## Error Handling

Show clear messages for:

- Missing JumpServer settings or password.
- Asset does not support SFTP.
- No usable account returned for the asset.
- Connection token creation rejected.
- KoKo web session not authenticated.
- WebSocket closed before `CONNECT`.
- JumpServer permission denied on upload/download/delete.
- Session expired or not found.
- Upload/download byte mismatch in the probe script.

Do not expose passwords, bearer tokens, cookies, or connection token ids in user-facing errors or normal logs. Probe debug output may print token id only when explicitly enabled; default output should redact it.

## Phase Two Reserved Interfaces

Phase one should define but does not need to expose commands for:

```ts
interface JumpServerSftpSessionLike {
  stat(path: string): Promise<{ size: number; modifiedAt: number }>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  createFile(path: string): Promise<void>;
}
```

If KoKo WebSocket lacks direct stat/read/write commands:

- `stat` can be derived from parent-directory `list` when possible.
- `readFile` can use `download` and enforce `maxBytes`.
- `writeFile` can use upload-to-same-path if permitted.
- `createFile` can upload an empty file if KoKo does not support `mkfile`.

Phase two should adapt the reference project's preview/edit model:

- Download remote file into an extension-owned local cache.
- Open the cached file in VS Code.
- On first save, ask the user to enable sync for that edit session.
- Before upload, compare current remote stat to the base stat.
- On conflict, ask whether to overwrite or cancel.
- After upload, verify size and optionally content.
- Clean up cache files on close.

This is intentionally out of phase-one scope, but the first-phase module boundaries should make it a consumer of the SFTP manager rather than a rewrite.

## Non-Goals

- Native SSH/SFTP connection to JumpServer port `2222`.
- Remote edit auto-sync in phase one.
- MCP/agent file tools.
- Recursive directory upload from drag-and-drop.
- Cross-asset search.
- ElFinder UI embedding.
- New authentication modes such as SSO, MFA, access key, or private token login.

## Acceptance Criteria

- A standalone probe script can list files for a real SFTP-capable JumpServer asset.
- The probe script documents the confirmed token payload and WebSocket message shapes in its output.
- VS Code shows a Files view under AT JumpServer.
- Opening files for an SFTP-capable asset lists remote entries.
- Upload, download, new folder, rename, delete, refresh, copy path, go up, and go to path work.
- Unsupported assets and permission failures show clear errors.
- Existing SSH and MySQL terminal behavior remains unchanged.
- Unit tests cover protocol helpers, session command handling, manager state, tree rendering, and command registration.
- The README/manual verification section is updated for phase-one SFTP and still says remote edit auto-sync is future work.
