import { describe, expect, it } from 'vitest';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';

describe('TerminalOutputBuffer', () => {
  it('keeps bounded output text', () => {
    const buffer = new TerminalOutputBuffer(5);
    buffer.append(Buffer.from('hello'));
    buffer.append(Buffer.from(' world'));
    expect(buffer.text()).toBe('world');
  });

  it('collects text until a marker appears', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker: 'END-1',
      timeoutMs: 1000,
      maxOutputBytes: 1024
    });

    buffer.append(Buffer.from('before\n'));
    buffer.append(Buffer.from('payload\nEND-1\n'));

    await expect(collection).resolves.toMatchObject({
      output: 'before\npayload\n',
      timedOut: false,
      truncated: false
    });
  });

  it('reports timeout with partial output', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker: 'NEVER',
      timeoutMs: 5,
      maxOutputBytes: 1024
    });
    buffer.append(Buffer.from('partial'));
    await expect(collection).resolves.toMatchObject({
      output: 'partial',
      timedOut: true
    });
  });

  it('still detects end marker after maxOutputBytes truncation from noisy echo', async () => {
    const buffer = new TerminalOutputBuffer(1024 * 1024);
    const collection = buffer.collectUntil({
      marker: '__JMS_SQL_END_abc__',
      timeoutMs: 1000,
      maxOutputBytes: 64
    });

    buffer.append(Buffer.from('x'.repeat(200)));
    buffer.append(Buffer.from('\nresult rows\n| __JMS_SQL_END_abc__ |\n'));

    await expect(collection).resolves.toMatchObject({
      timedOut: false,
      truncated: true,
      terminator: expect.stringContaining('__JMS_SQL_END_abc__')
    });
  });

  it('keeps the recent output near the end marker when truncated', async () => {
    const buffer = new TerminalOutputBuffer(1024 * 1024);
    const collection = buffer.collectUntil({
      marker: 'END',
      timeoutMs: 1000,
      maxOutputBytes: 10
    });

    buffer.append(Buffer.from('0123456789ABCDEF'));
    buffer.append(Buffer.from('END'));

    const result = await collection;
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(10);
    expect(result.output).toBe('6789ABCDEF');
    expect(result.terminator).toContain('END');
  });

  it('ignores marker text until completePattern matches', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker: '__JMS_CMD_END_abc__',
      completePattern: /__JMS_CMD_END_abc__\d+/,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    });

    buffer.append(Buffer.from("printf '\\n__JMS_CMD_END_abc__%s\\n' \"$?\"\n"));
    buffer.append(Buffer.from('command output\n'));
    buffer.append(Buffer.from('__JMS_CMD_END_abc__0\n'));

    await expect(collection).resolves.toMatchObject({
      timedOut: false,
      output: expect.stringContaining('command output'),
      terminator: expect.stringMatching(/^__JMS_CMD_END_abc__0/)
    });
  });
});
