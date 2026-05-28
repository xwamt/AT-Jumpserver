import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { JumpServerSftpSession, type JumpServerSftpSessionClient } from '../../src/sftp/JumpServerSftpSession';

class FakeSocket extends EventEmitter {
  readonly send = vi.fn();
  readonly close = vi.fn();

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
