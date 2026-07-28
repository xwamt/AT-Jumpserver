import { describe, expect, it, vi } from 'vitest';
import type { CachedJumpServerAsset } from '../../src/config/schema';
import { JumpServerAgentToolService } from '../../src/agent/JumpServerAgentToolService';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

describe('JumpServerAgentToolService', () => {
  it('lists cached assets without raw secrets', async () => {
    const service = serviceWith({
      configManager: {
        listCachedAssets: async () => [
          asset({
            id: 'asset-1',
            name: 'db',
            address: '10.0.0.1',
            platform: 'MySQL',
            category: 'database',
            type: 'mysql',
            nodePath: ['Default'],
            protocolNames: ['mysql'],
            raw: { password: 'hidden', visible: 'ok' }
          })
        ]
      }
    });
    const result = await service.listAssets();

    expect(result).toEqual({
      assets: [expect.objectContaining({
        assetId: 'asset-1',
        name: 'db',
        connectionKind: 'mysql'
      })]
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('returns terminal context snapshots', async () => {
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      asset: asset({ id: 'ssh-1', name: 'ssh-1', protocolNames: ['ssh'] }),
      connected: true,
      write: vi.fn()
    });
    const service = serviceWith({ terminalContext });

    await expect(service.getTerminalContext()).resolves.toMatchObject({
      activeTerminal: { terminalId: 'terminal-1', connectionKind: 'ssh' },
      connectedTerminals: [{ terminalId: 'terminal-1', connectionKind: 'ssh' }]
    });
  });

  it('requires confirmation for dangerous SQL', async () => {
    const confirm = vi.fn(async () => false);
    const service = serviceWith({ confirm });

    await expect(service.mysqlExecuteSql({ terminalId: 'active', sql: 'drop table users;' })).rejects.toThrow(
      'MySQL SQL execution was cancelled.'
    );
    expect(confirm).toHaveBeenCalled();
  });

  it('routes SFTP list to the manager', async () => {
    const sftp = { listDirectory: vi.fn(async () => [{ name: 'app.txt', path: '/app.txt', type: 'file' }]) };
    const service = serviceWith({ sftp });

    await expect(service.sftpListDirectory({ path: '/' })).resolves.toEqual({
      path: '/',
      entries: [{ name: 'app.txt', path: '/app.txt', type: 'file' }]
    });
    expect(sftp.listDirectory).toHaveBeenCalledWith('/');
  });

  it('requires confirmation before sendTerminalInput', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => false);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      asset: asset({ id: 'ssh-1', name: 'web-1', protocolNames: ['ssh'] }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.sendTerminalInput({ input: 'rm -rf /\n' })).rejects.toThrow(
      /cancelled/i
    );
    expect(confirm).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes terminal input after confirmation', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => true);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      asset: asset({ id: 'ssh-1', name: 'web-1', protocolNames: ['ssh'] }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.sendTerminalInput({ input: 'whoami\n' })).resolves.toMatchObject({
      terminalId: 'terminal-1',
      bytesWritten: expect.any(Number)
    });
    expect(write).toHaveBeenCalledWith('whoami\n');
  });

  it('requires confirmation before mysqlSendInput', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => false);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'mysql-terminal',
      asset: asset({ id: 'mysql-1', name: 'mysql-1', type: 'mysql', platform: 'MySQL', protocolNames: ['mysql'] }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });
    await expect(service.mysqlSendInput({ input: 'DROP TABLE t;\n' })).rejects.toThrow(/cancelled/i);
    expect(confirm).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes mysql input after confirmation', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => true);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'mysql-terminal',
      asset: asset({ id: 'mysql-1', name: 'mysql-1', type: 'mysql', platform: 'MySQL', protocolNames: ['mysql'] }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.mysqlSendInput({ input: 'SELECT 1;\n' })).resolves.toMatchObject({
      terminalId: 'mysql-terminal',
      bytesWritten: expect.any(Number)
    });
    expect(write).toHaveBeenCalledWith('SELECT 1;\n');
  });
});

function serviceWith(overrides: Record<string, unknown>) {
  const terminalContext = (overrides.terminalContext as TerminalContextRegistry) ?? new TerminalContextRegistry();
  if (!overrides.terminalContext) {
    terminalContext.setActive({
      terminalId: 'mysql-terminal',
      asset: asset({ id: 'mysql-1', name: 'mysql-1', type: 'mysql', platform: 'MySQL', protocolNames: ['mysql'] }),
      connected: true,
      write: vi.fn()
    });
  }
  return new JumpServerAgentToolService({
    configManager: {
      listCachedAssets: async () => [],
      ...(overrides.configManager as object)
    } as never,
    terminalContext,
    sftp: {
      listDirectory: async () => [],
      stat: async () => ({ size: 0, modifiedAt: 0 }),
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => undefined,
      createFile: async () => undefined,
      mkdir: async () => undefined,
      rename: async () => undefined,
      deleteEntry: async () => undefined,
      ...(overrides.sftp as object)
    } as never,
    confirm: (overrides.confirm as never) ?? vi.fn(async () => true)
  });
}

function asset(overrides: Partial<CachedJumpServerAsset>): CachedJumpServerAsset {
  return {
    id: 'asset-1',
    name: 'asset-1',
    address: '',
    platform: '',
    category: '',
    type: '',
    zoneName: '',
    nodePath: [],
    protocolNames: [],
    raw: {},
    ...overrides
  };
}
