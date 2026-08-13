import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { formatError } from '../utils/errors';
import { showTimedNotification } from '../utils/notifications';
import { remoteBasename } from './RemotePath';
import type { JumpServerSftpFileStat } from './SftpTypes';

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

export interface SftpEditSessionManagerOptions {
  storageUri: vscode.Uri;
  sftp: JumpServerSftpEditClient;
  ui: SftpEditUi;
  debounceMs?: number;
}

export function buildEditSessionKey(connectionKey: string, remotePath: string): string {
  return `${connectionKey}:${remotePath}`;
}

export function createEditCacheUri(storageUri: vscode.Uri, connectionKey: string, remotePath: string): vscode.Uri {
  const hash = createHash('sha256').update(remotePath).digest('hex').slice(0, 16);
  return vscode.Uri.joinPath(storageUri, 'sftp-edit', safeCacheSegment(connectionKey), hash, safeCacheSegment(remotePath));
}

export function remoteStatsMatch(left: JumpServerSftpFileStat, right: JumpServerSftpFileStat): boolean {
  return left.size === right.size && left.modifiedAt === right.modifiedAt;
}

export class SftpEditSessionManager {
  private readonly sessionsByKey = new Map<string, SftpEditSession>();
  private readonly sessionsByLocalPath = new Map<string, SftpEditSession>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly debounceMs: number;

  constructor(private readonly options: SftpEditSessionManagerOptions) {
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

  getSessionByLocalPath(localPath: string): SftpEditSession | undefined {
    return this.sessionsByLocalPath.get(localPath);
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
      session.lastError = undefined;
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
      session.syncState = 'uploading';
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
    session.lastError = formatError(error);
    this.options.ui.showStatus('failed', `Remote sync failed: ${session.lastError}`);
    await this.options.ui.showError(session.remotePath, session.lastError);
  }
}

export function createVscodeSftpEditUi(statusBarItem: vscode.StatusBarItem): SftpEditUi {
  return {
    async openFile(uri, remotePath) {
      const document = await vscode.workspace.openTextDocument(uri);
      const languageId = inferLanguageId(remotePath);
      const visibleDocument =
        languageId && document.languageId === 'plaintext'
          ? await vscode.languages.setTextDocumentLanguage(document, languageId)
          : document;
      await vscode.window.showTextDocument(visibleDocument, { preview: false });
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
      showTimedNotification(`Remote sync failed for ${remotePath}: ${message}`, 'error');
    },
    async promptUnsyncedClose() {
      return 'discard';
    }
  };
}

function safeCacheSegment(value: string): string {
  return remoteBasename(value)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/g, '') || 'remote-file';
}

function inferLanguageId(remotePath: string): string | undefined {
  const lowerName = safeCacheSegment(remotePath).toLowerCase();
  if (lowerName === 'dockerfile' || lowerName.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (lowerName === 'makefile') {
    return 'makefile';
  }

  const extension = lowerName.match(/\.([^.]+)$/)?.[1];
  if (!extension) {
    return undefined;
  }

  const languagesByExtension: Record<string, string> = {
    bash: 'shellscript',
    c: 'c',
    conf: 'properties',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    ini: 'ini',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascriptreact',
    md: 'markdown',
    php: 'php',
    ps1: 'powershell',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'shellscript',
    sql: 'sql',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'typescriptreact',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'shellscript'
  };
  return languagesByExtension[extension];
}
