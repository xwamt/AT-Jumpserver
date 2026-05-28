# JumpServer SFTP Phase Two Preview And Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add right-click Preview and Edit for JumpServer SFTP files, with first-save sync confirmation, conflict detection, upload verification, and cache cleanup.

**Architecture:** Reuse the existing KoKo SFTP session and manager as the transport, then add three focused consumers: file safety guards, a read-only preview store, and an edit session manager. Wire these through VS Code commands and manifest entries without changing phase-one file operations.

**Tech Stack:** TypeScript, VS Code extension API, Node `fs/promises`, Vitest, existing JumpServer KoKo SFTP WebSocket manager/session.

---

## File Structure

- `src/sftp/JumpServerSftpManager.ts`: add active connection key lookup and optional connection-key routing for `stat`, `readFile`, `writeFile`, `createFile`, `uploadFile`, and `downloadFile`.
- `test/sftp/JumpServerSftpManager.test.ts`: cover connection-key routing for edit consumers.
- `src/sftp/SftpFileGuards.ts`: safety checks for 1 MB max preview/edit and binary-like buffers.
- `test/sftp/SftpFileGuards.test.ts`: guard tests.
- `src/sftp/SftpPreview.ts`: read-only virtual document store and preview cache helpers.
- `test/sftp/SftpPreview.test.ts`: preview URI/content/cleanup tests.
- `src/sftp/SftpEditSessionManager.ts`: edit cache, save listener, first-save prompt, conflict handling, upload verification, cleanup.
- `test/sftp/SftpEditSessionManager.test.ts`: edit lifecycle tests.
- `test-fixtures/vscode.ts`: add VS Code fixture methods/classes needed by preview/edit tests.
- `src/extension.ts`: instantiate preview/edit services, register content provider/listeners/commands, add status bar item.
- `package.json`: add `jumpserverManager.sftp.preview` and `jumpserverManager.sftp.edit` commands and file context menu entries.
- `test/extension/ExtensionCommands.test.ts`: verify command registration and basic guard behavior.
- `test/package.manifest.test.ts`: verify manifest includes Preview/Edit and only exposes them for file tree items.
- `README.md`: document phase-two preview/edit behavior, 1 MB limit, binary-file guidance, conflict behavior.

## Scope Notes

- This plan assumes phase-one fixes in the current branch remain in place: multi-terminal SFTP session tracking, numeric KoKo upload ids, and removal of `Go To Path`.
- Do not implement MCP/agent tooling, drag-and-drop upload, or editing files over 1 MB.
- Keep all cache paths local and deterministic; never show local cache internals in user-facing error messages.

---

