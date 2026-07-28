import { EventEmitter } from 'node:events';

export interface CollectUntilOptions {
  marker: string;
  /**
   * Optional stronger completion check. Use when the typed command/SQL echo may
   * contain `marker` before the real terminator is printed (e.g. shell printf).
   */
  completePattern?: RegExp;
  /** Preferred over completePattern when provided. */
  isComplete?: (text: string) => boolean;
  /**
   * Where to slice captured output when complete. Defaults to the start of
   * `marker` (not the start of a wider completePattern match).
   */
  findTerminatorIndex?: (text: string) => number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CollectedTerminalOutput {
  output: string;
  terminator?: string;
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
    // Keep a sliding window large enough for marker detection after noisy CLI echo.
    // Prefer recent bytes because useful command/SQL results appear near the end marker.
    let window = Buffer.alloc(0);
    let settled = false;
    let truncated = false;
    const markerByteLength = Buffer.byteLength(options.marker, 'utf8');
    const maxWindowBytes = Math.max(
      options.maxOutputBytes * 4,
      options.maxOutputBytes + 256 * 1024,
      markerByteLength + 64 * 1024
    );

    const isComplete = (text: string): boolean => {
      if (options.isComplete) {
        return options.isComplete(text);
      }
      if (options.completePattern) {
        return options.completePattern.test(text);
      }
      return text.includes(options.marker);
    };

    const markerIndex = (text: string): number => {
      if (options.findTerminatorIndex) {
        return options.findTerminatorIndex(text);
      }
      if (options.completePattern) {
        const digitMatch = new RegExp(
          `${escapeRegExp(options.marker)}\\d+`,
          'm'
        ).exec(text);
        if (digitMatch) {
          return digitMatch.index;
        }
      }
      return text.indexOf(options.marker);
    };

    return new Promise((resolve) => {
      const finish = (timedOut: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.events.off('data', onData);

        const text = window.toString('utf8');
        const index = markerIndex(text);
        if (index >= 0) {
          const before = Buffer.from(text.slice(0, index), 'utf8');
          const outputBuffer = truncatePreferringTail(before, options.maxOutputBytes);
          resolve({
            output: outputBuffer.buffer.toString('utf8'),
            terminator: text.slice(index),
            timedOut,
            truncated: truncated || outputBuffer.truncated
          });
          return;
        }

        const outputBuffer = truncatePreferringTail(window, options.maxOutputBytes);
        resolve({
          output: outputBuffer.buffer.toString('utf8'),
          terminator: undefined,
          timedOut,
          truncated: truncated || outputBuffer.truncated
        });
      };

      const onData = (chunk: Buffer): void => {
        window = Buffer.concat([window, chunk]);
        if (window.byteLength > maxWindowBytes) {
          truncated = true;
          window = window.subarray(window.byteLength - maxWindowBytes);
        }
        if (isComplete(window.toString('utf8'))) {
          finish(false);
        }
      };

      const timeout = setTimeout(() => finish(true), options.timeoutMs);
      this.events.on('data', onData);
    });
  }
}

function truncatePreferringTail(
  data: Buffer,
  maxOutputBytes: number
): { buffer: Buffer; truncated: boolean } {
  if (data.byteLength <= maxOutputBytes) {
    return { buffer: data, truncated: false };
  }
  return {
    buffer: data.subarray(data.byteLength - maxOutputBytes),
    truncated: true
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
