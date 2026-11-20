import { randomUUID } from 'node:crypto';
import { t } from '../i18n/t';
import { UserVisibleError } from '../utils/errors';
import { log } from '../utils/logger';
import { extractProtocolNames, resolveUsableAccounts, type KokoWebSocket } from './JumpServerClient';
import { connectionKindLabel, connectionKindProtocol, type JumpServerConnectionKind } from './connectionTypes';
import type { JumpServerAccountRef, JumpServerConnectionProtocol, TerminalEvents } from './types';
import { selectConnectMethod, type ConnectMethod } from './connectMethods';
import { detectKokoCapabilities, isKokoCookieLess } from './kokoCapability';

/**
 * How often the client pings KoKo once the socket is bound. A bastion sits
 * behind at least one proxy, and 60s is the usual idle cut-off in those; 20s
 * fits three attempts inside that window, so a single dropped frame is not
 * enough to condemn a healthy session.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * How long one ping may go unanswered. Matched to the WebSocket handshake
 * budget in `DEFAULT_JUMPSERVER_TIMEOUTS`: a bastion that cannot echo a control
 * frame in the time it is allowed to complete a whole handshake is not going to.
 */
export const HEARTBEAT_TIMEOUT_MS = 15_000;

/**
 * Refuse to hand `ws` more terminal input once this much is already queued.
 * Interactive input is keystrokes and agent commands - kilobytes - so a megabyte
 * of undrained queue does not mean "busy", it means the socket has stopped
 * moving and every further write is just heap the user will never get back.
 */
export const TERMINAL_SEND_HIGH_WATER_BYTES = 1024 * 1024;

export interface JumpServerSessionAsset {
  id: string;
  name: string;
  bastionId?: string;
}

export interface JumpServerSessionClient {
  getAssetDetail(assetId: string): Promise<Record<string, any>>;
  createConnectionToken(input: {
    assetId: string;
    account: JumpServerAccountRef;
    protocol: JumpServerConnectionProtocol;
    connectMethod?: string;
  }): Promise<{ id: string; personalCredentialId?: string }>;
  getSmartEndpoint(tokenId: string): Promise<Record<string, any>>;
  getSmartEndpointForAsset?(assetId: string): Promise<Record<string, any>>;
  ensureWebSession?(): Promise<void>;
  hasWebSession?(): boolean;
  lastKokoWarmupMs?(): number;
  openKokoWebSocket(input: {
    endpoint: Record<string, any>;
    tokenId: string;
    cols: number;
    rows: number;
  }): Promise<KokoWebSocket>;
  getConnectMethods?(protocol?: string): Promise<Record<string, ConnectMethod[]>>;
  markTokenReusable?(tokenId: string): Promise<boolean>;
  getClientVersions?(): Promise<string[]>;
  getBaseUrl?(): string;
}

export class JumpServerSession {
  private socket: KokoWebSocket | undefined;
  private rows = 24;
  private cols = 80;
  private connected = false;
  /**
   * Why this session can no longer carry traffic, or undefined while it can.
   * Writes read it so a caller - an MCP agent above all - gets told, instead of
   * having its bytes accepted by a socket nobody is listening on.
   */
  private unavailableReason: string | undefined;
  /**
   * Whether a `Disconnected ...` status already went out. A heartbeat timeout
   * terminates the socket itself, and that raises the very `close` event whose
   * handler would otherwise report the same loss a second time.
   */
  private disconnectReported = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set by dispose(). A connect() still awaiting a token or a handshake at
   * that moment must not bind - or worse, leak - whatever arrives afterwards.
   */
  private disposed = false;

  constructor(private readonly input: {
    asset: JumpServerSessionAsset;
    connectionKind: JumpServerConnectionKind;
    client: JumpServerSessionClient;
    events: TerminalEvents;
    onTokenReady?(tokenId: string, info?: { reusable: boolean; kind?: string }): void;
    selectAccount?(accounts: JumpServerAccountRef[], asset: JumpServerSessionAsset): Promise<JumpServerAccountRef | undefined>;
    resolveInputAccount?(asset: JumpServerSessionAsset): Promise<{ username: string; password?: string } | undefined>;
  }) {}

