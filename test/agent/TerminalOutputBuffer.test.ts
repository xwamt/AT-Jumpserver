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

  it('detects a marker delivered one byte per chunk', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const marker = '__JMS_CMD_END_abc__';
    const collection = buffer.collectUntil({
      marker,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    });

    buffer.append(Buffer.from('payload\n'));
    for (const byte of Buffer.from(marker, 'utf8')) {
      buffer.append(Buffer.from([byte]));
    }

    await expect(collection).resolves.toMatchObject({
      output: 'payload\n',
      terminator: marker,
      timedOut: false,
      truncated: false
    });
  });

  it('waits for the exit code even when the end marker already landed in an earlier chunk', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const marker = '__JMS_CMD_END_abc__';
    const endWithCode = /__JMS_CMD_END_abc__\d+/;
    const collection = buffer.collectUntil({
      marker,
      isComplete: (text) => endWithCode.test(text),
      findTerminatorIndex: (text) => endWithCode.exec(text)?.index ?? -1,
      timeoutMs: 1000,
      maxOutputBytes: 1024
    });

    buffer.append(Buffer.from(`payload\n${marker}`));
    buffer.append(Buffer.from('7\n'));

    await expect(collection).resolves.toMatchObject({
      output: 'payload\n',
      terminator: `${marker}7\n`,
      timedOut: false
    });
  });

  it('still matches an end marker that arrives after the window slid past the stream start', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const marker = '__JMS_SQL_END_abc__';
    const collection = buffer.collectUntil({
      marker,
      timeoutMs: 1000,
      // maxWindowBytes is derived from maxOutputBytes, so a tiny cap forces the
      // window to slide many times before the marker shows up.
      maxOutputBytes: 16
    });

    for (let index = 0; index < 40; index += 1) {
      buffer.append(Buffer.from('y'.repeat(4096)));
    }
    buffer.append(Buffer.from(`tail\n${marker}\n`));

    await expect(collection).resolves.toMatchObject({
      timedOut: false,
      truncated: true,
      terminator: `${marker}\n`
    });
  });

  it('forgets an end marker once the sliding window has dropped it', async () => {
    const marker = '__JMS_SQL_END_abc__';
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker,
      completePattern: new RegExp(`${marker}\\d+`),
      timeoutMs: 20,
      maxOutputBytes: 16
    });

    // The marker lands without its exit code, so collection keeps waiting; then
    // 320 KiB of noise pushes it out of the window (maxWindowBytes is at least
    // maxOutputBytes + 256 KiB) and it must not count as seen any more.
    buffer.append(Buffer.from(marker));
    buffer.append(Buffer.from('z'.repeat(320 * 1024)));

    await expect(collection).resolves.toMatchObject({
      timedOut: true,
      truncated: true,
      terminator: undefined
    });
  });

  it('reports truncated only once the window actually dropped bytes', async () => {
    const buffer = new TerminalOutputBuffer(1024);
    const collection = buffer.collectUntil({
      marker: 'END',
      timeoutMs: 1000,
      maxOutputBytes: 64 * 1024
    });

    buffer.append(Buffer.from('a'.repeat(64 * 1024)));
    buffer.append(Buffer.from('END'));

    await expect(collection).resolves.toMatchObject({
      timedOut: false,
      truncated: false,
      terminator: 'END'
    });
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