### Task 1: Add Connection-Key Routing To SFTP Manager

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\src\sftp\JumpServerSftpManager.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test\sftp\JumpServerSftpManager.test.ts`

- [ ] **Step 1: Write failing tests for connection-key routing**

Append these tests inside `describe('JumpServerSftpManager', () => { ... })`:

```ts
  it('exposes the active connection key for edit sessions', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });

    expect(manager.getActiveConnectionKey()).toBeUndefined();
    await manager.openAsset(asset({ id: 'asset-1' }), 'terminal-1');

    expect(manager.getActiveConnectionKey()).toBe('terminal-1');
  });

  it('routes read/write/stat/download/upload by explicit connection key', async () => {
    const firstSession = session();
    const secondSession = session();
    const createSession = vi.fn()
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession);
    const manager = new JumpServerSftpManager({ createSession });

    await manager.openAsset(asset({ id: 'asset-1' }), 'terminal-1');
    await manager.openAsset(asset({ id: 'asset-2' }), 'terminal-2');

    await manager.stat('/tmp/a.txt', 'terminal-1');
    await manager.readFile('/tmp/a.txt', 1024, 'terminal-1');
    await manager.writeFile('/tmp/a.txt', Buffer.from('a'), 'terminal-1');
    await manager.createFile('/tmp/new.txt', 'terminal-1');
    await manager.downloadFile('/tmp/a.txt', 'C:\\\\tmp\\\\a.txt', false, 'terminal-1');
    await manager.uploadFile('C:\\\\tmp\\\\a.txt', '/tmp/a.txt', 'terminal-1');

    expect(firstSession.stat).toHaveBeenCalledWith('/tmp/a.txt');
    expect(firstSession.readFile).toHaveBeenCalledWith('/tmp/a.txt', 1024);
    expect(firstSession.writeFile).toHaveBeenCalledWith('/tmp/a.txt', Buffer.from('a'));
    expect(firstSession.createFile).toHaveBeenCalledWith('/tmp/new.txt');
    expect(firstSession.downloadFile).toHaveBeenCalledWith('/tmp/a.txt', false);
    expect(firstSession.uploadBytes).toHaveBeenCalledWith('/tmp/a.txt', expect.any(Buffer));

    expect(secondSession.stat).not.toHaveBeenCalled();
    expect(secondSession.readFile).not.toHaveBeenCalled();
    expect(secondSession.writeFile).not.toHaveBeenCalled();
    expect(secondSession.createFile).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- test/sftp/JumpServerSftpManager.test.ts
```

Expected: FAIL because `getActiveConnectionKey` and optional connection-key parameters do not exist yet.

- [ ] **Step 3: Implement connection-key routing**

Update the public methods in `src/sftp/JumpServerSftpManager.ts` to this shape:

```ts
  getActiveConnectionKey(): string | undefined {
    return this.activeTerminalId;
  }

  async uploadFile(localPath: string, remotePath: string, connectionKey?: string): Promise<void> {
    await this.transfers.run(`Upload ${remotePath}`, async () => {
      const bytes = await readFile(localPath);
      await (await this.ensureSession(this.requireConnection(connectionKey))).uploadBytes(remotePath, bytes);
    });
  }

  async downloadFile(remotePath: string, localPath: string, isDir = false, connectionKey?: string): Promise<void> {
    await this.transfers.run(`Download ${remotePath}`, async () => {
      const bytes = await (await this.ensureSession(this.requireConnection(connectionKey))).downloadFile(remotePath, isDir);
      await writeFile(localPath, bytes);
    });
  }

  stat(path: string, connectionKey?: string): Promise<JumpServerSftpFileStat> {
    return this.ensureSession(this.requireConnection(connectionKey)).then((session) => session.stat(path));
  }

  readFile(path: string, maxBytes: number, connectionKey?: string): Promise<Buffer> {
    return this.ensureSession(this.requireConnection(connectionKey)).then((session) => session.readFile(path, maxBytes));
  }

  writeFile(path: string, content: Buffer, connectionKey?: string): Promise<void> {
    return this.ensureSession(this.requireConnection(connectionKey)).then((session) => session.writeFile(path, content));
  }

  createFile(path: string, connectionKey?: string): Promise<void> {
    return this.ensureSession(this.requireConnection(connectionKey)).then((session) => session.createFile(path));
  }

  private requireConnection(connectionKey?: string): ManagedConnection {
    const active = connectionKey ? this.connections.get(connectionKey) : this.getActiveConnection();
    if (!active) {
      throw new Error('No active JumpServer SFTP asset.');
    }
    return active;
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```powershell
npm test -- test/sftp/JumpServerSftpManager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\sftp\JumpServerSftpManager.ts test\sftp\JumpServerSftpManager.test.ts
git commit -m "feat: route JumpServer SFTP operations by connection key"
```

---

### Task 2: Add File Safety Guards

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\src\sftp\SftpFileGuards.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test\sftp\SftpFileGuards.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/sftp/SftpFileGuards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertTextFileEditable,
  DEFAULT_SFTP_EDIT_MAX_BYTES,
  isLikelyBinary,
  SftpFileGuardError
} from '../../src/sftp/SftpFileGuards';

describe('SftpFileGuards', () => {
  it('allows small text files', () => {
    expect(() => assertTextFileEditable({
      remotePath: '/tmp/app.conf',
      size: 128,
      sample: Buffer.from('PORT=8080\n')
    })).not.toThrow();
  });

  it('blocks files over the 1 MB default edit limit', () => {
    expect(() => assertTextFileEditable({
      remotePath: '/tmp/big.log',
      size: DEFAULT_SFTP_EDIT_MAX_BYTES + 1,
      sample: Buffer.from('text')
    })).toThrow(SftpFileGuardError);
  });

  it('detects null-byte binary content', () => {
    expect(isLikelyBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('blocks binary-like files with a download hint', () => {
    expect(() => assertTextFileEditable({
      remotePath: '/tmp/app.bin',
      size: 3,
      sample: Buffer.from([0x41, 0x00, 0x42])
    })).toThrow('Use Download instead.');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- test/sftp/SftpFileGuards.test.ts
```

Expected: FAIL because `SftpFileGuards.ts` does not exist.

- [ ] **Step 3: Implement guards**

Create `src/sftp/SftpFileGuards.ts`:

```ts
export const DEFAULT_SFTP_EDIT_MAX_BYTES = 1024 * 1024;

export class SftpFileGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpFileGuardError';
  }
}

export interface EditableFileCheck {
  remotePath: string;
  size?: number;
  sample?: Buffer;
  maxBytes?: number;
}

export function assertTextFileEditable(input: EditableFileCheck): void {
  const maxBytes = input.maxBytes ?? DEFAULT_SFTP_EDIT_MAX_BYTES;
  if (input.size !== undefined && input.size > maxBytes) {
    throw new SftpFileGuardError(`Remote file is larger than ${formatBytes(maxBytes)}: ${input.remotePath}. Use Download instead.`);
  }
  if (input.sample && isLikelyBinary(input.sample)) {
    throw new SftpFileGuardError(`Remote file appears to be binary: ${input.remotePath}. Use Download instead.`);
  }
}

export function isLikelyBinary(sample: Buffer): boolean {
  if (sample.length === 0) {
    return false;
  }
  if (sample.includes(0)) {
    return true;
  }
  let control = 0;
  for (const byte of sample) {
    const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (byte < 0x20 && !allowedWhitespace) {
      control++;
    }
  }
  return control / sample.length > 0.1;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```powershell
npm test -- test/sftp/SftpFileGuards.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\sftp\SftpFileGuards.ts test\sftp\SftpFileGuards.test.ts
git commit -m "feat: guard JumpServer SFTP preview edit files"
```

---

### Task 3: Add Preview Store

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\src\sftp\SftpPreview.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test\sftp\SftpPreview.test.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test-fixtures\vscode.ts`

- [ ] **Step 1: Extend VS Code fixture**

Add this method to `Uri` in `test-fixtures/vscode.ts`:

```ts
  static from(input: { scheme: string; path: string; query?: string }): Uri {
    const uri = new Uri(input.path);
    (uri as any).scheme = input.scheme;
    (uri as any).path = input.path;
    (uri as any).query = input.query ?? '';
    return uri;
  }

  toString(): string {
    return `${(this as any).scheme ?? 'file'}:${(this as any).path ?? this.fsPath}?${(this as any).query ?? ''}`;
  }
```

Add these workspace/window/tabGroups fixture fields:

```ts
export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue
  })),
  registerTextDocumentContentProvider: vi.fn(),
  openTextDocument: vi.fn(async (uri) => ({ uri, languageId: 'plaintext' })),
  onDidSaveTextDocument: vi.fn(),
  onDidCloseTextDocument: vi.fn(),
  workspaceFolders: undefined
};

export const window = {
  createTreeView: vi.fn(),
  createWebviewPanel: vi.fn(),
  createStatusBarItem: vi.fn(() => ({ text: '', tooltip: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() })),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showTextDocument: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn()
};

export const tabGroups = {
  onDidChangeTabs: vi.fn()
};
```

If these objects already exist, merge fields rather than duplicating declarations.

- [ ] **Step 2: Write failing preview tests**

Create `test/sftp/SftpPreview.test.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  JUMPSERVER_SFTP_PREVIEW_SCHEME,
  openRemotePreviewFile,
  safePreviewDocumentName,
  SftpPreviewDocumentStore
} from '../../src/sftp/SftpPreview';

describe('SftpPreviewDocumentStore', () => {
  it('creates safe readonly URIs and serves cached text content', async () => {
    const cacheDir = join(process.cwd(), '.tmp-preview-test');
    await mkdir(cacheDir, { recursive: true });
    const localPath = join(cacheDir, 'app.conf');
    await writeFile(localPath, 'PORT=8080\n');
    const store = new SftpPreviewDocumentStore();

    const uri = store.createReadonlyUri('/tmp/app.conf', localPath);

    expect((uri as any).scheme).toBe(JUMPSERVER_SFTP_PREVIEW_SCHEME);
    await expect(store.provideTextDocumentContent(uri)).resolves.toBe('PORT=8080\n');
  });

  it('downloads and opens a remote preview file', async () => {
    const storageUri = vscode.Uri.file(join(process.cwd(), '.tmp-preview-open'));
    const store = new SftpPreviewDocumentStore();
    const downloadFile = vi.fn(async (_remote: string, local: string) => {
      await mkdir(join(local, '..'), { recursive: true });
      await writeFile(local, 'hello');
    });
    const openUri = vi.fn();

    const uri = await openRemotePreviewFile({
      storageUri,
      remotePath: '/tmp/readme',
      previewStore: store,
      downloadFile,
      openUri
    });

    expect(safePreviewDocumentName('/tmp/readme')).toBe('readme.txt');
    expect(downloadFile).toHaveBeenCalledWith('/tmp/readme', expect.stringContaining('readme.txt'));
    expect(openUri).toHaveBeenCalledWith(uri, { preview: false });
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```powershell
npm test -- test/sftp/SftpPreview.test.ts
```

Expected: FAIL because `SftpPreview.ts` does not exist.

- [ ] **Step 4: Implement preview store**

Create `src/sftp/SftpPreview.ts` by adapting the reference project and using JumpServer naming:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import * as vscode from 'vscode';
import { remoteBasename } from './RemotePath';

export const JUMPSERVER_SFTP_PREVIEW_SCHEME = 'jumpserver-sftp-preview';

export class SftpPreviewDocumentStore implements vscode.TextDocumentContentProvider {
  private readonly filesByUri = new Map<string, string>();

  createReadonlyUri(remotePath: string, localPath: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: JUMPSERVER_SFTP_PREVIEW_SCHEME,
      path: `/${safePreviewDocumentName(remotePath)}`,
      query: encodeURIComponent(localPath)
    });
    this.filesByUri.set(uri.toString(), localPath);
    return uri;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const localPath = this.filesByUri.get(uri.toString());
    return localPath ? await readFile(localPath, 'utf8') : '';
  }

  async deletePreviewFile(uri: vscode.Uri): Promise<void> {
    const localPath = this.filesByUri.get(uri.toString());
    if (!localPath) {
      return;
    }
    this.filesByUri.delete(uri.toString());
    await rm(localPath, { force: true });
  }

  async deletePreviewFilesForClosedTabs(tabs: readonly vscode.Tab[]): Promise<void> {
    for (const tab of tabs) {
      const uri = getTabInputUri(tab);
      if (uri?.scheme === JUMPSERVER_SFTP_PREVIEW_SCHEME) {
        await this.deletePreviewFile(uri);
      }
    }
  }
}

export function safePreviewDocumentName(remotePath: string): string {
  const safeName = remoteBasename(remotePath)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/g, '');
  const displayName = safeName || 'remote-file';
  return extname(displayName) ? displayName : `${displayName}.txt`;
}

export async function openRemotePreviewFile(options: {
  storageUri: vscode.Uri;
  remotePath: string;
  previewStore: SftpPreviewDocumentStore;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  openUri(uri: vscode.Uri, options?: vscode.TextDocumentShowOptions): Promise<void>;
}): Promise<vscode.Uri> {
  const hash = createHash('sha256').update(options.remotePath).digest('hex').slice(0, 16);
  const localPreviewUri = vscode.Uri.joinPath(
    options.storageUri,
    'sftp-preview',
    hash,
    safePreviewDocumentName(options.remotePath)
  );
  await mkdir(dirname(localPreviewUri.fsPath), { recursive: true });
  await options.downloadFile(options.remotePath, localPreviewUri.fsPath);
  const readonlyUri = options.previewStore.createReadonlyUri(options.remotePath, localPreviewUri.fsPath);
  await options.openUri(readonlyUri, { preview: false });
  return readonlyUri;
}

function getTabInputUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (typeof input !== 'object' || input === null || !('uri' in input)) {
    return undefined;
  }
  const uri = (input as { uri?: unknown }).uri;
  return uri instanceof vscode.Uri ? uri : undefined;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run:

```powershell
npm test -- test/sftp/SftpPreview.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\sftp\SftpPreview.ts test\sftp\SftpPreview.test.ts test-fixtures\vscode.ts
git commit -m "feat: add JumpServer SFTP preview store"
```

---

### Task 4: Add Edit Session Manager

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\src\sftp\SftpEditSessionManager.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test\sftp\SftpEditSessionManager.test.ts`

- [ ] **Step 1: Write failing edit manager tests**

Create `test/sftp/SftpEditSessionManager.test.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildEditSessionKey,
  createEditCacheUri,
  remoteStatsMatch,
  SftpEditSessionManager
} from '../../src/sftp/SftpEditSessionManager';

function sftpClient() {
  return {
    getActiveConnectionKey: vi.fn(() => 'terminal-1'),
    stat: vi.fn(async () => ({ size: 5, modifiedAt: 100 })),
    readFile: vi.fn(async () => Buffer.from('hello')),
    downloadFile: vi.fn(async (_remote: string, local: string) => {
      await mkdir(join(local, '..'), { recursive: true });
      await writeFile(local, 'hello');
    }),
    uploadFile: vi.fn()
  };
}

function ui() {
  return {
    openFile: vi.fn(),
    confirmAutoSync: vi.fn(async () => true),
    resolveConflict: vi.fn(async () => 'overwrite' as const),
    showStatus: vi.fn(),
    showError: vi.fn(),
    promptUnsyncedClose: vi.fn(async () => 'discard' as const)
  };
}

describe('SftpEditSessionManager', () => {
  it('builds stable session keys and cache paths', () => {
    expect(buildEditSessionKey('terminal-1', '/tmp/a.txt')).toBe('terminal-1:/tmp/a.txt');
    expect(createEditCacheUri(vscode.Uri.file('storage'), 'terminal-1', '/tmp/a.txt').fsPath).toContain('sftp-edit');
  });

  it('opens an existing edit session instead of duplicating it', async () => {
    const client = sftpClient();
    const editUi = ui();
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(join(process.cwd(), '.tmp-edit-test')),
      sftp: client,
      ui: editUi,
      debounceMs: 1
    });

    const first = await manager.openRemoteFile('/tmp/a.txt');
    const second = await manager.openRemoteFile('/tmp/a.txt');

    expect(first).toBe(second);
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(editUi.openFile).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it('confirms first save and uploads edited content', async () => {
    const client = sftpClient();
    const editUi = ui();
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(join(process.cwd(), '.tmp-edit-save')),
      sftp: client,
      ui: editUi,
      debounceMs: 1
    });
    const session = await manager.openRemoteFile('/tmp/a.txt');
    await writeFile(session.localUri.fsPath, 'world');
    client.stat.mockResolvedValueOnce({ size: 5, modifiedAt: 100 }).mockResolvedValueOnce({ size: 5, modifiedAt: 101 });
    client.readFile.mockResolvedValueOnce(Buffer.from('world'));

    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.flushForTest(session.key);

    expect(editUi.confirmAutoSync).toHaveBeenCalledWith('/tmp/a.txt');
    expect(client.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/tmp/a.txt', 'terminal-1');
    expect(remoteStatsMatch(session.baseRemoteStat, { size: 5, modifiedAt: 101 })).toBe(true);
    manager.dispose();
  });

  it('cancels upload when conflict resolution chooses cancel', async () => {
    const client = sftpClient();
    const editUi = ui();
    editUi.resolveConflict.mockResolvedValueOnce('cancel');
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(join(process.cwd(), '.tmp-edit-conflict')),
      sftp: client,
      ui: editUi,
      debounceMs: 1
    });
    const session = await manager.openRemoteFile('/tmp/a.txt');
    client.stat.mockResolvedValueOnce({ size: 7, modifiedAt: 200 });

    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.flushForTest(session.key);

    expect(editUi.resolveConflict).toHaveBeenCalledWith('/tmp/a.txt');
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(session.syncState).toBe('failed');
    manager.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
```

Expected: FAIL because `SftpEditSessionManager.ts` does not exist.

- [ ] **Step 3: Implement edit session manager**

Create `src/sftp/SftpEditSessionManager.ts` using the reference model, with JumpServer names and a test flush hook:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import type { JumpServerSftpFileStat } from './SftpTypes';
import { safePreviewDocumentName } from './SftpPreview';
import { showTimedNotification } from '../utils/notifications';
import { errorMessage } from '../jumpserver/redaction';

export type SftpEditSyncState = 'idle' | 'pending' | 'uploading' | 'conflict' | 'failed';
export type SftpEditConflictChoice = 'overwrite' | 'cancel';
export type SftpEditCloseChoice = 'keep' | 'discard';

export interface JumpServerSftpEditClient {
  getActiveConnectionKey(): string | undefined;
  stat(remotePath: string, connectionKey?: string): Promise<JumpServerSftpFileStat>;
  readFile(remotePath: string, maxBytes: number, connectionKey?: string): Promise<Buffer>;
  downloadFile(remotePath: string, localPath: string, isDir?: boolean, connectionKey?: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string, connectionKey?: string): Promise<void>;
}

export interface SftpEditUi {
  openFile(uri: vscode.Uri, remotePath: string): Promise<void>;
  confirmAutoSync(remotePath: string): Promise<boolean>;
  resolveConflict(remotePath: string): Promise<SftpEditConflictChoice>;
  showStatus(state: SftpEditSyncState, message: string): void;
  showError(remotePath: string, message: string): Promise<void>;
  promptUnsyncedClose(remotePath: string): Promise<SftpEditCloseChoice>;
}

export interface SftpEditSession {
  key: string;
  connectionKey: string;
  remotePath: string;
  localUri: vscode.Uri;
  baseRemoteStat: JumpServerSftpFileStat;
  firstSaveConfirmed: boolean;
  syncState: SftpEditSyncState;
  uploadInProgress: boolean;
  pendingUpload: boolean;
  uploadTask: Promise<void> | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  lastError: string | undefined;
}

export function buildEditSessionKey(connectionKey: string, remotePath: string): string {
  return `${connectionKey}:${remotePath}`;
}

export function createEditCacheUri(storageUri: vscode.Uri, connectionKey: string, remotePath: string): vscode.Uri {
  const hash = createHash('sha256').update(remotePath).digest('hex').slice(0, 16);
  return vscode.Uri.joinPath(storageUri, 'sftp-edit', safePreviewDocumentName(connectionKey), hash, safePreviewDocumentName(remotePath));
}

export function remoteStatsMatch(left: JumpServerSftpFileStat, right: JumpServerSftpFileStat): boolean {
  return left.size === right.size && left.modifiedAt === right.modifiedAt;
}

export class SftpEditSessionManager {
  private readonly sessionsByKey = new Map<string, SftpEditSession>();
  private readonly sessionsByLocalPath = new Map<string, SftpEditSession>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly debounceMs: number;

  constructor(private readonly options: {
    storageUri: vscode.Uri;
    sftp: JumpServerSftpEditClient;
    ui: SftpEditUi;
    debounceMs?: number;
  }) {
    this.debounceMs = options.debounceMs ?? 750;
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.handleSavedDocument(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.handleClosedDocument(document);
      })
    );
  }

  async openRemoteFile(remotePath: string): Promise<SftpEditSession> {
    const connectionKey = this.options.sftp.getActiveConnectionKey();
    if (!connectionKey) {
      throw new Error('No active JumpServer SFTP asset.');
    }
    const key = buildEditSessionKey(connectionKey, remotePath);
    const existing = this.sessionsByKey.get(key);
    if (existing) {
      await this.options.ui.openFile(existing.localUri, existing.remotePath);
      return existing;
    }
    const localUri = createEditCacheUri(this.options.storageUri, connectionKey, remotePath);
    await mkdir(dirname(localUri.fsPath), { recursive: true });
    const baseRemoteStat = await this.options.sftp.stat(remotePath, connectionKey);
    await this.options.sftp.downloadFile(remotePath, localUri.fsPath, false, connectionKey);
    const session: SftpEditSession = {
      key,
      connectionKey,
      remotePath,
      localUri,
      baseRemoteStat,
      firstSaveConfirmed: false,
      syncState: 'idle',
      uploadInProgress: false,
      pendingUpload: false,
      uploadTask: undefined,
      debounceTimer: undefined,
      lastError: undefined
    };
    this.sessionsByKey.set(key, session);
    this.sessionsByLocalPath.set(localUri.fsPath, session);
    await this.options.ui.openFile(localUri, remotePath);
    return session;
  }

  async handleSavedDocument(document: Pick<vscode.TextDocument, 'uri'>): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }
    this.scheduleUpload(session);
  }

  async handleClosedDocument(document: Pick<vscode.TextDocument, 'uri'>): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }
    await this.closeSession(session);
  }

  async flushForTest(key: string): Promise<void> {
    const session = this.sessionsByKey.get(key);
    if (!session) {
      return;
    }
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = undefined;
    }
    await this.startUploadDrain(session);
  }

  dispose(): void {
    for (const session of this.sessionsByKey.values()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.sessionsByKey.clear();
    this.sessionsByLocalPath.clear();
  }

  private scheduleUpload(session: SftpEditSession): void {
    session.syncState = 'pending';
    session.pendingUpload = true;
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
    }
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = undefined;
      void this.startUploadDrain(session);
    }, this.debounceMs);
  }

  private startUploadDrain(session: SftpEditSession): Promise<void> {
    if (session.uploadTask) {
      return session.uploadTask;
    }
    const task = this.drainUploadQueue(session).finally(() => {
      if (session.uploadTask === task) {
        session.uploadTask = undefined;
      }
    });
    session.uploadTask = task;
    return task;
  }

  private async drainUploadQueue(session: SftpEditSession): Promise<void> {
    if (session.uploadInProgress) {
      session.pendingUpload = true;
      return;
    }
    while (session.pendingUpload) {
      session.pendingUpload = false;
      if (!session.firstSaveConfirmed) {
        const confirmed = await this.options.ui.confirmAutoSync(session.remotePath);
        if (!confirmed) {
          await this.failSync(session, new Error('Remote sync was not enabled. Save was not uploaded.'));
          return;
        }
        session.firstSaveConfirmed = true;
      }
      session.uploadInProgress = true;
      session.syncState = 'uploading';
      this.options.ui.showStatus('uploading', 'Uploading remote file...');
      try {
        await this.uploadIfUnchanged(session);
        session.syncState = 'idle';
        this.options.ui.showStatus('idle', 'Remote file synced');
      } catch (error) {
        await this.failSync(session, error);
      } finally {
        session.uploadInProgress = false;
      }
    }
  }

  private async uploadIfUnchanged(session: SftpEditSession): Promise<void> {
    const currentRemoteStat = await this.options.sftp.stat(session.remotePath, session.connectionKey);
    if (!remoteStatsMatch(currentRemoteStat, session.baseRemoteStat)) {
      session.syncState = 'conflict';
      this.options.ui.showStatus('conflict', 'Remote file changed');
      const choice = await this.options.ui.resolveConflict(session.remotePath);
      if (choice === 'cancel') {
        throw new Error(`Remote sync cancelled because ${session.remotePath} changed on the server.`);
      }
    }
    await this.options.sftp.uploadFile(session.localUri.fsPath, session.remotePath, session.connectionKey);
    const uploadedStat = await this.options.sftp.stat(session.remotePath, session.connectionKey);
    await this.verifyUploadedContent(session, uploadedStat);
    session.baseRemoteStat = uploadedStat;
  }

  private async verifyUploadedContent(session: SftpEditSession, remoteStat: JumpServerSftpFileStat): Promise<void> {
    const localContent = readFileSync(session.localUri.fsPath);
    if (remoteStat.size !== localContent.byteLength) {
      throw new Error(`Remote sync verification failed for ${session.remotePath}: remote size is ${remoteStat.size} bytes, expected ${localContent.byteLength} bytes.`);
    }
    const remoteContent = await this.options.sftp.readFile(session.remotePath, localContent.byteLength, session.connectionKey);
    if (!remoteContent.equals(localContent)) {
      throw new Error(`Remote sync verification failed for ${session.remotePath}: remote content does not match local edits.`);
    }
  }

  private async closeSession(session: SftpEditSession): Promise<void> {
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = undefined;
      await this.startUploadDrain(session);
    }
    if (session.uploadTask) {
      await session.uploadTask;
    }
    this.sessionsByKey.delete(session.key);
    this.sessionsByLocalPath.delete(session.localUri.fsPath);
    await rm(session.localUri.fsPath, { force: true });
  }

  private async failSync(session: SftpEditSession, error: unknown): Promise<void> {
    session.syncState = 'failed';
    session.lastError = errorMessage(error);
    this.options.ui.showStatus('failed', `Remote sync failed: ${session.lastError}`);
    await this.options.ui.showError(session.remotePath, session.lastError);
  }
}

export function createVscodeSftpEditUi(statusBarItem: vscode.StatusBarItem): SftpEditUi {
  return {
    async openFile(uri, remotePath) {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    },
    async confirmAutoSync(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Enable automatic sync to ${remotePath} for this edit session?`,
        { modal: true },
        'Enable Sync'
      );
      return answer === 'Enable Sync';
    },
    async resolveConflict(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Remote file changed: ${remotePath}`,
        { modal: true },
        'Overwrite Remote',
        'Cancel Upload'
      );
      return answer === 'Overwrite Remote' ? 'overwrite' : 'cancel';
    },
    showStatus(state, message) {
      statusBarItem.text =
        state === 'uploading'
          ? '$(sync~spin) Uploading remote file...'
          : state === 'idle'
            ? '$(check) Remote file synced'
            : state === 'conflict'
              ? '$(warning) Remote file changed'
              : '$(error) Remote sync failed';
      statusBarItem.tooltip = message;
      statusBarItem.show();
      if (state === 'idle') {
        setTimeout(() => statusBarItem.hide(), 2000);
      }
    },
    async showError(remotePath, message) {
      await showTimedNotification(`Remote sync failed for ${remotePath}: ${message}`, 'error');
    },
    async promptUnsyncedClose() {
      return 'discard';
    }
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\sftp\SftpEditSessionManager.ts test\sftp\SftpEditSessionManager.test.ts
git commit -m "feat: add JumpServer SFTP edit sessions"
```

---

### Task 5: Wire Preview And Edit Commands

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\package.json`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\src\extension.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test\extension\ExtensionCommands.test.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\test\package.manifest.test.ts`

- [ ] **Step 1: Write failing manifest and extension tests**

In `test/package.manifest.test.ts`, add these command ids to the expected command list after `jumpserverManager.sftp.download`:

```ts
      'jumpserverManager.sftp.preview',
      'jumpserverManager.sftp.edit',
```

Add assertions:

```ts
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'jumpserverManager.sftp.preview' }),
      expect.objectContaining({ command: 'jumpserverManager.sftp.edit' })
    ]));
    const fileMenus = manifest.contributes.menus['view/item/context'].filter((item: { command: string }) =>
      item.command === 'jumpserverManager.sftp.preview' || item.command === 'jumpserverManager.sftp.edit'
    );
    expect(fileMenus).toHaveLength(2);
    expect(fileMenus.every((item: { when: string }) => item.when.includes('viewItem == jumpserverSftpFile'))).toBe(true);
```

In `test/extension/ExtensionCommands.test.ts`, add registration expectations:

```ts
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.preview', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.edit', expect.any(Function));
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- test/package.manifest.test.ts test/extension/ExtensionCommands.test.ts
```

Expected: FAIL because commands are not registered or contributed.

- [ ] **Step 3: Update manifest**

Add commands in `package.json`:

```json
{
  "command": "jumpserverManager.sftp.preview",
  "title": "JumpServer Files: Preview",
  "icon": "$(open-preview)"
},
{
  "command": "jumpserverManager.sftp.edit",
  "title": "JumpServer Files: Edit",
  "icon": "$(edit)"
}
```

Add file context menu entries:

```json
{
  "command": "jumpserverManager.sftp.preview",
  "when": "view == jumpserverManager.sftpFiles && viewItem == jumpserverSftpFile",
  "group": "inline@2"
},
{
  "command": "jumpserverManager.sftp.edit",
  "when": "view == jumpserverManager.sftpFiles && viewItem == jumpserverSftpFile",
  "group": "inline@3"
}
```

- [ ] **Step 4: Wire extension services and commands**

In `src/extension.ts`, import:

```ts
import { assertTextFileEditable, DEFAULT_SFTP_EDIT_MAX_BYTES } from './sftp/SftpFileGuards';
import { createVscodeSftpEditUi, SftpEditSessionManager } from './sftp/SftpEditSessionManager';
import { JUMPSERVER_SFTP_PREVIEW_SCHEME, openRemotePreviewFile, SftpPreviewDocumentStore } from './sftp/SftpPreview';
```

Inside `activate`, after `sftpTreeProvider`:

```ts
  const sftpPreviewStore = new SftpPreviewDocumentStore();
  const sftpEditStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const sftpEditManager = new SftpEditSessionManager({
    storageUri: context.globalStorageUri ?? context.extensionUri,
    sftp: sftpManager,
    ui: createVscodeSftpEditUi(sftpEditStatus)
  });
```

Add to `context.subscriptions`:

```ts
    sftpEditStatus,
    sftpEditManager,
    vscode.workspace.registerTextDocumentContentProvider(JUMPSERVER_SFTP_PREVIEW_SCHEME, sftpPreviewStore),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      void sftpPreviewStore.deletePreviewFilesForClosedTabs(event.closed);
    }),
```

Register commands:

```ts
    vscode.commands.registerCommand('jumpserverManager.sftp.preview', async (item?: SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        await ensurePreviewEditAllowed(sftpManager, item);
        await openRemotePreviewFile({
          storageUri: context.globalStorageUri ?? context.extensionUri,
          remotePath: item.entry.path,
          previewStore: sftpPreviewStore,
          downloadFile: (remotePath, localPath) => sftpManager.downloadFile(remotePath, localPath, false),
          openUri: async (uri, options) => {
            await vscode.commands.executeCommand('vscode.open', uri, options);
          }
        });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        await ensurePreviewEditAllowed(sftpManager, item);
        await sftpEditManager.openRemoteFile(item.entry.path);
      });
    }),
```

Add helper near existing helpers:

```ts
async function ensurePreviewEditAllowed(
  manager: JumpServerSftpManager,
  item: SftpFileTreeItem
): Promise<void> {
  if (!await ensureSftpAssetOpen(manager)) {
    throw new Error('Open files from a JumpServer asset first.');
  }
  const stat = item.entry.size === undefined
    ? await manager.stat(item.entry.path)
    : { size: item.entry.size, modifiedAt: item.entry.modifiedAt ?? 0 };
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size });
  const sample = await manager.readFile(item.entry.path, Math.min(DEFAULT_SFTP_EDIT_MAX_BYTES, Math.max(stat.size, 1)));
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size, sample });
}
```

If this helper double-downloads before preview, keep it for safety in phase two. The 1 MB limit makes the extra read acceptable, and it avoids opening binary content in VS Code.

- [ ] **Step 5: Run tests to verify pass**

Run:

```powershell
npm test -- test/package.manifest.test.ts test/extension/ExtensionCommands.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add package.json src\extension.ts test\extension\ExtensionCommands.test.ts test\package.manifest.test.ts
git commit -m "feat: wire JumpServer SFTP preview edit commands"
```

---

### Task 6: Update README

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\README.md`

- [ ] **Step 1: Update supported and unsupported sections**

In `README.md`, add supported bullets:

```md
- SFTP preview for small text files
- SFTP edit sessions with first-save sync confirmation and conflict prompts
```

Update unsupported bullets:

```md
- Editing files larger than 1 MB or binary files through the preview/edit workflow
```

Do not list “remote file editing and save-to-upload sync” as unsupported anymore.

- [ ] **Step 2: Update manual verification**

Add manual verification bullets:

```md
- Preview a small text file and confirm it opens read-only.
- Edit a small text file, save once, and confirm the sync prompt appears.
- Enable sync and confirm the file uploads after save.
- Modify the remote file externally and confirm the conflict prompt appears on the next save.
- Try preview/edit on a binary or over-1 MB file and confirm it suggests Download.
```

- [ ] **Step 3: Run README-related checks**

Run:

```powershell
npm test -- test/package.manifest.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```powershell
git add README.md
git commit -m "docs: document JumpServer SFTP preview edit"
```

---

### Task 7: Full Verification And Packaging

**Files:**
- No file edits expected unless verification finds a bug.

- [ ] **Step 1: Run focused SFTP phase-two tests**

Run:

```powershell
npm test -- test/sftp/SftpFileGuards.test.ts test/sftp/SftpPreview.test.ts test/sftp/SftpEditSessionManager.test.ts test/sftp/JumpServerSftpManager.test.ts test/sftp/JumpServerSftpSession.test.ts test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 5: Run real SFTP probe with upload**

Run:

```powershell
$tmp = Join-Path $env:TEMP 'jumpserver-sftp-phase-two-probe.txt'
Set-Content -LiteralPath $tmp -Value 'phase two upload probe' -NoNewline
$env:JUMPSERVER_BASE_URL='https://jms.intimfy.com'
$env:JUMPSERVER_USERNAME='admin'
$env:JUMPSERVER_PASSWORD=$env:JUMPSERVER_PASSWORD
$env:JUMPSERVER_ASSET_ID='0232b60d-dc2f-41c8-b60a-abd4ee2c799c'
$env:JUMPSERVER_SFTP_TEST_PATH='/tmp'
$env:JUMPSERVER_SFTP_UPLOAD_FILE=$tmp
npm run probe:sftp
```

Before running the command, set `JUMPSERVER_PASSWORD` in the current shell from the credential already provided in this thread. Do not write the password into the plan, git history, terminal transcript, or README.

Expected: PASS with `Upload/download/delete verified`.

- [ ] **Step 6: Package VSIX**

Run:

```powershell
npx vsce package --out at-jumpserver-terminal-0.1.1.vsix
```

Expected: PASS and a VSIX at:

```text
C:\Users\alan\Desktop\jumpserver-plugins\.worktrees\jumpserver-sftp-file-management\at-jumpserver-terminal-0.1.1.vsix
```

- [ ] **Step 7: Manual VS Code verification**

Install the VSIX and verify:

- Connect to SFTP-capable asset.
- Files view lists `/tmp`-rooted content.
- Preview small text file.
- Edit small text file.
- First save asks to enable sync.
- Enable sync and confirm upload.
- Save again and confirm upload is automatic.
- Trigger conflict by modifying the remote file outside the edit session and confirm overwrite/cancel prompt.
- Try binary or over-1 MB file and confirm guidance to use Download.
- Switch between two terminals and confirm edit sessions remain scoped correctly.

- [ ] **Step 8: Commit fixes if verification required changes**

If verification required changes, run:

```powershell
git status --short
git add src\sftp\SftpFileGuards.ts src\sftp\SftpPreview.ts src\sftp\SftpEditSessionManager.ts src\sftp\JumpServerSftpManager.ts src\extension.ts package.json README.md test\sftp\SftpFileGuards.test.ts test\sftp\SftpPreview.test.ts test\sftp\SftpEditSessionManager.test.ts test\sftp\JumpServerSftpManager.test.ts test\extension\ExtensionCommands.test.ts test\package.manifest.test.ts test-fixtures\vscode.ts
git commit -m "fix: stabilize JumpServer SFTP preview edit"
```

If no changes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: preview, edit, first-save confirmation, conflict handling, 1 MB guard, binary guard, cache cleanup, extension wiring, docs, and verification are all covered.
- Placeholder scan: no unresolved placeholders remain. The real probe uses `JUMPSERVER_PASSWORD` from the current shell so the secret is not written to the repository.
- Type consistency: plan uses `JumpServerSftpFileStat`, `JumpServerSftpManager`, `SftpFileTreeItem`, `SftpPreviewDocumentStore`, and `SftpEditSessionManager` consistently.
- Scope: plan avoids native SFTP, MCP, agent tools, recursive upload, and bypassing JumpServer KoKo root restrictions.
