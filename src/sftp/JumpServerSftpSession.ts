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

/**
 * `ws` queues whatever it is handed. A whole file goes out as one frame, so a
 * second transfer started while the first is still on the wire adds to the same
 * heap rather than waiting for it - and nothing in this class ever asked how
 * much was already outstanding. This caps what one session can pin at the mark
 * plus the frame in flight.
 */
export const SFTP_SEND_HIGH_WATER_BYTES = 8 * 1024 * 1024;

/** `ws` has no drain event, so the queue is sampled instead. */
export const SFTP_DRAIN_POLL_MS = 50;

/**
 * How long a frame may wait for room. Long enough to outlast a genuinely slow
 * transfer over a thin link, short enough that a wedged socket surfaces as a
 * failed transfer rather than a command that never returns.
 */
export const SFTP_DRAIN_TIMEOUT_MS = 120_000;

/**
 * Opening a remote file for edit stats it and then lists its directory within
 * the same interaction; a short-lived cache turns that into one WS round-trip
 * without letting the tree ever show data older than a moment.
 */
export const SFTP_LIST_CACHE_TTL_MS = 1500;

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
  /** When set, binary download chunks are capped so the full file is never buffered. */
  maxBytes?: number;
  keptBytes: number;
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
  private readonly listCache = new Map<string, { at: number; resolvedPath: string; entries: JumpServerSftpEntry[] }>();

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
    return this.listPath(path, { updateCurrentPath: true });
  }

  mkdir(path: string): Promise<void> {
    this.listCache.clear();
    return this.sendCommand('mkdir', { path }).then(() => undefined);
  }

  rename(path: string, newName: string): Promise<void> {
    this.listCache.clear();
    return this.sendCommand('rename', { path, new_name: newName }).then(() => undefined);
  }

  deleteEntry(path: string): Promise<void> {
    this.listCache.clear();
    return this.sendCommand('rm', { path }).then(() => undefined);
  }

  downloadFile(path: string, isDir = false): Promise<Buffer> {
    this.listCache.clear();
    return this.sendCommand('download', { path, is_dir: isDir }).then(({ pending }) => Buffer.concat(pending.chunks));
  }

  uploadBytes(path: string, bytes: Buffer): Promise<void> {
    this.listCache.clear();
    return this.sendCommand(
      'upload',
      { path, size: bytes.byteLength, offSet: 0, chunk: false },
      { id: createKokoUploadId(), raw: encodeSftpRaw(bytes) }
    ).then(() => undefined);
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number }> {
    const parent = path.replace(/\/+[^/]*$/, '') || '/';
    const name = path.split('/').filter(Boolean).pop();
    // Statting a file is a lookup, not a navigation: the parent listing must
    // not become the session's working directory.
    const entries = await this.listPath(parent, { updateCurrentPath: false });
    const entry = entries.find((item) => item.name === name || item.path === path);
    if (!entry) {
      throw new Error(`Remote path not found: ${path}`);
    }
    return { size: entry.size ?? 0, modifiedAt: entry.modifiedAt ?? 0 };
  }

  private async listPath(path: string, options: { updateCurrentPath: boolean }): Promise<JumpServerSftpEntry[]> {
    const cached = this.listCache.get(path);
    if (cached && Date.now() - cached.at <= SFTP_LIST_CACHE_TTL_MS) {
      if (options.updateCurrentPath) {
        this.currentPath = cached.resolvedPath;
      }
      return cached.entries;
    }
    const { message } = await this.sendCommand('list', { path });
    const resolvedPath = message.current_path || path || this.currentPath;
    const entries = normalizeSftpEntries(resolvedPath, JSON.parse(message.data || '[]'));
    this.listCache.set(path, { at: Date.now(), resolvedPath, entries });
    if (options.updateCurrentPath) {
      this.currentPath = resolvedPath;
    }
    return entries;
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    return this.sendCommand('download', { path, is_dir: false }, { maxBytes }).then(({ pending }) =>
      Buffer.concat(pending.chunks)
    );
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
    const id = typeof extra.id === 'string' ? extra.id : randomUUID();
    const { id: _id, maxBytes, ...extraPayload } = extra;
    const payload = { id, type: 'SFTP_DATA', cmd, data: JSON.stringify(data), ...extraPayload };
    return new Promise<ResolvedCommand>((resolve, reject) => {
      const pendingCommand: PendingCommand = {
        cmd,
        chunks: [],
        keptBytes: 0,
        ...(typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
          ? { maxBytes: Math.floor(maxBytes) }
          : {}),
        resolve,
        reject
      };
      this.pending.set(id, pendingCommand);
      this.sendWhenDrained(id, JSON.stringify(payload), 0);
    });
  }

  /**
   * Sends synchronously whenever the socket is keeping up, which is every call
   * on a healthy session; the polling path only exists for the case where it
   * is not.
   */
  private sendWhenDrained(id: string, frame: string, waitedMs: number): void {
    const pending = this.pending.get(id);
    if (!pending || !this.socket) {
      // A close or a dispose already rejected this command while it waited.
      return;
    }
    if (this.socket.bufferedAmount <= SFTP_SEND_HIGH_WATER_BYTES) {
      this.socket.send(frame);
      return;
    }
    if (waitedMs >= SFTP_DRAIN_TIMEOUT_MS) {
      this.pending.delete(id);
      pending.reject(new Error(
        `SFTP transfer stalled: ${this.socket.bufferedAmount} bytes have been queued for ${waitedMs}ms without draining.`
      ));
      return;
    }
    const timer = setTimeout(
      () => this.sendWhenDrained(id, frame, waitedMs + SFTP_DRAIN_POLL_MS),
      SFTP_DRAIN_POLL_MS
    );
    (timer as unknown as { unref?: () => void }).unref?.();
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
      const chunk = decodeSftpRaw(message.raw);
      if (pending.maxBytes !== undefined) {
        const remaining = pending.maxBytes - pending.keptBytes;
        if (remaining <= 0) {
          return;
        }
        if (chunk.byteLength > remaining) {
          pending.chunks.push(chunk.subarray(0, remaining));
          pending.keptBytes = pending.maxBytes;
          return;
        }
        pending.chunks.push(chunk);
        pending.keptBytes += chunk.byteLength;
        return;
      }
      pending.chunks.push(chunk);
      return;
    }
    if (message.type === 'SFTP_DATA') {
      this.pending.delete(id);
      pending.resolve({ message, pending });
    }
  }

  private handleClose(error: Error): void {
    this.connected = false;
    this.listCache.clear();
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

function createKokoUploadId(): string {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
}
