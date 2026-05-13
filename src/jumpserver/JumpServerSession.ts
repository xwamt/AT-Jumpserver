import { randomUUID } from 'node:crypto';
import { extractProtocolNames, resolveFirstUsableAccount, type KokoWebSocket } from './JumpServerClient';
import type { TerminalEvents } from './types';

export interface JumpServerSessionAsset {
  id: string;
  name: string;
}

export interface JumpServerSessionClient {
  getAssetDetail(assetId: string): Promise<Record<string, any>>;
  createConnectionToken(input: {
    assetId: string;
    account: { id: string; username: string };
    protocol: 'ssh';
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
    client: JumpServerSessionClient;
    events: TerminalEvents;
  }) {}

  async connect(): Promise<void> {
    this.input.events.status('Loading asset');
    const detail = await this.input.client.getAssetDetail(this.input.asset.id);
    const protocolNames = extractProtocolNames(detail);
    if (!protocolNames.includes('ssh')) {
      throw new Error('Selected asset does not expose SSH protocol.');
    }
    const account = resolveFirstUsableAccount(detail);

    this.input.events.status('Creating connection token');
    const token = await this.input.client.createConnectionToken({
      assetId: this.input.asset.id,
      account,
      protocol: 'ssh'
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
    socket.on('message', (message: Buffer | string) => {
      if (Buffer.isBuffer(message)) {
        this.input.events.output(message);
        return;
      }
      this.handleControlMessage(String(message));
    });
    socket.on('close', () => {
      this.connected = false;
      this.input.events.status('Disconnected');
    });
    socket.on('error', (error) => this.input.events.error(error));
  }

  private handleControlMessage(message: string): void {
    const payload = JSON.parse(message) as { id?: string; type?: string; data?: unknown };
    if (payload.type === 'CONNECT') {
      const init = {
        id: payload.id || randomUUID(),
        type: 'TERMINAL_INIT',
        data: JSON.stringify({ cols: this.cols, rows: this.rows, code: '' })
      };
      this.socket?.send(JSON.stringify(init));
      this.connected = true;
      this.input.events.status('Connected');
      return;
    }
    if (typeof payload.data === 'string' && payload.type === 'TERMINAL_DATA') {
      this.input.events.output(Buffer.from(payload.data, 'utf8'));
    }
  }
}
