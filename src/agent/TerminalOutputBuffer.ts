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
   * Cheap incremental gate over just the newly appended tail (plus a small
   * overlap). Once a full-window `isComplete` check has failed, further chunks
   * only re-run `isComplete` when this returns true — so decoding and scanning
   * the whole window stops being per-chunk work. Must return true whenever the
   * appended bytes could flip `isComplete` to true (e.g. the tail contains a
   * marker or matches the terminator pattern). Without it, a custom
   * `isComplete` is re-run on the full window every chunk.
   */
  isCompleteTail?: (tail: string) => boolean;
  /**
   * Where to slice captured output when complete. Defaults to the start of
   * `marker` (not the start of a wider completePattern match).
   */
  findTerminatorIndex?: (text: string) => number;
  /**
   * Bytes proving the wrapped command actually started executing (e.g. the
   * printed start marker). Only used by the grace check below; detection is
   * sticky, so a marker that later slides out of the window still counts.
   */
  startMarker?: string;
  /**
   * Give up early (resolve with `timedOut` + `startMarkerMissing`) when
   * `startMarker` has not been seen after this many ms. Guards against a
   * terminal stuck in `less`/`vim`/a password prompt, where the wrapper never
   * runs and the user would otherwise wait out the full `timeoutMs`.
   * Conservative: fires only when NOT A SINGLE byte-run matching `startMarker`
   * has arrived by the deadline. Trade-off: a link slow enough to echo the
   * marker only after the grace period false-positives at the grace deadline
   * instead of completing later.
   */
  startMarkerGraceMs?: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CollectedTerminalOutput {
  output: string;
  terminator?: string;
  timedOut: boolean;
  truncated: boolean;
  /** True when collection gave up because `startMarker` never appeared within the grace period. */
  startMarkerMissing?: boolean;
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
    const startMarkerBytes = options.startMarker
      ? Buffer.from(options.startMarker, 'utf8')
      : undefined;
    const maxWindowBytes = Math.max(
      options.maxOutputBytes * 4,
      options.maxOutputBytes + 256 * 1024,
      markerBytes.byteLength + 64 * 1024
    );
    const window = new SlidingByteWindow(maxWindowBytes);
    let settled = false;
    // Absolute stream offset already searched for the markers. The next search
    // rewinds by the needle length - 1 so an occurrence split across chunk
    // boundaries is still found exactly once.
    let scannedOffset = 0;
    let markerSeen = false;
    let startMarkerSeen = false;
    let startMarkerMissing = false;
    // Absolute offset through which completion-relevant text has already been
    // examined — by a full-window check or by the tail gate; -1 until the
    // first full check has run. Later chunks only decode the bytes past this
    // point (plus overlap).
    let checkedThroughOffset = -1;
    // Enough already-checked bytes that a marker, or a short terminator match
    // (marker + exit-code digits), spanning the previous chunk boundary is
    // still fully visible in the tail.
    const tailOverlapBytes = markerBytes.byteLength + 256;

    const isComplete = (text: string): boolean => {
      if (options.isComplete) {
        return options.isComplete(text);
      }
      if (options.completePattern) {
        return options.completePattern.test(text);
      }
      return text.includes(options.marker);
    };

    // A gate is only sound when we know what can flip completion: an explicit
    // isCompleteTail, or the built-in checks (whose matches fit within the
    // overlap). An opaque custom isComplete without a tail gate keeps the old
    // full-window behavior.
    const tailGate: ((tail: string) => boolean) | undefined =
      options.isCompleteTail ??
      (options.isComplete
        ? undefined
        : options.completePattern
          ? (tail) => options.completePattern!.test(tail)
          : (tail) => tail.includes(options.marker));

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
        if (graceTimeout !== undefined) {
          clearTimeout(graceTimeout);
        }
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
            truncated: truncated || outputBuffer.truncated,
            startMarkerMissing
          });
          return;
        }

        const outputBuffer = truncatePreferringTail(window.toBuffer(), options.maxOutputBytes);
        resolve({
          output: outputBuffer.buffer.toString('utf8'),
          terminator: undefined,
          timedOut,
          truncated: truncated || outputBuffer.truncated,
          startMarkerMissing
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
        if (startMarkerBytes && !startMarkerSeen) {
          const searchFrom = Math.max(window.startOffset, scannedOffset - (startMarkerBytes.byteLength - 1));
          startMarkerSeen = window.indexOf(startMarkerBytes, searchFrom) >= 0;
        }
        scannedOffset = window.endOffset;
        if (!markerSeen) {
          return;
        }
        // The first evaluation after the marker lands (and every one when no
        // tail gate is available) checks the full window. Afterwards only the
        // appended tail plus overlap is decoded to decide whether completion
        // could have flipped — re-decoding the whole window per chunk is
        // quadratic on large outputs.
        if (checkedThroughOffset < 0 || !tailGate) {
          if (isComplete(window.toString())) {
            finish(false);
            return;
          }
          checkedThroughOffset = window.endOffset;
          return;
        }
        const tailFrom = Math.max(window.startOffset, checkedThroughOffset - tailOverlapBytes);
        const tail = window.toStringFrom(tailFrom);
        checkedThroughOffset = window.endOffset;
        if (tailGate(tail) && isComplete(window.toString())) {
          finish(false);
        }
      };

      const timeout = setTimeout(() => finish(true), options.timeoutMs);
      // Mitigation for terminals stuck in an interactive program (less/vim/
      // password prompt): if the wrapper's start marker has produced no bytes
      // at all by the grace deadline, the command almost certainly never ran,
      // so fail fast instead of sitting out the full timeout. Deliberately
      // conservative — any sighting of the marker bytes disarms this — but a
      // marker that only arrives after the grace deadline still loses.
      const graceTimeout =
        startMarkerBytes && options.startMarkerGraceMs !== undefined
          ? setTimeout(() => {
              if (!startMarkerSeen) {
                startMarkerMissing = true;
                finish(true);
              }
            }, options.startMarkerGraceMs)
          : undefined;
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

  /**
   * Decode from an absolute stream offset (clamped to the window) to the end.
   * A cut inside a multi-byte character only mangles the first decoded glyph,
   * which is harmless for ASCII marker scanning.
   */
  toStringFrom(fromOffset: number): string {
    const relative = Math.min(Math.max(fromOffset - this.dropped, 0), this.byteLength);
    return this.buffer.toString('utf8', this.start + relative, this.end);
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
