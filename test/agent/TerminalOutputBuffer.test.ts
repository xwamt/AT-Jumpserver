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
});
