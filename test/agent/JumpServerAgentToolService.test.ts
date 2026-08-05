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

  it('does not expose mysqlGetContext/mysqlSendInput', () => {
    const service = serviceWith({});
    expect('mysqlGetContext' in service).toBe(false);
    expect('mysqlSendInput' in service).toBe(false);
  });

  it('executes read-only Redis commands without confirmation', async () => {
    const terminalContext = new TerminalContextRegistry();
    const write = vi.fn((data: string) => {
      const startMatch = data.match(/__JMS_REDIS_START_([0-9a-f]+)__/);
      const id = startMatch?.[1] ?? 'unknown';
      const buffer = terminalContext.getOutputBuffer('redis-terminal');
      buffer?.append(data);
      buffer?.append(`__JMS_REDIS_START_${id}__\nPONG\n__JMS_REDIS_END_${id}__\n`);
    });
    const confirm = vi.fn(async () => true);
    terminalContext.setActive({
      terminalId: 'redis-terminal',
      asset: asset({
        id: 'redis-1',
        name: 'redis-1',
        type: 'redis',
        platform: 'Redis',
        category: 'database',
        protocolNames: ['redis']
      }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.redisExecuteCommand({ command: 'PING' })).resolves.toMatchObject({
      terminalId: 'redis-terminal',
      assetId: 'redis-1',
      command: 'PING',
      output: expect.stringContaining('PONG'),
      timedOut: false,
      truncated: false
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });

  it('requires confirmation for state-changing Redis commands', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => false);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'redis-terminal',
      asset: asset({
        id: 'redis-1',
        name: 'redis-1',
        type: 'redis',
        platform: 'Redis',
        category: 'database',
        protocolNames: ['redis']
      }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.redisExecuteCommand({ command: 'SET key value' })).rejects.toThrow(
      'Redis command execution was cancelled.'
    );
    expect(confirm).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects blocking Redis commands before writing', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => true);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'redis-terminal',
      asset: asset({
        id: 'redis-1',
        name: 'redis-1',
        type: 'redis',
        platform: 'Redis',
        category: 'database',
        protocolNames: ['redis']
      }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.redisExecuteCommand({ command: 'SUBSCRIBE ch' })).rejects.toThrow(
      /blocking|SUBSCRIBE|send_terminal_input/i
    );
    expect(write).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires a Redis terminal for redisExecuteCommand', async () => {
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

    await expect(service.redisExecuteCommand({ command: 'PING' })).rejects.toThrow(
      'A connected JumpServer Redis terminal is required.'
    );
    expect(write).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('writes Redis terminal input after confirmation via sendTerminalInput', async () => {
    const write = vi.fn();
    const confirm = vi.fn(async () => true);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'redis-terminal',
      asset: asset({
        id: 'redis-1',
        name: 'redis-1',
        type: 'redis',
        platform: 'Redis',
        category: 'database',
        protocolNames: ['redis']
      }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    await expect(service.sendTerminalInput({ input: 'PING\n' })).resolves.toMatchObject({
      terminalId: 'redis-terminal',
      bytesWritten: expect.any(Number)
    });
    expect(confirm).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('PING\n');
  });

  it('runs one shell wrapper write per confirmed command and serializes parallel calls', async () => {
    let writeCount = 0;
    const terminalContext = new TerminalContextRegistry();
    const write = vi.fn((data: string) => {
      writeCount += 1;
      const call = writeCount;
      const idMatch = data.match(/'([0-9a-f]{32})'/);
      const id = idMatch?.[1] ?? `id${call}`;
      terminalContext.getOutputBuffer('terminal-1')?.append(`prompt$ ${data}`);
      setTimeout(() => {
        terminalContext.getOutputBuffer('terminal-1')?.append(
          `__JMS_CMD_START_${id}__\nresult-${call}\n__JMS_CMD_END_${id}__0\n`
        );
      }, call === 1 ? 40 : 10);
    });
    const confirm = vi.fn(async () => true);
    terminalContext.setActive({
      terminalId: 'terminal-1',
      asset: asset({ id: 'ssh-1', name: 'uat-service', protocolNames: ['ssh'] }),
      connected: true,
      write
    });
    const service = serviceWith({ confirm, terminalContext });

    const [first, second] = await Promise.all([
      service.runTerminalCommand({ command: 'echo one' }),
      service.runTerminalCommand({ command: 'echo two' })
    ]);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0].trimEnd().includes('\n')).toBe(false);
    expect(write.mock.calls[1][0].trimEnd().includes('\n')).toBe(false);
    expect(first.stdout).toContain('result-1');
    expect(second.stdout).toContain('result-2');
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
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
