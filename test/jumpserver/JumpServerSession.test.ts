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

function client(socket: FakeSocket, protocolName = 'ssh') {
  return {
    getAssetDetail: vi.fn().mockResolvedValue({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', alias: 'account-alias-1', username: 'root', has_secret: true }],
      permed_protocols: [{ name: protocolName }]
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
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));

    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'asset-1',
      account: { id: 'account-1', alias: 'account-alias-1', username: 'root', hasSecret: true },
      protocol: 'ssh'
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
    expect(events.status).toHaveBeenCalledWith('Connected');
  });


  it('creates Redis db_client tokens and opens the same KoKo terminal socket', async () => {
    const fakeClient = client(socket, 'redis');
    const session = new JumpServerSession({
      asset: { id: 'redis-1', name: 'redis-1' },
      connectionKind: 'redis',
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));

    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'redis-1',
      account: { id: 'account-1', alias: 'account-alias-1', username: 'root', hasSecret: true },
      protocol: 'redis'
    });
    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledWith({
      endpoint: { host: 'koko.example.com', https_port: 443 },
      tokenId: 'token-1',
      cols: 80,
      rows: 24
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
  });

  it('creates MySQL db_client tokens and opens the same KoKo terminal socket', async () => {
    const fakeClient = client(socket, 'mysql');
    const session = new JumpServerSession({
      asset: { id: 'mysql-1', name: 'mysql-1' },
      connectionKind: 'mysql',
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));

    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'mysql-1',
      account: { id: 'account-1', alias: 'account-alias-1', username: 'root', hasSecret: true },
      protocol: 'mysql'
    });
    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledWith({
      endpoint: { host: 'koko.example.com', https_port: 443 },
      tokenId: 'token-1',
      cols: 80,
      rows: 24
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
  });

  it('handles KoKo CONNECT control messages when ws delivers text frames as Buffer', async () => {
    const fakeClient = client(socket);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', Buffer.from(JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }), 'utf8'));

    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
    expect(events.output).not.toHaveBeenCalled();
    expect(events.status).toHaveBeenCalledWith('Connected');
  });

  it('handles KoKo PING heartbeats without writing JSON into the terminal', async () => {
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: client(socket),
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({
      id: 'ping-1',
      type: 'PING',
      data: '',
      raw: null,
      err: '',
      prompt: ''
    }));

    expect(socket.sent.at(-1)).toBe(JSON.stringify({ id: 'ping-1', type: 'PONG', data: '' }));
    expect(events.output).not.toHaveBeenCalled();
  });

  it('maps webview input and resize to KoKo terminal messages', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, connectionKind: 'ssh', client: client(socket), events });
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
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, connectionKind: 'ssh', client: client(socket), events });
    await session.connect();

    socket.emit('message', Buffer.from('hello', 'utf8'));
    session.dispose();

    expect(events.output).toHaveBeenCalledWith(Buffer.from('hello', 'utf8'));
    expect(socket.closed).toBe(true);
  });

  it('reports websocket close code and reason from KoKo', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, connectionKind: 'ssh', client: client(socket), events });
    await session.connect();

    socket.emit('close', 4001, Buffer.from('idle timeout', 'utf8'));

    expect(events.status).toHaveBeenCalledWith('Disconnected (code 4001: idle timeout)');
  });

  it('reports normal remote websocket close codes too', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, connectionKind: 'ssh', client: client(socket), events });
    await session.connect();

    socket.emit('close', 1000, Buffer.alloc(0));

    expect(events.status).toHaveBeenCalledWith('Disconnected (code 1000)');
  });


  it('rejects assets that do not expose MySQL protocol for MySQL sessions', async () => {
    const fakeClient = client(socket, 'ssh');
    const session = new JumpServerSession({
      asset: { id: 'mysql-1', name: 'mysql-1' },
      connectionKind: 'mysql',
      client: fakeClient,
      events
    });

    await expect(session.connect()).rejects.toThrow('Selected asset does not expose MySQL protocol.');
  });

  it('rejects non-SSH assets', async () => {
    const fakeClient = client(socket);
    fakeClient.getAssetDetail.mockResolvedValueOnce({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root' }],
      permed_protocols: [{ name: 'rdp' }]
    });
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, connectionKind: 'ssh', client: fakeClient, events });

    await expect(session.connect()).rejects.toThrow('Selected asset does not expose SSH protocol.');
  });
});