  async connect(): Promise<void> {
    const started = Date.now();
    const timings = { detail: 0, token: 0, endpoint: 0, ws: 0 };
    let wsAttempted = false;
    try {
      this.input.events.status(t('Loading asset'), 'connecting');
      const client = this.input.client;
      // The Django form login KoKo cookies come from needs no token and no
      // asset detail, so it overlaps the whole REST leg below. A failure is
      // ignored here: openKokoWebSocket still has its own warmup fallback.
      if (typeof client.ensureWebSession === 'function') {
        const cached = isKokoCookieLess(this.input.asset.bastionId);
        if (cached === true) {
          // Detected as 5.0 cookie-less: do not initiate web session form login
        } else if (cached === false || typeof client.getClientVersions !== 'function') {
          // Known legacy (or mock client without capability probe): fire-and-forget
          client.ensureWebSession().catch(() => undefined);
        } else {
          // Probe capability; only warm web session if not cookie-less
          detectKokoCapabilities(client as any, this.input.asset.bastionId)
            .then((caps) => {
              if (!caps.cookieLess && !this.disposed) {
                client.ensureWebSession?.().catch(() => undefined);
              }
            })
            .catch(() => undefined);
        }
      }

      // Parallelize connect-methods query with getAssetDetail to save a serial REST round-trip (P1-1)
      const connectMethodsPromise = typeof client.getConnectMethods === 'function'
        ? client.getConnectMethods().catch(() => undefined)
        : undefined;

      const detail = await step(() => client.getAssetDetail(this.input.asset.id), (ms) => {
        timings.detail = ms;
      });
      if (this.disposed) {
        return;
      }
      const protocolNames = extractProtocolNames(detail).map((name) => name.toLowerCase());
      let protocol = connectionKindProtocol(this.input.connectionKind);
      if (!protocolNames.includes(protocol)) {
        if (protocol === 'mysql' && protocolNames.includes('mariadb')) {
          protocol = 'mariadb' as JumpServerConnectionProtocol;
        } else if ((protocol === 'k8s' || protocol === 'kubernetes') && (protocolNames.includes('k8s') || protocolNames.includes('kubernetes'))) {
          protocol = (protocolNames.includes('k8s') ? 'k8s' : 'kubernetes') as JumpServerConnectionProtocol;
        } else {
          throw new Error(`Selected asset does not expose ${connectionKindLabel(this.input.connectionKind)} protocol.`);
        }
      }
      const accounts = resolveUsableAccounts(detail);
      if (accounts.length === 0) {
        throw new Error('No usable JumpServer account was returned for this asset.');
      }
      let account = accounts[0];
      if (accounts.length > 1 && typeof this.input.selectAccount === 'function') {
        const chosen = await this.input.selectAccount(accounts, this.input.asset);
        if (!chosen) {
          throw new UserVisibleError(t('Account selection was cancelled.'));
        }
        account = chosen;
      }
      if (account.kind === 'alias' && account.alias === '@INPUT' && typeof this.input.resolveInputAccount === 'function') {
        const credentials = await this.input.resolveInputAccount(this.input.asset);
        if (credentials) {
          account.inputUsername = credentials.username;
          account.inputSecret = credentials.password;
        }
      }

      let connectMethod: string | undefined;
      const methodsDict = connectMethodsPromise ? await connectMethodsPromise : undefined;
      if (methodsDict) {
        try {
          const preferred = (protocol === 'mysql' || protocol === 'redis') ? 'db_client' : 'web_cli';
          const selected = selectConnectMethod(methodsDict, { protocol, preferred });
          if (selected) {
            if (selected.type === 'web' || selected.value === 'db_client') {
              connectMethod = selected.value;
            } else if (selected.type === 'native') {
              throw new Error(
                `Connection method '${selected.value}' (${selected.label}) requires a native client, which is not supported in the embedded terminal.`
              );
            } else if (selected.type === 'applet' || selected.type === 'virtual_app') {
              throw new Error(
                `Connection method '${selected.value}' (${selected.label}) requires ${selected.type}, which is not supported in the embedded terminal.`
              );
            } else {
              connectMethod = selected.value;
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('not supported in the embedded terminal')) {
            throw error;
          }
          log.warn(`connect-methods query failed; falling back to protocol heuristics: ${String(error)}`);
        }
      }

      this.input.events.status(t('Creating connection token'), 'connecting');
      const tokenPromise = step(() => client.createConnectionToken({
        assetId: this.input.asset.id,
        account,
        protocol,
        ...(connectMethod ? { connectMethod } : {})
      }), (ms) => {
        timings.token = ms;
      });
      const endpointPromise = step(() => this.resolveEndpoint(tokenPromise), (ms) => {
        timings.endpoint = ms;
      });
      // Whichever of the pair loses the race must not surface as an unhandled
      // rejection while the other one is still being awaited.
      const token = await tokenPromise;
      if (!token.personalCredentialId && typeof client.markTokenReusable === 'function') {
        client.markTokenReusable(token.id)
          .then((isReusable) => {
            if (!this.disposed) {
              this.input.onTokenReady?.(token.id, { reusable: Boolean(isReusable), kind: this.input.connectionKind });
            }
          })
          .catch(() => {
            if (!this.disposed) {
              this.input.onTokenReady?.(token.id, { reusable: false, kind: this.input.connectionKind });
            }
          });
      }
      const endpoint = await endpointPromise;
      if (this.disposed) {
        return;
      }

      this.input.events.status(t('Opening KoKo terminal'), 'connecting');
      wsAttempted = true;
      const socket = await step(() => client.openKokoWebSocket({
        endpoint,
        tokenId: token.id,
        cols: this.cols,
        rows: this.rows
      }), (ms) => {
        timings.ws = ms;
      });
      if (this.disposed) {
        // The panel closed while the handshake was in flight. Unbound, this
        // socket would otherwise sit open against KoKo forever.
        discardSocket(socket);
        return;
      }
      this.socket = socket;
      this.bindSocket(socket);
      log.info(`KoKo terminal connect for ${this.input.asset.name} finished in ${Date.now() - started}ms`);
    } finally {
      const warmup = wsAttempted && typeof this.input.client.lastKokoWarmupMs === 'function'
        ? this.input.client.lastKokoWarmupMs()
        : 0;
      // Durations only. Token ids, URLs and cookies must never reach the log.
      // The field is `tokenPost`, not `token`: the log redactor masks every
      // `token=<value>` pair, and it would eat the duration along with it.
      log.info(
        `connect timings: detail=${timings.detail}ms tokenPost=${timings.token}ms endpoint=${timings.endpoint}ms ` +
          `warmup=${warmup}ms ws=${Math.max(0, timings.ws - warmup)}ms total=${Date.now() - started}ms`
      );
    }
  }

  /**
   * The smart endpoint keyed by asset id when the client supports it, so the
   * lookup runs while the token POST is still in flight; the token-based
   * lookup remains both the fallback for a 4xx (older cores do not accept
   * `asset_id`) and the only path for clients that predate the new method.
   */
  private async resolveEndpoint(tokenPromise: Promise<{ id: string }>): Promise<Record<string, any>> {
    const client = this.input.client;
    if (typeof client.getSmartEndpointForAsset === 'function') {
      try {
        return await client.getSmartEndpointForAsset(this.input.asset.id);
      } catch {
        log.info('KoKo smart endpoint by asset id failed; falling back to the token-based lookup');
      }
    }
    const token = await tokenPromise;
    return client.getSmartEndpoint(token.id);
  }

  /**
   * Throws rather than dropping the bytes. Silence here is the worst outcome
   * available: an agent that gets no error assumes its command is running and
   * goes on to wait for output that can never arrive.
   */
  write(data: string): void {
    const socket = this.requireUsableSocket();
    const queued = socket.bufferedAmount;
    if (queued > TERMINAL_SEND_HIGH_WATER_BYTES) {
      throw new UserVisibleError(
        `JumpServer terminal is not draining: ${queued} bytes are still queued for ${this.input.asset.name}.`
      );
    }
    socket.send(JSON.stringify({ id: '', type: 'TERMINAL_DATA', data }));
  }

  /**
   * Unlike `write`, a no-op. Resizing is a hint the webview repeats on every
   * layout change; failing it would turn a cosmetic mismatch into an error the
   * user has to dismiss, and there is no message to lose.
   */
  resize(rows: number, cols: number): void {
    if (rows <= 0 || cols <= 0 || this.unavailableReason) {
      return;
    }
    this.rows = rows;
    this.cols = cols;
    if (!this.socket) {
      return;
    }
    this.socket.send(JSON.stringify({
      id: '',
      type: 'TERMINAL_RESIZE',
      data: JSON.stringify({ cols, rows })
    }));
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.markUnavailable('the session was closed locally');
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  private bindSocket(socket: KokoWebSocket): void {
    socket.on('message', (message: Buffer | string, isBinary?: boolean) => {
      this.handleSocketMessage(message, Boolean(isBinary));
    });
    socket.on('close', (code?: number, reason?: Buffer | string) => {
      this.stopHeartbeat();
      this.connected = false;
      const rawStatus = formatRawSocketCloseStatus(code, reason);
      const status = formatSocketCloseStatus(code, reason);
      this.markUnavailable(rawStatus.toLowerCase());
      if (!this.disconnectReported) {
        this.disconnectReported = true;
        log.info(`KoKo terminal for ${this.input.asset.name}: ${rawStatus}`);
        this.input.events.status(status, 'disconnected');
      }
    });
    socket.on('error', (error) => this.input.events.error(error));
    socket.on('pong', () => this.clearPongDeadline());
    // The panel calls itself connected as soon as `connect()` resolves, which is
    // here - so this is exactly the window in which a half-open socket can show
    // "Connected" while the peer is gone.
    this.startHeartbeat();
  }

  private requireUsableSocket(): KokoWebSocket {
    if (!this.socket || this.unavailableReason) {
      throw new UserVisibleError(
        `JumpServer terminal session for ${this.input.asset.name} is unavailable: ${this.unavailableReason ?? 'it was never opened'}.`
      );
    }
    return this.socket;
  }

  /** First cause wins: the reason a session died is more useful than its last symptom. */
  private markUnavailable(reason: string): void {
    this.unavailableReason ??= reason;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.disposed) {
      return;
    }
    this.heartbeatTimer = unrefTimer(setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS));
  }

