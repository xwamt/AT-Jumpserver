import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JumpServerSftpSession } from '../../src/sftp/JumpServerSftpSession';

class FakeSocket extends EventEmitter {
  readonly send = vi.fn();
  readonly close = vi.fn();
  readonly ping = vi.fn();
  readonly terminate = vi.fn();
  /** What `ws` has accepted but not yet handed to the kernel. */
  bufferedAmount = 0;

  emitMessage(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }
}

function client(socket: FakeSocket) {
  return {
    getAssetDetail: vi.fn(async () => ({
      permed_protocols: [{ name: 'sftp' }],
      permed_accounts: [{ id: 'account-1', username: 'root', has_secret: true }]
    })),
    createConnectionToken: vi.fn(async () => ({ id: 'token-1' })),
    getSmartEndpoint: vi.fn(async () => ({ host: 'koko.example.com', https_port: 443 })),
    openKokoSftpWebSocket: vi.fn(async () => socket as never)
  } as never;
}

/** Reads a promise's state without awaiting it, so a stuck send is an assertion and not a test timeout. */
function track<T>(promise: Promise<T>): { status: 'pending' | 'fulfilled' | 'rejected'; reason: unknown } {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; reason: unknown } = {
    status: 'pending',
    reason: undefined
  };
  promise.then(
    () => {
      state.status = 'fulfilled';
    },
    (error: unknown) => {
      state.status = 'rejected';
      state.reason = error;
    }
  );
  return state;
}

let socket: FakeSocket;

async function openSession() {
  const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
  const connecting = session.connect();
  await vi.advanceTimersByTimeAsync(0);
  socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
  await connecting;
  socket.send.mockClear();
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JumpServerSftpSession send backpressure', () => {
  it('holds a frame back while the socket queue is over the high-water mark', async () => {
    const session = await openSession();
    socket.bufferedAmount = 64 * 1024 * 1024;

    const upload = track(session.uploadBytes('/tmp/big.bin', Buffer.alloc(1024)));
    await vi.advanceTimersByTimeAsync(1000);

    expect(socket.send).not.toHaveBeenCalled();
    expect(upload.status).toBe('pending');
  });

  it('sends the held frame as soon as the socket drains', async () => {
    const session = await openSession();
    socket.bufferedAmount = 64 * 1024 * 1024;
    void session.uploadBytes('/tmp/big.bin', Buffer.alloc(1024));
    await vi.advanceTimersByTimeAsync(1000);

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(1000);

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({ cmd: 'upload' });
  });

  it('rejects a frame whose socket never drains rather than queueing forever', async () => {
    const session = await openSession();
    socket.bufferedAmount = 64 * 1024 * 1024;

    const upload = track(session.uploadBytes('/tmp/big.bin', Buffer.alloc(1024)));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(upload.status).toBe('rejected');
    expect(String(upload.reason)).toMatch(/queued/i);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('still sends straight away when the socket is keeping up', async () => {
    const session = await openSession();

    void session.uploadBytes('/tmp/small.bin', Buffer.alloc(8));

    // No timer advance: an upload on a healthy socket must not cost a tick.
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
});
