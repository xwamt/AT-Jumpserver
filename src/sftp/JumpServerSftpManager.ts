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
    if (!this.active) {
      return { kind: 'none' };
    }
    if (this.active.rootPath) {
      return { kind: 'active', asset: this.active.asset, rootPath: this.active.rootPath };
    }
    if (this.active.snapshot) {
      return { kind: 'disconnected', asset: this.active.asset, ...this.active.snapshot };
    }
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
    if (state.kind !== 'active') {
      throw new Error('No active JumpServer SFTP asset.');
    }
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
    if (!this.active) {
      throw new Error('No active JumpServer SFTP asset.');
    }
    return this.active;
  }

  private async ensureSession(connection: ManagedConnection): Promise<JumpServerSftpSessionLike> {
    if (connection.session) {
      return connection.session;
    }
    const session = await this.options.createSession(connection.asset);
    connection.session = session;
    await session.connect();
    return session;
  }
}
