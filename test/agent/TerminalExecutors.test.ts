import { describe, expect, it, vi } from 'vitest';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';
import { MysqlCliExecutor, ShellTerminalExecutor } from '../../src/agent/TerminalExecutors';

describe('TerminalExecutors', () => {
  it('runs shell commands with marker-bounded output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toContain('__JMS_CMD_START_');
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

  it('runs MySQL SQL with marker-bounded output', async () => {
    const output = new TerminalOutputBuffer();
    const write = vi.fn((input: string) => {
      expect(input).toContain("SELECT '__JMS_SQL_START_abc__';");
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
});
