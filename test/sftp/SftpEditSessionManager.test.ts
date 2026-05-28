import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildEditSessionKey,
  createEditCacheUri,
  remoteStatsMatch,
  SftpEditSessionManager
} from '../../src/sftp/SftpEditSessionManager';

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function sftpClient() {
  return {
    getActiveConnectionKey: vi.fn(() => 'terminal-1'),
    stat: vi.fn(async () => ({ size: 5, modifiedAt: 100 })),
    readFile: vi.fn(async () => Buffer.from('hello')),
    downloadFile: vi.fn(async (_remote: string, local: string) => {
      await mkdir(join(local, '..'), { recursive: true });
      await writeFile(local, 'hello');
    }),
    uploadFile: vi.fn(async () => undefined)
  };
}

function ui() {
  return {
    openFile: vi.fn(async () => undefined),
    confirmAutoSync: vi.fn(async () => true),
    resolveConflict: vi.fn(async (): Promise<'overwrite' | 'cancel'> => 'overwrite'),
    showStatus: vi.fn(),
    showError: vi.fn(async () => undefined),
    promptUnsyncedClose: vi.fn(async () => 'discard' as const)
  };
}

describe('SftpEditSessionManager', () => {
  it('builds stable session keys and cache paths', () => {
    const storageUri = vscode.Uri.file('cache-root');

    expect(buildEditSessionKey('terminal-1', '/tmp/app.conf')).toBe('terminal-1:/tmp/app.conf');
    expect(createEditCacheUri(storageUri, 'terminal-1', '/tmp/app.conf').fsPath).toContain('sftp-edit');
    expect(remoteStatsMatch({ size: 1, modifiedAt: 2 }, { size: 1, modifiedAt: 2 })).toBe(true);
    expect(remoteStatsMatch({ size: 1, modifiedAt: 3 }, { size: 1, modifiedAt: 2 })).toBe(false);
  });

  it('opens an existing session instead of creating a duplicate cache', async () => {
    const storagePath = join(process.cwd(), '.tmp-edit-existing');
    cleanupPaths.push(storagePath);
    const client = sftpClient();
    const view = ui();
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(storagePath),
      sftp: client,
      ui: view,
      debounceMs: 1
    });

    const first = await manager.openRemoteFile('/tmp/app.conf');
    const second = await manager.openRemoteFile('/tmp/app.conf');

    expect(second).toBe(first);
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(view.openFile).toHaveBeenCalledTimes(2);
  });

  it('asks on first save and uploads after sync is enabled', async () => {
    const storagePath = join(process.cwd(), '.tmp-edit-upload');
    cleanupPaths.push(storagePath);
    const client = sftpClient();
    const view = ui();
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(storagePath),
      sftp: client,
      ui: view,
      debounceMs: 1
    });
    const session = await manager.openRemoteFile('/tmp/app.conf');

    await writeFile(session.localUri.fsPath, 'hello');
    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.flushForTest(session.key);

    expect(view.confirmAutoSync).toHaveBeenCalledWith('/tmp/app.conf');
    expect(client.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/tmp/app.conf', 'terminal-1');
    await expect(readFile(session.localUri.fsPath, 'utf8')).resolves.toBe('hello');
  });

  it('does not upload when first-save sync is cancelled', async () => {
    const storagePath = join(process.cwd(), '.tmp-edit-cancel');
    cleanupPaths.push(storagePath);
    const client = sftpClient();
    const view = ui();
    view.confirmAutoSync.mockResolvedValueOnce(false);
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(storagePath),
      sftp: client,
      ui: view,
      debounceMs: 1
    });
    const session = await manager.openRemoteFile('/tmp/app.conf');

    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.flushForTest(session.key);

    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(view.showError).toHaveBeenCalledWith('/tmp/app.conf', expect.stringContaining('not enabled'));
  });

  it('detects remote conflicts and cancels upload when requested', async () => {
    const storagePath = join(process.cwd(), '.tmp-edit-conflict-cancel');
    cleanupPaths.push(storagePath);
    const client = sftpClient();
    client.stat
      .mockResolvedValueOnce({ size: 5, modifiedAt: 100 })
      .mockResolvedValueOnce({ size: 7, modifiedAt: 200 });
    const view = ui();
    view.resolveConflict.mockResolvedValueOnce('cancel');
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(storagePath),
      sftp: client,
      ui: view,
      debounceMs: 1
    });
    const session = await manager.openRemoteFile('/tmp/app.conf');

    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.flushForTest(session.key);

    expect(view.resolveConflict).toHaveBeenCalledWith('/tmp/app.conf');
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('overwrites remote conflicts and updates the base stat', async () => {
    const storagePath = join(process.cwd(), '.tmp-edit-conflict-overwrite');
    cleanupPaths.push(storagePath);
    const client = sftpClient();
    client.stat
      .mockResolvedValueOnce({ size: 5, modifiedAt: 100 })
      .mockResolvedValueOnce({ size: 9, modifiedAt: 200 })
      .mockResolvedValueOnce({ size: 5, modifiedAt: 300 });
    const view = ui();
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(storagePath),
      sftp: client,
      ui: view,
      debounceMs: 1
    });
    const session = await manager.openRemoteFile('/tmp/app.conf');

    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.flushForTest(session.key);

    expect(view.resolveConflict).toHaveBeenCalledWith('/tmp/app.conf');
    expect(client.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/tmp/app.conf', 'terminal-1');
    expect(session.baseRemoteStat).toEqual({ size: 5, modifiedAt: 300 });
  });

  it('flushes pending upload and deletes cache on close', async () => {
    const storagePath = join(process.cwd(), '.tmp-edit-close');
    cleanupPaths.push(storagePath);
    const client = sftpClient();
    const view = ui();
    const manager = new SftpEditSessionManager({
      storageUri: vscode.Uri.file(storagePath),
      sftp: client,
      ui: view,
      debounceMs: 1000
    });
    const session = await manager.openRemoteFile('/tmp/app.conf');

    await manager.handleSavedDocument({ uri: session.localUri });
    await manager.handleClosedDocument({ uri: session.localUri });

    expect(client.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/tmp/app.conf', 'terminal-1');
    await expect(readFile(session.localUri.fsPath)).rejects.toThrow();
  });
});
