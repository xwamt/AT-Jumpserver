import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JumpServerSession } from '../../src/jumpserver/JumpServerSession';
import { setLogSink } from '../../src/utils/logger';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  terminated = false;
  /** A socket that always claims an empty queue, so send backpressure never engages here. */
  readonly bufferedAmount = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.emit('pong');
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
    this.terminated = true;
  }
}

function assetDetail(protocolName = 'ssh') {
  return {
    id: 'asset-1',
    permed_accounts: [{ id: 'account-1', alias: 'account-alias-1', username: 'root', has_secret: true }],
    permed_protocols: [{ name: protocolName }]
  };
}

function client(socket: FakeSocket, protocolName = 'ssh') {
  return {
    getAssetDetail: vi.fn().mockResolvedValue(assetDetail(protocolName)),
    createConnectionToken: vi.fn().mockResolvedValue({ id: 'token-1' }),
    getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
    openKokoWebSocket: vi.fn().mockResolvedValue(socket)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recordingSink() {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      trace: (m: string) => lines.push(m),
      debug: (m: string) => lines.push(m),
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m)
    }
  };
}

describe('JumpServerSession', () => {
  let socket: FakeSocket;
  let events: { output: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    socket = new FakeSocket();
    events = { output: vi.fn(), status: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    setLogSink(undefined);
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

  it('logs how long a KoKo terminal connect took', async () => {
    const { lines, sink } = recordingSink();
    setLogSink(sink);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: client(socket),
      events
    });

    await session.connect();

    expect(lines.some((line) => /KoKo terminal connect for web-1 finished in \d+ms/.test(line))).toBe(true);
    expect(lines.some((line) =>
      /^connect timings: detail=\d+ms tokenPost=\d+ms endpoint=\d+ms warmup=\d+ms ws=\d+ms total=\d+ms$/.test(line)
    )).toBe(true);
    // The timings line is purely durations: nothing from the connect - token
    // ids, hosts, cookies - may leak into it.
    const timingsLine = lines.find((line) => line.startsWith('connect timings:'));
    expect(timingsLine).not.toContain('token-1');
    expect(timingsLine).not.toContain('koko.example.com');
  });

  it('logs connect timings even when the connect throws', async () => {
    const { lines, sink } = recordingSink();
    setLogSink(sink);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: client(socket, 'rdp'),
      events
    });

    await expect(session.connect()).rejects.toThrow(/does not expose/);

    expect(lines.some((line) =>
      /^connect timings: detail=\d+ms tokenPost=\d+ms endpoint=\d+ms warmup=\d+ms ws=\d+ms total=\d+ms$/.test(line)
    )).toBe(true);
  });

  it('splits the socket-open time into warmup and handshake using the client warmup clock', async () => {
    const { lines, sink } = recordingSink();
    setLogSink(sink);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: { ...client(socket), lastKokoWarmupMs: vi.fn(() => 5) },
      events
    });

    await session.connect();

    const timingsLine = lines.find((line) => line.startsWith('connect timings:'));
    expect(timingsLine).toContain('warmup=5ms');
    // ws is what remains of the open once warmup is subtracted, never negative.
    expect(timingsLine).toMatch(/ws=\d+ms/);
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

