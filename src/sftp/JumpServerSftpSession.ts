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
import type { JumpServerSftpEntry, SftpListDirectoryOptions, SftpUploadProgress } from './SftpTypes';

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

/**
 * One upload frame is `raw` base64 plus JSON framing, so a frame costs roughly
 * 1.4x the chunk in string form. 4 MiB keeps that fixed-size regardless of the
 * file: the old single-frame path built a base64 string of the entire file and
 * then JSON-stringified it again, which is two full copies of a large upload.
 * KoKo's own web UI slices at a comparable size (5-10 MiB).
 */
export const SFTP_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * A download that has to come back as one in-memory Buffer (directory zips via
 * the legacy path) refuses to grow past this instead of concatenating chunks
 * until the extension host dies. File downloads stream to disk and never hit
 * this cap.
 */
export const SFTP_DOWNLOAD_MEMORY_CAP_BYTES = 512 * 1024 * 1024;

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
  /** When set, an in-memory download larger than this rejects instead of growing. */
  memoryCapBytes?: number;
  /** When set, binary chunks are handed here instead of accumulating in `chunks`. */
  sink?: (chunk: Buffer) => void | Promise<void>;
  /** Serializes async sink writes so chunks land in arrival order. */
  sinkChain?: Promise<void>;
  sinkError?: Error;
  resolve(value: ResolvedCommand): void;
  reject(error: Error): void;
}

interface ResolvedCommand {
  message: KokoSftpMessage;
  pending: PendingCommand;
}

interface SendCommandOptions {
  id?: string;
  raw?: string;
  maxBytes?: number;
  memoryCapBytes?: number;
  sink?: (chunk: Buffer) => void | Promise<void>;
}

