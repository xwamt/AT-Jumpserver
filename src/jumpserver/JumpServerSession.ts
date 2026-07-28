import { randomUUID } from 'node:crypto';
import { extractProtocolNames, resolveFirstUsableAccount, type KokoWebSocket } from './JumpServerClient';
import { connectionKindLabel, connectionKindProtocol, type JumpServerConnectionKind } from './connectionTypes';
import type { JumpServerConnectionProtocol, TerminalEvents } from './types';

export interface JumpServerSessionAsset {
  id: string;
  name: string;
}

export interface JumpServerSessionClient {
  getAssetDetail(assetId: string): Promise<Record<string, any>>;
  createConnectionToken(input: {
    assetId: string;
    account: { id: string; alias?: string; username: string; hasSecret?: boolean };
    protocol: JumpServerConnectionProtocol;
  }): Promise<{ id: string }>;
  getSmartEndpoint(tokenId: string): Promise<Record<string, any>>;
  openKokoWebSocket(input: {
    endpoint: Record<string, any>;
    tokenId: string;
    cols: number;
    rows: number;
  }): Promise<KokoWebSocket>;
}

export class JumpServerSession {
  private socket: KokoWebSocket | undefined;
  private rows = 24;
  private cols = 80;
  private connected = false;

  constructor(private readonly input: {
    asset: JumpServerSessionAsset;
    connectionKind: JumpServerConnectionKind;
    client: JumpServerSessionClient;
    events: TerminalEvents;
  }) {}

  async connect(): Promise<void> {
    this.input.events.status('Loading asset');
    const detail = await this.input.client.getAssetDetail(this.input.asset.id);
    const protocol = connectionKindProtocol(this.input.connectionKind);
    const protocolNames = extractProtocolNames(detail).map((name) => name.toLowerCase());
    if (!protocolNames.includes(protocol)) {
      throw new Error(`Selected asset does not expose ${connectionKindLabel(this.input.connectionKind)} protocol.`);
    }
    const account = resolveFirstUsableAccount(detail);

    this.input.events.status('Creating connection token');
    const token = await this.input.client.createConnectionToken({
      assetId: this.input.asset.id,
      account,
      protocol
    });
    const endpoint = await this.input.client.getSmartEndpoint(token.id);

    this.input.events.status('Opening KoKo terminal');
    this.socket = await this.input.client.openKokoWebSocket({
      endpoint,
      tokenId: token.id,
      cols: this.cols,
      rows: this.rows
    });
    this.bindSocket(this.socket);
  }

  write(data: string): void {
    this.socket?.send(JSON.stringify({ id: '', type: 'TERMINAL_DATA', data }));
  }

  resize(rows: number, cols: number): void {
    if (rows <= 0 || cols <= 0) {
      return;
    }
    this.rows = rows;
    this.cols = cols;
    this.socket?.send(JSON.stringify({
      id: '',
      type: 'TERMINAL_RESIZE',
      data: JSON.stringify({ cols, rows })
    }));
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  private bindSocket(socket: KokoWebSocket): void {
    socket.on('message', (message: Buffer | string, isBinary?: boolean) => {
      this.handleSocketMessage(message, Boolean(isBinary));
    });
    socket.on('close', (code?: number, reason?: Buffer | string) => {
      this.connected = false;
      this.input.events.status(formatSocketCloseStatus(code, reason));
    });
    socket.on('error', (error) => this.input.events.error(error));
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
      this.input.events.status('Connected');
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

function formatSocketCloseStatus(code?: number, reason?: Buffer | string): string {
  const details: string[] = [];
  if (typeof code === 'number') {
    details.push(`code ${code}`);
  }
  const textReason = Buffer.isBuffer(reason) ? reason.toString('utf8') : reason;
  if (textReason?.trim()) {
    details.push(textReason.trim());
  }
  return details.length > 0 ? `Disconnected (${details.join(': ')})` : 'Disconnected';
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
