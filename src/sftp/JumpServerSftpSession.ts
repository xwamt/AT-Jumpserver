import { randomUUID } from 'node:crypto';
import { extractProtocolNames, resolveFirstUsableAccount, type KokoWebSocket } from '../jumpserver/JumpServerClient';
import type { JumpServerConnectionProtocol } from '../jumpserver/types';
import {
  decodeSftpRaw,
  encodeSftpRaw,
  normalizeSftpEntries,
  parseSftpMessage,
  type KokoSftpMessage,
  type SftpCommand
} from './SftpProtocol';
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
  resolve(value: ResolvedCommand): void;
  reject(error: Error): void;
}

interface ResolvedCommand {
  message: KokoSftpMessage;
  pending: PendingCommand;
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
    await this.listDirectory(path);
    return this.currentPath || path;
  }

  listDirectory(path: string): Promise<JumpServerSftpEntry[]> {
    return this.sendCommand('list', { path }).then(({ message }) => {
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
    return this.sendCommand('download', { path, is_dir: isDir }).then(({ pending }) => Buffer.concat(pending.chunks));
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

  private sendCommand(cmd: SftpCommand, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<ResolvedCommand> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('SFTP connection is not available.'));
    }
    const id = randomUUID();
    const payload = { id, type: 'SFTP_DATA', cmd, data: JSON.stringify(data), ...extra };
    return new Promise<ResolvedCommand>((resolve, reject) => {
      const pendingCommand: PendingCommand = { cmd, chunks: [], resolve, reject };
      this.pending.set(id, pendingCommand);
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
      pending.resolve({ message, pending });
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