export class JumpServerSftpSession {
  private socket: KokoWebSocket | undefined;
  private connected = false;
  private disposed = false;
  private connectResolver: (() => void) | undefined;
  private connectRejecter: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  private currentPath = '/';
  private readonly listCache = new Map<string, { at: number; resolvedPath: string; entries: JumpServerSftpEntry[] }>();
  /**
   * KoKo's webSftp handler runs every incoming message on its own goroutine,
   * so two commands in flight can execute in either order server-side. The
   * tail serializes whole commands; the frames of one command (chunked
   * uploads, streamed downloads) still interleave freely under a single id.
   */
  private queueTail: Promise<void> = Promise.resolve();
  private queueIdle = true;

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
    this.throwIfDisposedDuringConnect();
    const socket = await this.input.client.openKokoSftpWebSocket({ endpoint, tokenId: token.id });
    if (this.disposed) {
      // dispose() ran while the handshake was in flight and had no socket to
      // close; the one that just arrived is ours to kill or it leaks.
      closeSocketNow(socket);
      this.throwIfDisposedDuringConnect();
    }
    this.socket = socket;
    this.bindSocket(socket);
    await new Promise<void>((resolve, reject) => {
      this.connectResolver = resolve;
      this.connectRejecter = reject;
    });
  }

  private throwIfDisposedDuringConnect(): void {
    if (this.disposed) {
      throw new Error('SFTP session was disposed before the connection was established.');
    }
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

  listDirectory(path: string, options?: SftpListDirectoryOptions): Promise<JumpServerSftpEntry[]> {
    return this.listPath(path, {
      updateCurrentPath: options?.updateCurrentPath ?? true,
      bypassCache: options?.bypassCache ?? false
    });
  }

  /** Explicit Refresh drops every cached listing; mutations do the same implicitly. */
  invalidateListCache(): void {
    this.listCache.clear();
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

  /** Reading a file changes nothing remotely, so cached listings stay valid. */
  downloadFile(path: string, isDir = false, memoryCapBytes = SFTP_DOWNLOAD_MEMORY_CAP_BYTES): Promise<Buffer> {
    return this.sendCommand('download', { path, is_dir: isDir }, { memoryCapBytes })
      .then(({ pending }) => Buffer.concat(pending.chunks));
  }

  /** Streams every binary chunk to `write` in arrival order instead of buffering the file. */
  downloadFileToWriter(path: string, isDir: boolean, write: (chunk: Buffer) => void | Promise<void>): Promise<void> {
    return this.sendCommand('download', { path, is_dir: isDir }, { sink: write }).then(() => undefined);
  }

  uploadBytes(path: string, bytes: Buffer, onProgress?: SftpUploadProgress): Promise<void> {
    this.listCache.clear();
    const totalBytes = bytes.byteLength;
    if (totalBytes <= SFTP_UPLOAD_CHUNK_BYTES) {
      return this.sendCommand(
        'upload',
        { path, size: totalBytes, offSet: 0, chunk: false },
        { id: createKokoUploadId(), raw: encodeSftpRaw(bytes) }
      ).then(() => {
        onProgress?.(totalBytes, totalBytes);
      });
    }
    // KoKo keeps one write handle per numeric upload id: every slice goes out
    // as `chunk: true` at its offset and a final `merge: true` frame closes
    // the handle. A closing slice sent with `chunk: false` would instead
    // re-create the file and truncate everything already written. Each slice
    // is acked with an SFTP_DATA frame before the next goes out, so a failed
    // slice stops the transfer instead of writing past a hole.
    const id = createKokoUploadId();
    return this.enqueue(async () => {
      for (let offset = 0; offset < totalBytes; offset += SFTP_UPLOAD_CHUNK_BYTES) {
        const end = Math.min(offset + SFTP_UPLOAD_CHUNK_BYTES, totalBytes);
        await this.dispatchCommand(
          'upload',
          { path, size: totalBytes, offSet: offset, chunk: true },
          { id, raw: encodeSftpRaw(bytes.subarray(offset, end)) }
        );
        onProgress?.(end, totalBytes);
      }
      await this.dispatchCommand('upload', { path, size: 0, offSet: 0, merge: true }, { id, raw: '' });
    }).then(() => undefined);
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number }> {
    const parent = path.replace(/\/+[^/]*$/, '') || '/';
    const name = path.split('/').filter(Boolean).pop();
    // Statting a file is a lookup, not a navigation: the parent listing must
    // not become the session's working directory.
    const entries = await this.listPath(parent, { updateCurrentPath: false, bypassCache: false });
    const entry = entries.find((item) => item.name === name || item.path === path);
    if (!entry) {
      throw new Error(`Remote path not found: ${path}`);
    }
    return { size: entry.size ?? 0, modifiedAt: entry.modifiedAt ?? 0 };
  }

  private async listPath(path: string, options: { updateCurrentPath: boolean; bypassCache: boolean }): Promise<JumpServerSftpEntry[]> {
    if (!options.bypassCache) {
      const cached = this.listCache.get(path);
      if (cached && Date.now() - cached.at <= SFTP_LIST_CACHE_TTL_MS) {
        if (options.updateCurrentPath) {
          this.currentPath = cached.resolvedPath;
        }
        return cached.entries;
      }
    }
    const { message } = await this.sendCommand('list', { path });
    const resolvedPath = message.current_path || path || this.currentPath;
    const entries = normalizeSftpEntries(resolvedPath, JSON.parse(message.data || '[]'));
    const cacheEntry = { at: Date.now(), resolvedPath, entries };
    this.listCache.set(path, cacheEntry);
    if (resolvedPath !== path) {
      // KoKo answers with the resolved absolute path ('.' or a symlink may
      // differ from what was asked); a follow-up by that name is the same
      // listing and must hit the same entry.
      this.listCache.set(resolvedPath, cacheEntry);
    }
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
    this.disposed = true;
    const rejectConnect = this.connectRejecter;
    this.connectResolver = undefined;
    this.connectRejecter = undefined;
    rejectConnect?.(new Error('SFTP session disposed.'));
    this.rejectAll(new Error('SFTP session disposed.'));
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) {
      closeSocketNow(socket);
    }
  }

  private sendCommand(cmd: SftpCommand, data: Record<string, unknown>, options: SendCommandOptions = {}): Promise<ResolvedCommand> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('SFTP connection is not available.'));
    }
    return this.enqueue(() => this.dispatchCommand(cmd, data, options));
  }

  /**
   * Runs `task` after every previously accepted command has settled. An idle
   * queue dispatches synchronously so a healthy session never pays a tick.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queueIdle ? task() : this.queueTail.then(task);
    this.queueIdle = false;
    const tail: Promise<void> = result.then(swallow, swallow).then(() => {
      if (this.queueTail === tail) {
        this.queueIdle = true;
      }
    });
    this.queueTail = tail;
    return result;
  }

  private dispatchCommand(cmd: SftpCommand, data: Record<string, unknown>, options: SendCommandOptions): Promise<ResolvedCommand> {
    if (!this.socket || !this.connected) {
      // The session may have closed while this command sat in the queue.
      return Promise.reject(new Error('SFTP connection is not available.'));
    }
    const { id = randomUUID(), raw, maxBytes, memoryCapBytes, sink } = options;
    const payload = { id, type: 'SFTP_DATA', cmd, data: JSON.stringify(data), ...(raw === undefined ? {} : { raw }) };
    return new Promise<ResolvedCommand>((resolve, reject) => {
      const pendingCommand: PendingCommand = {
        cmd,
        chunks: [],
        keptBytes: 0,
        ...(typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
          ? { maxBytes: Math.floor(maxBytes) }
          : {}),
        ...(typeof memoryCapBytes === 'number' && Number.isFinite(memoryCapBytes) && memoryCapBytes > 0
          ? { memoryCapBytes: Math.floor(memoryCapBytes) }
          : {}),
        ...(sink ? { sink } : {}),
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
      const sink = pending.sink;
      if (sink) {
        pending.sinkChain = (pending.sinkChain ?? Promise.resolve())
          .then(async () => {
            if (!pending.sinkError) {
              await sink(chunk);
            }
          })
          .catch((error) => {
            // First failure wins; later chunks are skipped above and the
            // command rejects once the final SFTP_DATA frame arrives.
            pending.sinkError = pending.sinkError ?? (error instanceof Error ? error : new Error(String(error)));
          });
        return;
      }
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
      pending.keptBytes += chunk.byteLength;
      if (pending.memoryCapBytes !== undefined && pending.keptBytes > pending.memoryCapBytes) {
        this.pending.delete(id);
        pending.reject(new Error(
          `Download exceeded the ${pending.memoryCapBytes}-byte in-memory limit. ` +
          'Download it to a file instead of buffering it.'
        ));
        return;
      }
      pending.chunks.push(chunk);
      return;
    }
    if (message.type === 'SFTP_DATA') {
      this.pending.delete(id);
      const sinkChain = pending.sinkChain;
      if (sinkChain) {
        void sinkChain.then(() => {
          if (pending.sinkError) {
            pending.reject(pending.sinkError);
          } else {
            pending.resolve({ message, pending });
          }
        });
      } else {
        pending.resolve({ message, pending });
      }
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

function swallow(): void {
  // Queue bookkeeping only; the command's own promise carries the outcome.
}

/**
 * `terminate()` frees a mid-handshake socket immediately; `close()` on such a
 * peer waits for a close frame that may never come. Test doubles without
 * terminate() fall back to close().
 */
function closeSocketNow(socket: KokoWebSocket): void {
  if (typeof (socket as { terminate?: unknown }).terminate === 'function') {
    socket.terminate();
  } else {
    socket.close();
  }
}
