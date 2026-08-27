import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { JumpServerSftpSession, type JumpServerSftpSessionClient } from '../../src/sftp/JumpServerSftpSession';

class FakeSocket extends EventEmitter {
  readonly send = vi.fn();
  readonly close = vi.fn();
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
});
