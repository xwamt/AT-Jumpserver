import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JumpServerSession } from '../../src/jumpserver/JumpServerSession';
import { JumpServerSftpSession } from '../../src/sftp/JumpServerSftpSession';
import { JumpServerSftpManager } from '../../src/sftp/JumpServerSftpManager';
import type { CachedJumpServerAsset } from '../../src/config/schema';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  readonly bufferedAmount = 0;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  terminate(): void { this.closed = true; }
}

function assetDetail(protocolName = 'ssh') {
  return {
    id: 'asset-1',
    permed_accounts: [{ id: 'account-1', alias: 'account-alias-1', username: 'root', has_secret: true }],
    permed_protocols: [{ name: protocolName }]
  };
}

describe('A3: connection-token reuse for SFTP', () => {
  it('Step 1: when reuse switch is disabled (400), terminal connect still succeeds and markTokenReusable called once', async () => {
    const socket = new FakeSocket();
    const markTokenReusable = vi.fn().mockResolvedValue(false);
    const createConnectionToken = vi.fn().mockResolvedValue({ id: 'token-1' });

    const client = {
      getAssetDetail: vi.fn().mockResolvedValue(assetDetail('ssh')),
      createConnectionToken,
      markTokenReusable,
      getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
      openKokoWebSocket: vi.fn().mockResolvedValue(socket)
    };

    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'server-1' },
      connectionKind: 'ssh',
      client: client as any,
      events: { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    });

    await expect(session.connect()).resolves.toBeUndefined();
    expect(markTokenReusable).toHaveBeenCalledTimes(1);
    expect(markTokenReusable).toHaveBeenCalledWith('token-1');
  });

  it('Step 2: when reusable token is available, SFTP session skips createConnectionToken and reuses terminal token', async () => {
    const socket = new FakeSocket();
    const createConnectionToken = vi.fn().mockResolvedValue({ id: 'sftp-token-new' });
    const openKokoSftpWebSocket = vi.fn().mockImplementation(async ({ tokenId }) => {
      // simulate sftp ready
      setTimeout(() => {
        socket.emit('message', JSON.stringify({ id: 'init', type: 'CONNECT', data: '{}' }));
      }, 5);
      return socket;
    });

    const sftpClient = {
      getAssetDetail: vi.fn().mockResolvedValue(assetDetail('sftp')),
      createConnectionToken,
      getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
      openKokoSftpWebSocket
    };

    const sftpSession = new JumpServerSftpSession({
      asset: { id: 'asset-1', name: 'server-1' },
      client: sftpClient as any,
      getReusableTokenId: () => 'terminal-token-reused'
    });

    const connecting = sftpSession.connect();
    await connecting;

    expect(createConnectionToken).toHaveBeenCalledTimes(0);
    expect(openKokoSftpWebSocket).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'terminal-token-reused' })
    );
  });

  it('Step 3: SFTP lazy loading does not regress: openAsset calls connect 0 times, listDirectory triggers connect 1 time', async () => {
    let connectCalls = 0;
    const fakeSftpSession = {
      connect: vi.fn(async () => {
        connectCalls += 1;
      }),
      realpath: vi.fn(async () => '/root'),
      listDirectory: vi.fn(async () => []),
      dispose: vi.fn(),
      isConnected: vi.fn(() => true)
    };

    const manager = new JumpServerSftpManager({
      createSession: vi.fn(async () => fakeSftpSession as any)
    });

    const asset = {
      id: 'asset-1',
      name: 'server-1',
      bastionId: 'b-1',
      protocolNames: ['ssh', 'sftp']
    } as CachedJumpServerAsset;

    await manager.openAsset(asset, 'terminal-1');
    expect(connectCalls).toBe(0);
    expect(fakeSftpSession.connect).toHaveBeenCalledTimes(0);

    await manager.listDirectory('/root', 'terminal-1');
    expect(connectCalls).toBe(1);
    expect(fakeSftpSession.connect).toHaveBeenCalledTimes(1);
  });

  it('Step 4: when no active terminal session or terminal disconnected, SFTP falls back to createConnectionToken', async () => {
    const socket = new FakeSocket();
    const createConnectionToken = vi.fn().mockResolvedValue({ id: 'sftp-token-fresh' });
    const openKokoSftpWebSocket = vi.fn().mockImplementation(async () => {
      setTimeout(() => {
        socket.emit('message', JSON.stringify({ id: 'init', type: 'CONNECT', data: '{}' }));
      }, 5);
      return socket;
    });

    const sftpClient = {
      getAssetDetail: vi.fn().mockResolvedValue(assetDetail('sftp')),
      createConnectionToken,
      getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
      openKokoSftpWebSocket
    };

    // getReusableTokenId returns undefined (terminal disconnected or nonexistent)
    const sftpSession = new JumpServerSftpSession({
      asset: { id: 'asset-1', name: 'server-1' },
      client: sftpClient as any,
      getReusableTokenId: () => undefined
    });

    await sftpSession.connect();

    expect(createConnectionToken).toHaveBeenCalledTimes(1);
    expect(openKokoSftpWebSocket).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'sftp-token-fresh' })
    );
  });

  it('Step 5: when token has personal_credential_id, markTokenReusable is NOT called', async () => {
    const socket = new FakeSocket();
    const markTokenReusable = vi.fn().mockResolvedValue(true);
    const createConnectionToken = vi.fn().mockResolvedValue({
      id: 'token-personal',
      personalCredentialId: 'cred-123'
    });

    const client = {
      getAssetDetail: vi.fn().mockResolvedValue(assetDetail('ssh')),
      createConnectionToken,
      markTokenReusable,
      getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
      openKokoWebSocket: vi.fn().mockResolvedValue(socket)
    };

    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'server-1' },
      connectionKind: 'ssh',
      client: client as any,
      events: { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    });

    await session.connect();
    expect(markTokenReusable).not.toHaveBeenCalled();
  });
});
