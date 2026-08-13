import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JumpServerSession } from '../../src/jumpserver/JumpServerSession';
import { setLogSink, type LogSink } from '../../src/utils/logger';

/**
 * A KoKo socket that can be told to stop answering protocol pings. That is the
 * whole failure being reproduced here: TCP stays up, `send` keeps succeeding,
 * and nothing on the wire ever says the peer is gone.
 */
class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  pings = 0;
  closed = false;
  terminated = false;
  bufferedAmount = 0;
  /** A live KoKo answers a protocol ping from its read loop. A dead one does not. */
  answersPings = true;

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings += 1;
    if (this.answersPings) {
      this.emit('pong');
    }
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
    this.emit('close', 1006, Buffer.alloc(0));
  }
}

function client(socket: FakeSocket) {
  return {
    getAssetDetail: vi.fn().mockResolvedValue({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root', has_secret: true }],
      permed_protocols: [{ name: 'ssh' }]
    }),
    createConnectionToken: vi.fn().mockResolvedValue({ id: 'token-1' }),
    getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
    openKokoWebSocket: vi.fn().mockResolvedValue(socket)
  };
}

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return {
    lines,
    sink: { trace: record('trace'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
  };
}

/** Longer than any heartbeat interval plus its pong deadline. */
const PAST_ANY_HEARTBEAT_MS = 120_000;

let socket: FakeSocket;
let events: { output: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

/** Connects a session and drives it to the point where KoKo has said CONNECT. */
async function openSession() {
  const session = new JumpServerSession({
    asset: { id: 'asset-1', name: 'web-1' },
    connectionKind: 'ssh',
    client: client(socket),
    events
  });
  await session.connect();
  socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
  events = { output: vi.fn(), status: vi.fn(), error: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
  setLogSink(undefined);
});

describe('JumpServerSession heartbeat', () => {
  it('pings KoKo without ever surfacing the round trip as terminal output', async () => {
    const session = await openSession();

    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);

    expect(socket.pings).toBeGreaterThan(0);
    // The idle-disconnect window is fed by events.output, so a heartbeat that
    // reached it would keep an abandoned bastion session alive forever.
    expect(events.output).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
  });

  it('keeps a session usable for as long as KoKo keeps answering', async () => {
    const session = await openSession();

    await vi.advanceTimersByTimeAsync(10 * PAST_ANY_HEARTBEAT_MS);

    expect(session.isConnected()).toBe(true);
    expect(() => session.write('ls\r')).not.toThrow();
  });

  it('drops a session whose pings stop coming back', async () => {
    const session = await openSession();
    socket.answersPings = false;

    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);

    expect(session.isConnected()).toBe(false);
    expect(socket.terminated).toBe(true);
    expect(events.status).toHaveBeenCalledWith(expect.stringContaining('Disconnected'));
  });

  it('fails an agent write into a session that stopped answering instead of dropping it', async () => {
    const session = await openSession();
    socket.answersPings = false;
    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);
    const sentBefore = socket.sent.length;

    expect(() => session.write('rm -rf /tmp/scratch\r')).toThrow(/heartbeat/i);
    expect(socket.sent.length).toBe(sentBefore);
  });

  it('fails a write into a session the remote end already closed', async () => {
    const session = await openSession();
    socket.emit('close', 1000, Buffer.alloc(0));

    expect(() => session.write('ls\r')).toThrow(/unavailable/i);
  });

  it('fails a write into a disposed session', async () => {
    const session = await openSession();
    session.dispose();

    expect(() => session.write('ls\r')).toThrow(/unavailable/i);
  });

  it('leaves no heartbeat timer running once the session is disposed', async () => {
    const session = await openSession();
    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);
    const pingsBefore = socket.pings;
    // Asserting the ping count alone would pass on any of three guards. The
    // pending-timer count is what pins the interval actually being cleared.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    session.dispose();
    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(socket.pings).toBe(pingsBefore);
  });

  it('reports only one disconnect status when a heartbeat timeout closes the socket', async () => {
    await openSession();
    socket.answersPings = false;

    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);

    const disconnects = events.status.mock.calls.filter(([message]) => String(message).startsWith('Disconnected'));
    expect(disconnects).toHaveLength(1);
  });

  it('records the heartbeat timeout on the extension log channel', async () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);
    await openSession();
    socket.answersPings = false;

    await vi.advanceTimersByTimeAsync(PAST_ANY_HEARTBEAT_MS);

    expect(lines.join('\n')).toMatch(/heartbeat/i);
  });
});

describe('JumpServerSession send backpressure', () => {
  it('refuses a write once KoKo has stopped draining the socket queue', async () => {
    const session = await openSession();
    socket.bufferedAmount = 64 * 1024 * 1024;

    expect(() => session.write('ls\r')).toThrow(/queued/i);

    socket.bufferedAmount = 0;
    expect(() => session.write('ls\r')).not.toThrow();
  });
});
