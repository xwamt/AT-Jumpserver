import { describe, expect, it, vi } from 'vitest';
import type { CachedJumpServerAsset } from '../../src/config/schema';
import { JumpServerSftpManager } from '../../src/sftp/JumpServerSftpManager';

function asset(overrides: Partial<CachedJumpServerAsset> = {}): CachedJumpServerAsset {
  return {
    id: 'asset-1',
    name: 'web-1',
    address: '10.0.0.1',
    platform: 'Linux',
    category: 'host',
    type: 'server',
    zoneName: '',
    nodePath: [],
    protocolNames: ['ssh', 'sftp'],
    raw: {},
    ...overrides
  };
}

function session() {
  return {
    connect: vi.fn(),
    realpath: vi.fn(async () => '/home/root'),
    listDirectory: vi.fn(async () => [{ name: 'app', path: '/home/root/app', type: 'directory' as const }]),
    mkdir: vi.fn(),
    rename: vi.fn(),
    deleteEntry: vi.fn(),
    uploadBytes: vi.fn(),
    downloadFile: vi.fn(async () => Buffer.from('hello')),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    dispose: vi.fn()
  };
}

describe('JumpServerSftpManager', () => {
  it('starts with no active file tree', () => {
    const manager = new JumpServerSftpManager({ createSession: vi.fn() });
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('opens an asset and lists its root lazily', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });
    await manager.openAsset(asset());

    expect(await manager.ensureRoot()).toBe('/home/root');
    await expect(manager.listDirectory()).resolves.toEqual([{ name: 'app', path: '/home/root/app', type: 'directory' }]);
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/root', asset: expect.objectContaining({ id: 'asset-1' }) });
  });

  it('accepts async session factories', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: async () => fakeSession });

    await manager.openAsset(asset());

    expect(fakeSession.connect).toHaveBeenCalledTimes(1);
    expect(await manager.ensureRoot()).toBe('/home/root');
  });

  it('routes mutations to the active session', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });
    await manager.openAsset(asset());
    await manager.ensureRoot();

    await manager.mkdir('/home/root/new-dir');
    await manager.rename('/home/root/old', '/home/root/new');
    await manager.deleteEntry({ name: 'new', path: '/home/root/new', type: 'file' });

    expect(fakeSession.mkdir).toHaveBeenCalledWith('/home/root/new-dir');
    expect(fakeSession.rename).toHaveBeenCalledWith('/home/root/old', '/home/root/new');
    expect(fakeSession.deleteEntry).toHaveBeenCalledWith('/home/root/new');
  });

  it('keeps a disconnected snapshot after closing active session', async () => {
    const fakeSession = session();
    const manager = new JumpServerSftpManager({ createSession: () => fakeSession });
    await manager.openAsset(asset());
    await manager.listDirectory();
    manager.closeActive();

    expect(manager.getState()).toEqual({
      kind: 'disconnected',
      rootPath: '/home/root',
      entries: [{ name: 'app', path: '/home/root/app', type: 'directory' }],
      asset: expect.objectContaining({ id: 'asset-1' })
    });
  });

  it('keeps SFTP sessions alive in the background when switching active terminals', async () => {
    const firstSession = session();
    const secondSession = session();
    const manager = new JumpServerSftpManager({
      createSession: vi.fn()
        .mockReturnValueOnce(firstSession)
        .mockReturnValueOnce(secondSession)
    });

    await manager.openAsset(asset({ id: 'asset-1', name: 'web-1' }), 'terminal-1');
    await manager.openAsset(asset({ id: 'asset-2', name: 'web-2' }), 'terminal-2');
    manager.selectTerminal('terminal-1');

    expect(firstSession.dispose).not.toHaveBeenCalled();
    expect(secondSession.dispose).not.toHaveBeenCalled();
    expect(manager.getState()).toEqual({
      kind: 'active',
      rootPath: '/home/root',
      asset: expect.objectContaining({ id: 'asset-1' })
    });
  });

  it('removes only the disposed terminal SFTP session', async () => {
    const firstSession = session();
    const secondSession = session();
    const manager = new JumpServerSftpManager({
      createSession: vi.fn()
        .mockReturnValueOnce(firstSession)
        .mockReturnValueOnce(secondSession)
    });

    await manager.openAsset(asset({ id: 'asset-1' }), 'terminal-1');
    await manager.openAsset(asset({ id: 'asset-2' }), 'terminal-2');
    manager.removeTerminal('terminal-2');
    manager.selectTerminal('terminal-1');

    expect(secondSession.dispose).toHaveBeenCalledTimes(1);
    expect(firstSession.dispose).not.toHaveBeenCalled();
    expect(manager.getState()).toEqual({
      kind: 'active',
      rootPath: '/home/root',
      asset: expect.objectContaining({ id: 'asset-1' })
    });
  });
});
