import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';
import {
  ensureSemicolon,
  MAX_TIMEOUT_MS,
  MysqlCliExecutor,
  normalizeShellCommand,
  RedisCliExecutor,
  ShellTerminalExecutor,
  START_MARKER_GRACE_MS,
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

  it('caps executor timeouts below the 120s hub failover so commands are not run twice', async () => {
    expect(MAX_TIMEOUT_MS).toBe(110_000);
    expect(MAX_TIMEOUT_MS).toBeLessThan(120_000);

    const output = {
      collectUntil: vi.fn(async (options: { timeoutMs: number }) => {
        expect(options.timeoutMs).toBe(MAX_TIMEOUT_MS);
        return {
          output: '__JMS_CMD_START_abc__\nok\n__JMS_CMD_END_abc__0\n',
          terminator: '__JMS_CMD_END_abc__0',
          timedOut: false,
          truncated: false
        };
      })
    };
    const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

    await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'asset-1',
      assetName: 'ssh-1',
      command: 'sleep 300',
      write: vi.fn(),
      output: output as never,
      timeoutMs: 500_000
    });

    expect(output.collectUntil).toHaveBeenCalledTimes(1);
  });

  describe('start-marker grace', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails fast near 3s when the terminal never echoes the shell start marker', async () => {
      vi.useFakeTimers();
      const output = new TerminalOutputBuffer();
      const write = vi.fn(() => {
        // Terminal parked in a pager: the wrapper line is swallowed, so the
        // printf start marker never shows up in the output stream.
        output.append(':\u001b[K');
      });
      const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

      const pending = executor.execute({
        terminalId: 'terminal-1',
        assetId: 'asset-1',
        assetName: 'ssh-1',
        command: 'echo hello',
        write,
        output,
        timeoutMs: 30_000,
        maxOutputBytes: 1024
      });
      // Advance only the grace window — resolving here proves the executor
      // did not sit out the full 30s timeout.
      await vi.advanceTimersByTimeAsync(START_MARKER_GRACE_MS);
      const result = await pending;

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain('3s');
      expect(result.durationMs).toBeGreaterThanOrEqual(START_MARKER_GRACE_MS);
      expect(result.durationMs).toBeLessThan(30_000);
    });

    it('still completes when the start marker arrives inside the grace window', async () => {
      vi.useFakeTimers();
      const output = new TerminalOutputBuffer();
      const write = vi.fn(() => {
        output.append('__JMS_CMD_START_abc__\n');
      });
      const executor = new ShellTerminalExecutor({ idFactory: () => 'abc' });

      const pending = executor.execute({
        terminalId: 'terminal-1',
        assetId: 'asset-1',
        assetName: 'ssh-1',
        command: 'sleep 5 && echo hello',
        write,
        output,
        timeoutMs: 30_000,
        maxOutputBytes: 1024
      });
      // Well past the grace deadline: a seen start marker disarms it.
      await vi.advanceTimersByTimeAsync(10_000);
      output.append('hello\n__JMS_CMD_END_abc__0\n');
      const result = await pending;

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('hello');
    });

    it('applies the same grace to mysql and redis start markers', async () => {
      const captured: Array<Record<string, unknown>> = [];
      const output = {
        collectUntil: vi.fn(async (options: Record<string, unknown>) => {
          captured.push(options);
          return {
            output: 'stuck pager output',
            terminator: undefined,
            timedOut: true,
            truncated: false,
            startMarkerMissing: true
          };
        })
      };

      const mysqlResult = await new MysqlCliExecutor({ idFactory: () => 'abc' }).execute({
        terminalId: 'terminal-1',
        assetId: 'mysql-1',
        assetName: 'mysql-1',
        sql: 'SELECT 1;',
        write: vi.fn(),
        output: output as never
      });
      const redisResult = await new RedisCliExecutor({ idFactory: () => 'abc' }).execute({
        terminalId: 'terminal-1',
        assetId: 'redis-1',
        assetName: 'redis-1',
        command: 'PING',
        write: vi.fn(),
        output: output as never
      });

      expect(captured[0]).toMatchObject({
        startMarker: '__JMS_SQL_START_abc__',
        startMarkerGraceMs: START_MARKER_GRACE_MS
      });
      expect(captured[1]).toMatchObject({
        startMarker: '__JMS_REDIS_START_abc__',
        startMarkerGraceMs: START_MARKER_GRACE_MS
      });
      expect(mysqlResult.timedOut).toBe(true);
      expect(mysqlResult.error).toContain('did not start executing');
      expect(redisResult.timedOut).toBe(true);
      expect(redisResult.error).toContain('did not start executing');
    });
  });

  // Anchors for spec D7 (evaluated text ≡ executed text): the policy evaluator
  // is fed normalizeShellCommand(command) / ensureSemicolon(sql), so the
  // executors must embed exactly those functions' output. If wrapShellCommand
  // or the mysql executor body drifts, these fail.
  it('embeds exactly the normalized command that policy evaluation sees', () => {
    const command = '  # Purpose: check\n uptime \n df -h ';
    const normalized = normalizeShellCommand(command);
    const wrapped = wrapShellCommand(command, undefined, 'testid');
    expect(normalized).toBe('uptime; df -h');
    expect(wrapped).toContain(`eval '${normalized.replaceAll("'", "'\\''")}'`);
  });

  it('mysql executor sends exactly ensureSemicolon(sql) between the markers', async () => {
    const sql = '  SELECT 1 ';
    expect(ensureSemicolon(sql)).toBe('SELECT 1;');
    const output = new TerminalOutputBuffer();
    const write = vi.fn((_input: string) => {
      output.append('| __JMS_SQL_START_abc__ |\n');
      output.append('| 1 |\n');
      output.append('| __JMS_SQL_END_abc__ |\n');
    });
    const executor = new MysqlCliExecutor({ idFactory: () => 'abc' });

    await executor.execute({
      terminalId: 'terminal-1',
      assetId: 'mysql-1',
      assetName: 'mysql-1',
      sql,
      write,
      output,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    });

    const payload = write.mock.calls[0][0];
    expect(payload.split('\n')[1]).toBe(ensureSemicolon(sql));
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
