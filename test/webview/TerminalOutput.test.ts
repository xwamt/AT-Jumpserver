import { describe, expect, it } from 'vitest';
import { writeTerminalOutputMessage } from '../../webview/terminal/output';

function recorder() {
  const writes: Array<string | Uint8Array> = [];
  return {
    writes,
    terminal: {
      write(data: string | Uint8Array): void {
        writes.push(data);
      }
    }
  };
}

describe('writeTerminalOutputMessage', () => {
  it('decodes a base64 payload into the exact upstream bytes', () => {
    const { writes, terminal } = recorder();
    const bytes = Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff, 0xfe]);

    const handled = writeTerminalOutputMessage(
      { type: 'outputBase64', payload: Buffer.from(bytes).toString('base64') },
      terminal
    );

    expect(handled).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(writes[0] as Uint8Array)).toEqual(Array.from(bytes));
  });

  it('round-trips a payload larger than a single PTY frame', () => {
    const { writes, terminal } = recorder();
    const bytes = new Uint8Array(64 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    writeTerminalOutputMessage({ type: 'outputBase64', payload: Buffer.from(bytes).toString('base64') }, terminal);

    expect(Buffer.from(writes[0] as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it('ignores a base64 message whose payload is not a string', () => {
    const { writes, terminal } = recorder();

    expect(writeTerminalOutputMessage({ type: 'outputBase64', payload: [1, 2, 3] }, terminal)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('still writes plain text output messages', () => {
    const { writes, terminal } = recorder();

    expect(writeTerminalOutputMessage({ type: 'output', payload: 'hello' }, terminal)).toBe(true);
    expect(writes).toEqual(['hello']);
  });

  it('ignores unrelated message types', () => {
    const { writes, terminal } = recorder();

    expect(writeTerminalOutputMessage({ type: 'status', payload: 'Connecting' }, terminal)).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