describe('JumpServerSession parallel connect waterfall', () => {
  let socket: FakeSocket;
  let events: { output: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    socket = new FakeSocket();
    events = { output: vi.fn(), status: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    setLogSink(undefined);
  });

  it('kicks off the web session login before the asset detail resolves', async () => {
    const detailDeferred = deferred<Record<string, any>>();
    const fakeClient = {
      ...client(socket),
      getAssetDetail: vi.fn(() => detailDeferred.promise),
      ensureWebSession: vi.fn().mockResolvedValue(undefined)
    };
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    const connecting = session.connect();
    // Called before the detail promise has settled: the two must overlap.
    expect(fakeClient.ensureWebSession).toHaveBeenCalledTimes(1);
    detailDeferred.resolve(assetDetail());
    await connecting;

    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledTimes(1);
  });

  it('still connects when the parallel web session login fails', async () => {
    const fakeClient = {
      ...client(socket),
      ensureWebSession: vi.fn().mockRejectedValue(new Error('login endpoint down'))
    };
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    await session.connect();

    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledTimes(1);
    expect(events.error).not.toHaveBeenCalled();
  });

  it('starts the asset-id endpoint lookup without waiting for the token', async () => {
    const tokenDeferred = deferred<{ id: string }>();
    const fakeClient = {
      ...client(socket),
      createConnectionToken: vi.fn(() => tokenDeferred.promise),
      getSmartEndpointForAsset: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 })
    };
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    const connecting = session.connect();
    // The endpoint lookup must begin while the token POST is still pending.
    await vi.waitFor(() => expect(fakeClient.getSmartEndpointForAsset).toHaveBeenCalledWith('asset-1'));
    expect(fakeClient.openKokoWebSocket).not.toHaveBeenCalled();
    tokenDeferred.resolve({ id: 'token-1' });
    await connecting;

    expect(fakeClient.getSmartEndpoint).not.toHaveBeenCalled();
    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: 'token-1',
      endpoint: { host: 'koko.example.com', https_port: 443 }
    }));
  });

  it('falls back to the token endpoint when the asset-id lookup fails', async () => {
    const fakeClient = {
      ...client(socket),
      getSmartEndpointForAsset: vi.fn().mockRejectedValue(new Error('HTTP 400'))
    };
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    await session.connect();

    expect(fakeClient.getSmartEndpointForAsset).toHaveBeenCalledWith('asset-1');
    expect(fakeClient.getSmartEndpoint).toHaveBeenCalledWith('token-1');
    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledTimes(1);
  });

  it('keeps working against clients that only expose the token endpoint', async () => {
    const fakeClient = client(socket);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    await session.connect();

    expect(fakeClient.getSmartEndpoint).toHaveBeenCalledWith('token-1');
    expect(fakeClient.openKokoWebSocket).toHaveBeenCalledTimes(1);
  });
});

describe('JumpServerSession dispose during an in-flight connect', () => {
  let socket: FakeSocket;
  let events: { output: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    socket = new FakeSocket();
    events = { output: vi.fn(), status: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    setLogSink(undefined);
  });

  it('aborts a connect whose asset detail resolves after dispose', async () => {
    const detailDeferred = deferred<Record<string, any>>();
    const fakeClient = { ...client(socket), getAssetDetail: vi.fn(() => detailDeferred.promise) };
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    const connecting = session.connect();
    session.dispose();
    detailDeferred.resolve(assetDetail());
    await connecting;

    expect(fakeClient.createConnectionToken).not.toHaveBeenCalled();
    expect(fakeClient.openKokoWebSocket).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
  });

  it('does not open a socket when dispose lands while the token is pending', async () => {
    const tokenDeferred = deferred<{ id: string }>();
    const fakeClient = { ...client(socket), createConnectionToken: vi.fn(() => tokenDeferred.promise) };
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      connectionKind: 'ssh',
      client: fakeClient,
      events
    });

    const connecting = session.connect();
    await vi.waitFor(() => expect(fakeClient.createConnectionToken).toHaveBeenCalled());
    session.dispose();
    tokenDeferred.resolve({ id: 'token-1' });
    await connecting;

    expect(fakeClient.openKokoWebSocket).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
  });

  it('terminates a socket that arrives after dispose and leaves no heartbeat behind', async () => {
    vi.useFakeTimers();
    try {
      const socketDeferred = deferred<FakeSocket>();
      const fakeClient = { ...client(socket), openKokoWebSocket: vi.fn().mockReturnValue(socketDeferred.promise) };
      const session = new JumpServerSession({
        asset: { id: 'asset-1', name: 'web-1' },
        connectionKind: 'ssh',
        client: fakeClient,
        events
      });

      const connecting = session.connect();
      await vi.waitFor(() => expect(fakeClient.openKokoWebSocket).toHaveBeenCalled());
      session.dispose();
      socketDeferred.resolve(socket);
      await connecting;

      // The late socket is freed outright, never bound to the dead session.
      expect(socket.closed).toBe(true);
      expect(socket.terminated).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));
      expect(socket.sent).toEqual([]);
      expect(events.status).not.toHaveBeenCalledWith('Connected');
      expect(session.isConnected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
