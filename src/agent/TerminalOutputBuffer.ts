import { EventEmitter } from 'node:events';

export interface CollectUntilOptions {
  marker: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CollectedTerminalOutput {
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export class TerminalOutputBuffer {
  private bytes = Buffer.alloc(0);
  private readonly events = new EventEmitter();

  constructor(private readonly maxBufferedBytes = 128 * 1024) {}

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.bytes = Buffer.concat([this.bytes, next]);
    if (this.bytes.byteLength > this.maxBufferedBytes) {
      this.bytes = this.bytes.subarray(this.bytes.byteLength - this.maxBufferedBytes);
    }
    this.events.emit('data', next);
  }

  text(): string {
    return this.bytes.toString('utf8');
  }

  collectUntil(options: CollectUntilOptions): Promise<CollectedTerminalOutput> {
    let collected = Buffer.alloc(0);
    let settled = false;
    let truncated = false;

    return new Promise((resolve) => {
      const finish = (timedOut: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.events.off('data', onData);
        const text = collected.toString('utf8');
        const index = text.indexOf(options.marker);
        resolve({
          output: index >= 0 ? text.slice(0, index) : text,
          timedOut,
          truncated
        });
      };

      const onData = (chunk: Buffer): void => {
        if (collected.byteLength < options.maxOutputBytes) {
          const remaining = options.maxOutputBytes - collected.byteLength;
          collected = Buffer.concat([collected, chunk.subarray(0, remaining)]);
          if (chunk.byteLength > remaining) {
            truncated = true;
          }
        } else {
          truncated = true;
        }
        if (collected.toString('utf8').includes(options.marker)) {
          finish(false);
        }
      };

      const timeout = setTimeout(() => finish(true), options.timeoutMs);
      this.events.on('data', onData);
    });
  }
}
