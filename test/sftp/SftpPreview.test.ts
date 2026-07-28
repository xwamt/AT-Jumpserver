import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  JUMPSERVER_SFTP_PREVIEW_SCHEME,
  openRemotePreviewFile,
  safePreviewDocumentName,
  SftpPreviewDocumentStore
} from '../../src/sftp/SftpPreview';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('SftpPreviewDocumentStore', () => {
  it('creates safe readonly URIs and serves cached text content', async () => {
    const cacheDir = join(process.cwd(), '.tmp-preview-test');
    cleanupPaths.push(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    const localPath = join(cacheDir, 'app.conf');
    await writeFile(localPath, 'PORT=8080\n');
    const store = new SftpPreviewDocumentStore();

    const uri = store.createReadonlyUri('/tmp/app.conf', localPath);

    expect(uri.scheme).toBe(JUMPSERVER_SFTP_PREVIEW_SCHEME);
    await expect(store.provideTextDocumentContent(uri)).resolves.toBe('PORT=8080\n');
  });

  it('downloads and opens a remote preview file', async () => {
    const storagePath = join(process.cwd(), '.tmp-preview-open');
    cleanupPaths.push(storagePath);
    const storageUri = vscode.Uri.file(storagePath);
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
