import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JumpServerSession } from '../../src/jumpserver/JumpServerSession';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function client(socket: FakeSocket) {
  return {
    getAssetDetail: vi.fn().mockResolvedValue({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root' }],
      permed_protocols: [{ name: 'ssh' }]
    }),
    createConnectionToken: vi.fn().mockResolvedValue({ id: 'token-1' }),
    getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
    openKokoWebSocket: vi.fn().mockResolvedValue(socket)
  };
}

describe('JumpServerSession', () => {
  let socket: FakeSocket;
  let events: { output: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    socket = new FakeSocket();
    events = { output: vi.fn(), status: vi.fn(), error: vi.fn() };
  });

  it('creates token, opens KoKo socket, and initializes terminal after CONNECT', async () => {
    const fakeClient = client(socket);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));

    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'asset-1',
      account: { id: 'account-1', username: 'root' },
      protocol: 'ssh'
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
    expect(events.status).toHaveBeenCalledWith('Connected');
  });

  it('maps webview input and resize to KoKo terminal messages', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket), events });
    await session.connect();

    session.write('ls\r');
    session.resize(40, 120);

    expect(socket.sent).toContain(JSON.stringify({ id: '', type: 'TERMINAL_DATA', data: 'ls\r' }));
    expect(socket.sent).toContain(JSON.stringify({
      id: '',
      type: 'TERMINAL_RESIZE',
      data: JSON.stringify({ cols: 120, rows: 40 })
    }));
  });

  it('forwards upstream bytes and closes cleanly', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket), events });
    await session.connect();

    socket.emit('message', Buffer.from('hello', 'utf8'));
    session.dispose();

    expect(events.output).toHaveBeenCalledWith(Buffer.from('hello', 'utf8'));
    expect(socket.closed).toBe(true);
  });

  it('rejects non-SSH assets', async () => {
    const fakeClient = client(socket);
    fakeClient.getAssetDetail.mockResolvedValueOnce({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root' }],
      permed_protocols: [{ name: 'rdp' }]
    });
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, client: fakeClient, events });

    await expect(session.connect()).rejects.toThrow('Selected asset does not expose SSH protocol.');
  });
});
