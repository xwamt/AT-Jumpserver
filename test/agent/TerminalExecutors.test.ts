import { describe, expect, it, vi } from 'vitest';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';
import {
  MysqlCliExecutor,
  RedisCliExecutor,
  ShellTerminalExecutor,
  wrapShellCommand
} from '../../src/agent/TerminalExecutors';

describe('TerminalExecutors', () => {
  it('wraps shell commands as a single prompt line', () => {
    const wrapped = wrapShellCommand('# 目的：查看内存\nfree -h', undefined, 'abc');
    expect(wrapped.endsWith('\n')).toBe(true);
    expect(wrapped.trimEnd().includes('\n')).toBe(false);
    expect(wrapped).toContain("eval 'free -h'");
    expect(wrapped).not.toContain('目的');
    expect(wrapped).not.toContain('__JMS_CMD_START_abc__');
    expect(wrapped).not.toContain('__JMS_CMD_END_abc__');
  });

  it('runs shell commands with marker-bounded output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toContain("__JMS_CMD_START_'");
      expect(input).toContain("'abc'");
      expect(input).not.toContain('__JMS_CMD_START_abc__');
      expect(input).not.toContain('__JMS_CMD_END_abc__');
      expect(input.trimEnd().includes('\n')).toBe(false);
      output.append('ignored echo\n');
      output.append('__JMS_CMD_START_abc__\nhello\n__JMS_CMD_END_abc__0\n');
    });
    const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

    await expect(executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'ssh-1',
      command: 'echo hello',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).resolves.toMatchObject({
      terminalId: 'terminal-1',
      stdout: '\nhello\n',
      exitCode: 0,
      timedOut: false,
      truncated: false
    });
  });

  it('does not finish early when terminal echo contains end-marker text without start marker', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      // Simulate JumpServer PTY echo of the single wrapper line first.
      output.append(`ubuntu@host:~$ ${input}`);
      queueMicrotask(() => {
        output.append('__JMS_CMD_START_abc__\n');
        output.append('              total        used        free\n');
        output.append('Mem:           30Gi        28Gi       435Mi\n');
        output.append('__JMS_CMD_END_abc__0\n');
      });
    });
    const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

    const result = await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'uat-service',
      command: 'free -h',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 4096
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('30Gi');
    expect(result.stdout).toContain('435Mi');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('captures command stdout from a chunked JumpServer-style transcript', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      const id = '6740aa5ccb5f40a3a9839ea66426ff64';
      // Echo arrives first (may include $? text) — must not complete collection.
      output.append(`ubuntu@ip-10-1-149-41:~$ ${input}`);
      setTimeout(() => {
        output.append(`\n__JMS_CMD_START_${id}__\n`);
      }, 5);
      setTimeout(() => {
        output.append('              total        used        free      shared  buff/cache   available\n');
        output.append('Mem:            30Gi        28Gi       435Mi        20Gi         24Gi       1.9Gi\n');
        output.append('Swap:          8.0Gi          0B       8.0Gi\n');
      }, 15);
      setTimeout(() => {
        output.append(`\n__JMS_CMD_END_${id}__0\n`);
      }, 25);
    });
    const executor = new ShellTerminalExecutor({
      idFactory: () => '6740aa5ccb5f40a3a9839ea66426ff64'
    });

    const result = await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'uat-service',
      command: '# 目的：查看整体内存概况\nfree -h',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 8192
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Mem:');
    expect(result.stdout).toContain('30Gi');
    expect(result.stdout).toContain('1.9Gi');
  });

  it('runs MySQL SQL with marker-bounded output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toContain("SELECT CONCAT('__JMS_SQL_START_', 'abc', '__');");
      expect(input).not.toContain("SELECT '__JMS_SQL_START_abc__';");
      output.append(input);
      output.append('+-------------------------+\n');
      output.append('| __JMS_SQL_START_abc__ |\n');
      output.append('1 row in set\n');
      output.append('+---+\n| 1 |\n+---+\n');
      output.append('| __JMS_SQL_END_abc__ |\n');
    });
    const executor = new MysqlCliExecutor({ idFactory: () => 'abc' });

    await expect(executor.execute({
      terminalId: 'terminal-1',
      assetId: 'mysql-1',
      assetName: 'mysql-1',
      sql: 'select 1;',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).resolves.toMatchObject({
      terminalId: 'terminal-1',
      output: expect.stringContaining('| 1 |'),
      timedOut: false,
      truncated: false
    });
  });

  it('detects MySQL end marker after noisy ANSI echo exceeds maxOutputBytes', async () => {
    const output = new TerminalOutputBuffer(1024 * 1024);
    const write = vi.fn(() => {
      const noisyEcho = `${'\u001b[36mS\u001b[0m'.repeat(80)}long-sql-echo\n`;
      output.append(noisyEcho);
      output.append('| __JMS_SQL_START_abc__ |\n');
      output.append(' A | c \n---\n 1 | 61 \n');
      output.append('| __JMS_SQL_END_abc__ |\n');
    });
    const executor = new MysqlCliExecutor({ idFactory: () => 'abc' });

    const result = await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'mysql-1',
      assetName: 'mysql-1',
      sql: 'SELECT 1;',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 64
    });

    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('61');
    expect(result.output).not.toContain('\u001b[');
  });

  it('defaults shell maxOutputBytes to 64KB and clamps hard max to 256KB', async () => {
    const output = {
      collectUntil: vi.fn(async (options: { maxOutputBytes: number }) => {
        expect(options.maxOutputBytes).toBe(expectedMax);
        return {
          output: '__JMS_CMD_START_abc__\nok\n__JMS_CMD_END_abc__0\n',
          terminator: '__JMS_CMD_END_abc__0',
          timedOut: false,
          truncated: false
        };
      })
    };
    const write = vi.fn();
    const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

    let expectedMax = 64_000;
    await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'ssh-1',
      command: 'echo ok',
      write,
      output: output as never
    });

    expectedMax = 256_000;
    await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'ssh-1',
      command: 'echo ok',
      write,
      output: output as never,
      maxOutputBytes: 512_000
    });
  });

  it('defaults mysql maxOutputBytes to 64KB and clamps hard max to 256KB', async () => {
    const output = {
      collectUntil: vi.fn(async (options: { maxOutputBytes: number }) => {
        expect(options.maxOutputBytes).toBe(expectedMax);
        return {
          output: '| __JMS_SQL_START_abc__ |\nok\n| __JMS_SQL_END_abc__ |\n',
          terminator: '| __JMS_SQL_END_abc__ |',
          timedOut: false,
          truncated: false
        };
      })
    };
    const write = vi.fn();
    const executor = new MysqlCliExecutor({ idFactory: () => 'abc' });

    let expectedMax = 64_000;
    await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'mysql-1',
      assetName: 'mysql-1',
      sql: 'SELECT 1;',
      write,
      output: output as never
    });

    expectedMax = 256_000;
    await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'mysql-1',
      assetName: 'mysql-1',
      sql: 'SELECT 1;',
      write,
      output: output as never,
      maxOutputBytes: 512_000
    });
  });

  it('wraps Redis commands with ECHO markers and returns inner output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toBe(
        'ECHO __JMS_REDIS_START_abc__\r' +
        'PING\r' +
        'ECHO __JMS_REDIS_END_abc__\r'
      );
      output.append(input);
      output.append('__JMS_REDIS_START_abc__\r');
      output.append('PONG\r');
      output.append('__JMS_REDIS_END_abc__\r');
    });
    const executor = new RedisCliExecutor({ idFactory: () => 'abc' });

    await expect(executor.execute({
      terminalId: 'terminal-1',
      assetId: 'redis-1',
      assetName: 'redis-1',
      command: 'PING',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).resolves.toMatchObject({
      terminalId: 'terminal-1',
      command: 'PING',
      output: 'PONG',
      timedOut: false,
      truncated: false
    });
  });

  it('ignores prompt-prefixed ECHO typing and strips redis-cli redraw noise', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn(() => {
      // Typed lines must not complete collection early.
      output.append('127.0.0.1:44563> ECHO __JMS_REDIS_START_abc__\r');
      output.append('__JMS_REDIS_START_abc__\r');
      output.append('127.0.0.1:44563> P127.0.0.1:44563> PI127.0.0.1:44563> PING\r');
      output.append('PONG\r');
      output.append('127.0.0.1:44563> ECHO __JMS_REDIS_END_abc__\r');
      output.append('__JMS_REDIS_END_abc__\r');
    });
    const executor = new RedisCliExecutor({ idFactory: () => 'abc' });

    await expect(executor.execute({
      terminalId: 'terminal-1',
      assetId: 'redis-1',
      assetName: 'redis-1',
      command: 'PING',
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 8192
    })).resolves.toMatchObject({
      output: 'PONG',
      timedOut: false,
      truncated: false
    });
  });
});
