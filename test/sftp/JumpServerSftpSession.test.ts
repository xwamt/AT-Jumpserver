import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  JumpServerSftpSession,
  SFTP_UPLOAD_CHUNK_BYTES,
  type JumpServerSftpSessionClient
} from '../../src/sftp/JumpServerSftpSession';

class FakeSocket extends EventEmitter {
  readonly send = vi.fn();
  readonly close = vi.fn();
  readonly terminate = vi.fn();
  /** A socket that always claims an empty queue, so send backpressure never engages here. */
  readonly bufferedAmount = 0;

  emitMessage(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }
}

function client(socket: FakeSocket): JumpServerSftpSessionClient & {
  createConnectionToken: ReturnType<typeof vi.fn>;
} {
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('JumpServerSftpSession', () => {
  it('connects with SFTP token flow and lists a directory', async () => {
    const socket = new FakeSocket();
    const fakeClient = client(socket);
    const session = new JumpServerSftpSession({
      asset: { id: 'asset-1', name: 'web-1' },
      client: fakeClient
    });

    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;
    const list = session.listDirectory('/home/root');
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(sent).toMatchObject({ type: 'SFTP_DATA', cmd: 'list' });
    expect(JSON.parse(sent.data)).toEqual({ path: '/home/root' });
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/home/root',
      data: JSON.stringify([{ name: 'app', is_dir: true }])
    });

    await expect(list).resolves.toEqual([{ name: 'app', path: '/home/root/app', type: 'directory' }]);
    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'asset-1',
      account: { id: 'account-1', username: 'root', hasSecret: true },
      protocol: 'sftp'
    });
  });

  it('responds to PING with PONG', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    socket.emitMessage({ id: 'ping-1', type: 'PING', data: 'ping' });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ id: 'ping-1', type: 'PONG', data: 'pong' }));
  });

  it('downloads binary chunks before the final SFTP_DATA response', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const download = session.downloadFile('/tmp/a.txt');
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_BINARY', cmd: 'download', raw: Buffer.from('hello').toString('base64') });
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'download', data: 'a.txt' });

    await expect(download).resolves.toEqual(Buffer.from('hello'));
  });

  it('readFile caps buffered chunks at maxBytes without keeping the full download', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const read = session.readFile('/tmp/big.txt', 8);
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(sent).not.toHaveProperty('maxBytes');

    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_BINARY',
      cmd: 'download',
      raw: Buffer.from('0123456789ABCDEF').toString('base64')
    });
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_BINARY',
      cmd: 'download',
      raw: Buffer.alloc(1024, 0x41).toString('base64')
    });
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'download', data: 'big.txt' });

    await expect(read).resolves.toEqual(Buffer.from('01234567'));
  });

  it('uploads with KoKo numeric upload ids and offset payload', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const upload = session.uploadBytes('/tmp/a.txt', Buffer.from('hello'));
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));

    expect(sent).toMatchObject({ type: 'SFTP_DATA', cmd: 'upload' });
    expect(sent.id).toMatch(/^\d+$/);
    expect(JSON.parse(sent.data)).toEqual({
      path: '/tmp/a.txt',
      size: 5,
      offSet: 0,
      chunk: false
    });
    expect(sent.raw).toBe(Buffer.from('hello').toString('base64'));
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'upload', data: 'ok' });

    await expect(upload).resolves.toBeUndefined();
  });

  it('stat lists the parent directory without moving the current path', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const list = session.listDirectory('/tmp');
    let sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/tmp',
      data: JSON.stringify([{ name: 'a.txt', size: 1 }])
    });
    await list;
    await expect(session.realpath('.')).resolves.toBe('/tmp');

    const stat = session.stat('/etc/passwd');
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(sent).toMatchObject({ type: 'SFTP_DATA', cmd: 'list' });
    expect(JSON.parse(sent.data)).toEqual({ path: '/etc' });
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/etc',
      data: JSON.stringify([{ name: 'passwd', size: 42, mod_time: 7 }])
    });

    await expect(stat).resolves.toEqual({ size: 42, modifiedAt: 7 });
    await expect(session.realpath('.')).resolves.toBe('/tmp');
  });

  it('serves a repeated stat from the short list cache until a mutation invalidates it', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const first = session.stat('/etc/passwd');
    let sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/etc',
      data: JSON.stringify([{ name: 'passwd', size: 42, mod_time: 7 }])
    });
    await expect(first).resolves.toEqual({ size: 42, modifiedAt: 7 });

    const sendsAfterFirstStat = socket.send.mock.calls.length;
    await expect(session.stat('/etc/passwd')).resolves.toEqual({ size: 42, modifiedAt: 7 });
    expect(socket.send.mock.calls.length).toBe(sendsAfterFirstStat);

    const mkdir = session.mkdir('/etc/new-dir');
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'mkdir', data: 'ok' });
    await mkdir;

    const statAfterMkdir = session.stat('/etc/passwd');
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(sent).toMatchObject({ type: 'SFTP_DATA', cmd: 'list' });
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/etc',
      data: JSON.stringify([{ name: 'passwd', size: 43, mod_time: 8 }])
    });
    await expect(statAfterMkdir).resolves.toEqual({ size: 43, modifiedAt: 8 });
  });

  it('rejects pending commands on CLOSE', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
    const connect = session.connect();
    await flushPromises();
    socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
    await connect;

    const list = session.listDirectory('/');
    socket.emitMessage({ type: 'CLOSE', err: 'Session expired or not found' });

    await expect(list).rejects.toThrow('Session expired or not found');
  });

  it('sends one command at a time and dispatches the next only after the response', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const first = session.listDirectory('/a');
    const second = session.listDirectory('/b');

    expect(socket.send).toHaveBeenCalledTimes(1);
    const sentFirst = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
    expect(JSON.parse(sentFirst.data)).toEqual({ path: '/a' });

    socket.emitMessage({ id: sentFirst.id, type: 'SFTP_DATA', cmd: 'list', current_path: '/a', data: '[]' });
    await first;
    await flushPromises();

    expect(socket.send).toHaveBeenCalledTimes(2);
    const sentSecond = JSON.parse(String(socket.send.mock.calls[1]?.[0]));
    expect(JSON.parse(sentSecond.data)).toEqual({ path: '/b' });
    socket.emitMessage({ id: sentSecond.id, type: 'SFTP_DATA', cmd: 'list', current_path: '/b', data: '[]' });
    await expect(second).resolves.toEqual([]);
  });

  it('keeps dispatching queued commands after one fails', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const first = session.listDirectory('/a');
    const second = session.listDirectory('/b');
    const sentFirst = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
    socket.emitMessage({ id: sentFirst.id, type: 'SFTP_DATA', cmd: 'list', err: 'Permission denied' });

    await expect(first).rejects.toThrow('Permission denied');
    await flushPromises();

    expect(socket.send).toHaveBeenCalledTimes(2);
    const sentSecond = JSON.parse(String(socket.send.mock.calls[1]?.[0]));
    socket.emitMessage({ id: sentSecond.id, type: 'SFTP_DATA', cmd: 'list', current_path: '/b', data: '[]' });
    await expect(second).resolves.toEqual([]);
  });

  it('rejects a connect whose socket arrives only after dispose and terminates that socket', async () => {
    const socket = new FakeSocket();
    const fakeClient = client(socket);
    let deliverSocket: ((value: unknown) => void) | undefined;
    fakeClient.openKokoSftpWebSocket = vi.fn(
      () => new Promise((resolve) => { deliverSocket = resolve; })
    ) as never;
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: fakeClient });

    const connect = session.connect();
    await flushPromises();
    session.dispose();
    deliverSocket?.(socket);

    await expect(connect).rejects.toThrow(/disposed/i);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects a connect still waiting for CONNECT when the session is disposed', async () => {
    const socket = new FakeSocket();
    const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });

    const connect = session.connect();
    await flushPromises();
    session.dispose();

    await expect(connect).rejects.toThrow(/disposed/i);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps the list cache across downloads and drops it on invalidateListCache', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const list = session.listDirectory('/tmp');
    let sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/tmp',
      data: JSON.stringify([{ name: 'a.txt', size: 1, mod_time: 2 }])
    });
    await list;

    const download = session.downloadFile('/tmp/a.txt');
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_BINARY', cmd: 'download', raw: Buffer.from('x').toString('base64') });
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'download', data: 'a.txt' });
    await download;

    const sendsBeforeStat = socket.send.mock.calls.length;
    await expect(session.stat('/tmp/a.txt')).resolves.toEqual({ size: 1, modifiedAt: 2 });
    expect(socket.send.mock.calls.length).toBe(sendsBeforeStat);

    session.invalidateListCache();
    const statAfter = session.stat('/tmp/a.txt');
    await flushPromises();
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(sent).toMatchObject({ type: 'SFTP_DATA', cmd: 'list' });
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/tmp',
      data: JSON.stringify([{ name: 'a.txt', size: 9, mod_time: 8 }])
    });
    await expect(statAfter).resolves.toEqual({ size: 9, modifiedAt: 8 });
  });

  it('caches a listing under the path KoKo resolved it to', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const list = session.listDirectory('.');
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/home/root',
      data: JSON.stringify([{ name: 'app', is_dir: true }])
    });
    await list;

    const sendsAfterFirstList = socket.send.mock.calls.length;
    await expect(session.listDirectory('/home/root')).resolves.toEqual([
      { name: 'app', path: '/home/root/app', type: 'directory' }
    ]);
    expect(socket.send.mock.calls.length).toBe(sendsAfterFirstList);
  });

  it('re-fetches a fresh cached listing when asked to bypass the cache', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const list = session.listDirectory('/tmp');
    let sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'list', current_path: '/tmp', data: '[]' });
    await list;

    const refreshed = session.listDirectory('/tmp', { bypassCache: true });
    await flushPromises();
    expect(socket.send.mock.calls.length).toBe(2);
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_DATA',
      cmd: 'list',
      current_path: '/tmp',
      data: JSON.stringify([{ name: 'fresh.txt', size: 1 }])
    });
    await expect(refreshed).resolves.toEqual([
      { name: 'fresh.txt', path: '/tmp/fresh.txt', type: 'file', size: 1 }
    ]);
  });

  it('leaves the working directory alone when a listing opts out of navigation', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const uiList = session.listDirectory('/home');
    let sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'list', current_path: '/home', data: '[]' });
    await uiList;

    const mcpList = session.listDirectory('/var/log', { updateCurrentPath: false });
    await flushPromises();
    sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'list', current_path: '/var/log', data: '[]' });
    await mcpList;

    await expect(session.realpath('.')).resolves.toBe('/home');
  });

  it('splits a large upload into acked offset chunks followed by a merge frame', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);
    autoAckUploads(socket);
    const bytes = Buffer.concat([
      Buffer.alloc(SFTP_UPLOAD_CHUNK_BYTES, 0x61),
      Buffer.alloc(1024 * 1024, 0x62)
    ]);
    const progress: Array<[number, number]> = [];

    await session.uploadBytes('/tmp/big.bin', bytes, (sent, total) => progress.push([sent, total]));

    const frames = socket.send.mock.calls
      .map(([frame]) => JSON.parse(String(frame)))
      .filter((frame) => frame.cmd === 'upload');
    expect(frames).toHaveLength(3);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(1);
    expect(frames[0].id).toMatch(/^\d+$/);

    expect(JSON.parse(frames[0].data)).toEqual({
      path: '/tmp/big.bin',
      size: bytes.byteLength,
      offSet: 0,
      chunk: true
    });
    expect(Buffer.from(frames[0].raw, 'base64').equals(bytes.subarray(0, SFTP_UPLOAD_CHUNK_BYTES))).toBe(true);

    expect(JSON.parse(frames[1].data)).toEqual({
      path: '/tmp/big.bin',
      size: bytes.byteLength,
      offSet: SFTP_UPLOAD_CHUNK_BYTES,
      chunk: true
    });
    expect(Buffer.from(frames[1].raw, 'base64').equals(bytes.subarray(SFTP_UPLOAD_CHUNK_BYTES))).toBe(true);

    expect(JSON.parse(frames[2].data)).toEqual({ path: '/tmp/big.bin', size: 0, offSet: 0, merge: true });
    expect(frames[2].raw).toBe('');

    expect(progress).toEqual([
      [SFTP_UPLOAD_CHUNK_BYTES, bytes.byteLength],
      [bytes.byteLength, bytes.byteLength]
    ]);
  });

  it('keeps an exactly chunk-sized upload as a single unchunked frame', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);
    autoAckUploads(socket);
    const bytes = Buffer.alloc(SFTP_UPLOAD_CHUNK_BYTES, 0x61);

    await session.uploadBytes('/tmp/exact.bin', bytes);

    const frames = socket.send.mock.calls
      .map(([frame]) => JSON.parse(String(frame)))
      .filter((frame) => frame.cmd === 'upload');
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].data)).toEqual({
      path: '/tmp/exact.bin',
      size: bytes.byteLength,
      offSet: 0,
      chunk: false
    });
  });

  it('stops a chunked upload at the first failed chunk without sending a merge', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);
    socket.send.mockImplementation((frame: unknown) => {
      const parsed = JSON.parse(String(frame));
      if (parsed.cmd !== 'upload') {
        return;
      }
      const data = JSON.parse(parsed.data);
      queueMicrotask(() => {
        if (data.offSet === SFTP_UPLOAD_CHUNK_BYTES) {
          socket.emitMessage({ id: parsed.id, type: 'SFTP_DATA', cmd: 'upload', err: 'disk full' });
        } else {
          socket.emitMessage({ id: parsed.id, type: 'SFTP_DATA', cmd: 'upload', data: 'ok' });
        }
      });
    });
    const bytes = Buffer.alloc(SFTP_UPLOAD_CHUNK_BYTES * 2 + 1024, 0x61);

    await expect(session.uploadBytes('/tmp/big.bin', bytes)).rejects.toThrow('disk full');

    const frames = socket.send.mock.calls
      .map(([frame]) => JSON.parse(String(frame)))
      .filter((frame) => frame.cmd === 'upload');
    expect(frames).toHaveLength(2);
    expect(frames.some((frame) => JSON.parse(frame.data).merge)).toBe(false);
  });

  it('streams download chunks to a writer in arrival order', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);
    const written: Buffer[] = [];

    const download = session.downloadFileToWriter('/tmp/a.txt', false, async (chunk) => {
      await Promise.resolve();
      written.push(chunk);
    });
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    expect(JSON.parse(sent.data)).toEqual({ path: '/tmp/a.txt', is_dir: false });
    socket.emitMessage({ id: sent.id, type: 'SFTP_BINARY', cmd: 'download', raw: Buffer.from('hel').toString('base64') });
    socket.emitMessage({ id: sent.id, type: 'SFTP_BINARY', cmd: 'download', raw: Buffer.from('lo').toString('base64') });
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'download', data: 'a.txt' });

    await download;
    expect(Buffer.concat(written).toString()).toBe('hello');
  });

  it('rejects a streamed download whose writer fails', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const download = session.downloadFileToWriter('/tmp/a.txt', false, () => {
      throw new Error('disk write failed');
    });
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({ id: sent.id, type: 'SFTP_BINARY', cmd: 'download', raw: Buffer.from('hel').toString('base64') });
    socket.emitMessage({ id: sent.id, type: 'SFTP_DATA', cmd: 'download', data: 'a.txt' });

    await expect(download).rejects.toThrow('disk write failed');
  });

  it('rejects an in-memory download that outgrows its cap instead of buffering it all', async () => {
    const socket = new FakeSocket();
    const session = await openSession(socket);

    const download = session.downloadFile('/tmp/big.bin', false, 8);
    const sent = JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]));
    socket.emitMessage({
      id: sent.id,
      type: 'SFTP_BINARY',
      cmd: 'download',
      raw: Buffer.alloc(16, 0x41).toString('base64')
    });

    await expect(download).rejects.toThrow(/in-memory limit/i);
  });
});

async function openSession(socket: FakeSocket): Promise<JumpServerSftpSession> {
  const session = new JumpServerSftpSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket) });
  const connect = session.connect();
  await flushPromises();
  socket.emitMessage({ id: 'ws-1', type: 'CONNECT', data: '{}' });
  await connect;
  socket.send.mockClear();
  return session;
}

/** Answers every upload frame with the per-frame SFTP_DATA ack KoKo sends. */
function autoAckUploads(socket: FakeSocket): void {
  socket.send.mockImplementation((frame: unknown) => {
    const parsed = JSON.parse(String(frame));
    if (parsed.cmd === 'upload') {
      queueMicrotask(() => socket.emitMessage({ id: parsed.id, type: 'SFTP_DATA', cmd: 'upload', data: 'ok' }));
    }
  });
}