  private sendHeartbeat(): void {
    if (!this.socket || this.unavailableReason || this.pongTimer) {
      return;
    }
    this.pongTimer = unrefTimer(setTimeout(() => this.failHeartbeat(), HEARTBEAT_TIMEOUT_MS));
    try {
      this.socket.ping();
    } catch (error) {
      this.failHeartbeat(error);
    }
  }

  private clearPongDeadline(): void {
    if (!this.pongTimer) {
      return;
    }
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  private stopHeartbeat(): void {
    this.clearPongDeadline();
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private failHeartbeat(cause?: unknown): void {
    if (this.unavailableReason) {
      return;
    }
    const status = t('Disconnected (no heartbeat response within {ms}ms)', { ms: HEARTBEAT_TIMEOUT_MS });
    // The asset name is safe to print; the KoKo URL carries the connection token
    // and never reaches this class, which is why nothing here has to redact one.
    log.warn(
      `KoKo terminal for ${this.input.asset.name} stopped answering heartbeats within ${HEARTBEAT_TIMEOUT_MS}ms` +
        `${cause ? `: ${String(cause)}` : ''}; dropping the session.`
    );
    this.stopHeartbeat();
    this.markUnavailable(`it stopped answering heartbeats after ${HEARTBEAT_TIMEOUT_MS}ms`);
    this.connected = false;
    this.disconnectReported = true;
    const socket = this.socket;
    this.socket = undefined;
    // `close()` politely waits for a close frame from a peer that has already
    // stopped reading. Only `terminate()` frees the socket now.
    socket?.terminate();
    this.input.events.status(status, 'disconnected');
  }

  private handleSocketMessage(message: Buffer | string, isBinary: boolean): void {
    const text = Buffer.isBuffer(message) ? message.toString('utf8') : message;
    if (!isBinary && this.handleControlMessage(text)) {
      return;
    }
    this.input.events.output(Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8'));
  }

  private handleControlMessage(message: string): boolean {
    const payload = parseKokoControlMessage(message);
    if (!payload) {
      return false;
    }
    if (payload.type === 'CONNECT') {
      const init = {
        id: payload.id || randomUUID(),
        type: 'TERMINAL_INIT',
        data: JSON.stringify({ cols: this.cols, rows: this.rows, code: '' })
      };
      this.socket?.send(JSON.stringify(init));
      this.connected = true;
      this.input.events.status(t('Connected'), 'connected');
      return true;
    }
    if (payload.type === 'PING') {
      this.socket?.send(JSON.stringify({ id: payload.id || '', type: 'PONG', data: '' }));
      return true;
    }
    if (typeof payload.data === 'string' && payload.type === 'TERMINAL_DATA') {
      this.input.events.output(Buffer.from(payload.data, 'utf8'));
      return true;
    }
    return payload.type?.startsWith('TERMINAL_') || payload.type === 'TERMINAL_SESSION';
  }
}

/**
 * A heartbeat must never be the thing that keeps a host process alive. Node
 * timers carry `unref`; the substitutes a test clock installs may not, so the
 * call is guarded rather than assumed.
 */
function unrefTimer<T>(timer: T): T {
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** Runs one connect step and records how long it took, success or failure. */
async function step<T>(run: () => Promise<T>, record: (ms: number) => void): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    record(Date.now() - startedAt);
  }
}

/**
 * Frees a socket that arrived after its session was disposed. `close()` alone
 * would wait for a close frame from a peer nobody will read; `terminate()` is
 * what actually releases it, and the error sink keeps a late transport failure
 * from crashing the host for want of a listener.
 */
function discardSocket(socket: KokoWebSocket): void {
  socket.on('error', () => undefined);
  try {
    socket.close();
  } catch {
    // A socket still in CONNECTING may refuse close(); terminate() below.
  }
  socket.terminate();
}

function closeDetails(code?: number, reason?: Buffer | string): string[] {
  const details: string[] = [];
  if (typeof code === 'number') {
    details.push(`code ${code}`);
  }
  const textReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : reason;
  if (textReason?.trim()) {
    details.push(textReason.trim());
  }
  return details;
}

function formatRawSocketCloseStatus(code?: number, reason?: Buffer | string): string {
  const details = closeDetails(code, reason);
  return details.length > 0 ? `Disconnected (${details.join(': ')})` : 'Disconnected';
}

function formatSocketCloseStatus(code?: number, reason?: Buffer | string): string {
  const details = closeDetails(code, reason);
  return details.length > 0
    ? t('Disconnected ({details})', { details: details.join(': ') })
    : t('Disconnected');
}

function parseKokoControlMessage(message: string): { id?: string; type?: string; data?: unknown } | undefined {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const payload = JSON.parse(message) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return undefined;
    }
    const type = (payload as { type?: unknown }).type;
    if (typeof type !== 'string') {
      return undefined;
    }
    return payload as { id?: string; type?: string; data?: unknown };
  } catch {
    return undefined;
  }
}
