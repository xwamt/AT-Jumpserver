import { EventEmitter } from 'node:events';

export interface CollectUntilOptions {
  /**
   * Terminator bytes. Completion is only re-evaluated once these bytes are in
   * the window, so `isComplete` / `completePattern` must never report complete
   * for text that does not contain `marker`.
   */
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

const INITIAL_WINDOW_BYTES = 8 * 1024;

export class TerminalOutputBuffer {
  private readonly buffered: SlidingByteWindow;
  private readonly events = new EventEmitter();

  constructor(maxBufferedBytes = 128 * 1024) {
    this.buffered = new SlidingByteWindow(maxBufferedBytes);
  }

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.buffered.append(next);
    this.events.emit('data', next);
  }

  text(): string {
    return this.buffered.toString();
  }

  collectUntil(options: CollectUntilOptions): Promise<CollectedTerminalOutput> {
    // Keep a sliding window large enough for marker detection after noisy CLI echo.
    // Prefer recent bytes because useful command/SQL results appear near the end marker.
    const markerBytes = Buffer.from(options.marker, 'utf8');
    const maxWindowBytes = Math.max(
      options.maxOutputBytes * 4,
      options.maxOutputBytes + 256 * 1024,
      markerBytes.byteLength + 64 * 1024
    );
    const window = new SlidingByteWindow(maxWindowBytes);
    let settled = false;
    // Absolute stream offset already searched for the marker. The next search
    // rewinds by markerBytes.byteLength - 1 so an occurrence split across chunk
    // boundaries is still found exactly once.
    let scannedOffset = 0;
    let markerSeen = false;

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

        const truncated = window.droppedBytes > 0;
        const text = window.toString();
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

        const outputBuffer = truncatePreferringTail(window.toBuffer(), options.maxOutputBytes);
        resolve({
          output: outputBuffer.buffer.toString('utf8'),
          terminator: undefined,
          timedOut,
          truncated: truncated || outputBuffer.truncated
        });
      };

      const onData = (chunk: Buffer): void => {
        window.append(chunk);
        // Decoding the window costs as much as the window is long, so gate it on
        // a byte-level scan of just the bytes that could hold a new occurrence.
        if (!markerSeen) {
          const searchFrom = Math.max(window.startOffset, scannedOffset - (markerBytes.byteLength - 1));
          markerSeen = window.indexOf(markerBytes, searchFrom) >= 0;
        }
        scannedOffset = window.endOffset;
        if (markerSeen && isComplete(window.toString())) {
          finish(false);
        }
      };

      const timeout = setTimeout(() => finish(true), options.timeoutMs);
      this.events.on('data', onData);
    });
  }
}

/**
 * Byte window that keeps only the most recent `maxBytes` and appends in
 * amortised constant time.
 *
 * Eviction just advances a read index; the backing store is only compacted (or
 * grown) when the write index runs off its end. That is what keeps a 10 MB
 * command output linear instead of quadratic.
 */
class SlidingByteWindow {
  private buffer: Buffer;
  private start = 0;
  private end = 0;
  private dropped = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(maxBytes, 1);
    this.buffer = Buffer.alloc(Math.min(INITIAL_WINDOW_BYTES, this.maxBytes));
  }

  get byteLength(): number {
    return this.end - this.start;
  }

  /** Bytes evicted from the front so far. */
  get droppedBytes(): number {
    return this.dropped;
  }

  /** Absolute stream offset of the first retained byte. */
  get startOffset(): number {
    return this.dropped;
  }

  /** Absolute stream offset one past the last retained byte. */
  get endOffset(): number {
    return this.dropped + this.byteLength;
  }

  append(chunk: Buffer): void {
    let source = chunk;
    if (chunk.byteLength > this.maxBytes) {
      // Nothing already held can survive, so drop it all rather than growing the
      // backing store to fit a chunk we are about to evict anyway.
      source = chunk.subarray(chunk.byteLength - this.maxBytes);
      this.dropped += this.byteLength + (chunk.byteLength - this.maxBytes);
      this.start = 0;
      this.end = 0;
    }
    this.reserve(source.byteLength);
    source.copy(this.buffer, this.end);
    this.end += source.byteLength;
    const overflow = this.byteLength - this.maxBytes;
    if (overflow > 0) {
      this.start += overflow;
      this.dropped += overflow;
    }
  }

  /** Absolute stream offset of `needle` at or after `fromOffset`, or -1. */
  indexOf(needle: Buffer, fromOffset: number): number {
    const live = this.buffer.subarray(this.start, this.end);
    const from = Math.max(0, fromOffset - this.dropped);
    if (from >= live.byteLength) {
      return -1;
    }
    const found = live.indexOf(needle, from);
    return found < 0 ? -1 : this.dropped + found;
  }

  toBuffer(): Buffer {
    return this.buffer.subarray(this.start, this.end);
  }

  toString(): string {
    return this.buffer.toString('utf8', this.start, this.end);
  }

  private reserve(extra: number): void {
    if (this.end + extra <= this.buffer.byteLength) {
      return;
    }
    const live = this.byteLength;
    if (live + extra > this.buffer.byteLength) {
      const capacity = Math.max(live + extra, Math.min(this.buffer.byteLength * 2, this.maxBytes * 2));
      const grown = Buffer.alloc(capacity);
      this.buffer.copy(grown, 0, this.start, this.end);
      this.buffer = grown;
    } else {
      this.buffer.copy(this.buffer, 0, this.start, this.end);
    }
    this.start = 0;
    this.end = live;
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
