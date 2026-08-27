import { describe, expect, it } from 'vitest';
import { ShellTerminalExecutor } from '../../src/agent/TerminalExecutors';
import { TerminalOutputBuffer } from '../../src/agent/TerminalOutputBuffer';

const CHUNK_BYTES = 4 * 1024;
const CHUNK_COUNT = 2500;
const MARKER = '__JMS_CMD_END_bench__';

/**
 * A `cat` of a 10 MB file reaches the extension host as ~2500 KoKo frames.
 * Re-concatenating and re-decoding the whole sliding window on every frame
 * turns that into gigabytes of throwaway buffers and strings. These budgets are
 * the regression guard for J7; each one was measured failing first.
 */
const COLLECT_BUDGET_MS = 40;
const EXECUTOR_BUDGET_MS = 40;
const APPEND_BUDGET_MS = 15;

function feed(buffer: TerminalOutputBuffer, chunk: Buffer, tail?: string): number {
  const startedAt = performance.now();
  for (let index = 0; index < CHUNK_COUNT; index += 1) {
    buffer.append(chunk);
  }
  if (tail !== undefined) {
    buffer.append(Buffer.from(tail, 'utf8'));
  }
  return performance.now() - startedAt;
}

function report(label: string, feedMs: number): void {
  // eslint-disable-next-line no-console
  console.log(`[bench] ${label} absorbed ${CHUNK_COUNT}x${CHUNK_BYTES}B in ${feedMs.toFixed(1)}ms`);
}

describe('TerminalOutputBuffer throughput', () => {
  it('absorbs 10 MB before the end marker without rescanning the window each time', async () => {
    const buffer = new TerminalOutputBuffer();
    const collection = buffer.collectUntil({
      marker: MARKER,
      timeoutMs: 60_000,
      maxOutputBytes: 64_000
    });

    const feedMs = feed(buffer, Buffer.alloc(CHUNK_BYTES, 0x61), `\n${MARKER}\n`);
    report('collectUntil', feedMs);
    const result = await collection;

    expect(feedMs).toBeLessThan(COLLECT_BUDGET_MS);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.terminator).toBe(`${MARKER}\n`);
    expect(Buffer.byteLength(result.output, 'utf8')).toBe(64_000);
  }, 120_000);

  it('absorbs 10 MB after end-marker echo without rescanning the window each time', async () => {
    const buffer = new TerminalOutputBuffer();
    const collection = buffer.collectUntil({
      marker: MARKER,
      completePattern: new RegExp(`${MARKER}\\d+`),
      timeoutMs: 60_000,
      maxOutputBytes: 64_000
    });

    // Echo-style sighting: the marker bytes land without an exit code, so the
    // marker gate opens but completion stays pending while 10 MB streams
    // through. D5 regression guard: each chunk may only decode its own tail,
    // not the whole ~320 KB window.
    buffer.append(Buffer.from(`${MARKER} echoed without exit code\n`, 'utf8'));
    const feedMs = feed(buffer, Buffer.alloc(CHUNK_BYTES, 0x61), `\n${MARKER}7\n`);
    report('collectUntil after marker echo', feedMs);
    const result = await collection;

    expect(feedMs).toBeLessThan(COLLECT_BUDGET_MS);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.terminator).toBe(`${MARKER}7\n`);
  }, 120_000);

  it('absorbs 10 MB through the shell executor double-hook path at the same cost', async () => {
    const output = new TerminalOutputBuffer();
    const executor = new ShellTerminalExecutor({ idFactory: () => 'bench' });
    let feedMs = 0;

    const result = await executor.execute({
      terminalId: 'terminal-bench',
      assetId: 'asset-bench',
      assetName: 'bench-host',
      command: 'cat big.log',
      output,
      // The start marker is evicted long before the end marker arrives, so this
      // collection can only end on the timer. Keep that wait out of the budget.
      timeoutMs: 1,
      maxOutputBytes: 64_000,
      write: () => {
        output.append('__JMS_CMD_START_bench__\n');
        feedMs = feed(output, Buffer.alloc(CHUNK_BYTES, 0x61), '\n__JMS_CMD_END_bench__0\n');
        report('ShellTerminalExecutor', feedMs);
      }
    });

    expect(feedMs).toBeLessThan(EXECUTOR_BUDGET_MS);
    // Output larger than the sliding window loses its start marker, and the
    // double-hook contract refuses to accept an end marker without one.
    expect(result.timedOut).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeGreaterThan(0);
  }, 120_000);

  it('absorbs 10 MB into the standing buffer without recopying it each time', () => {
    const buffer = new TerminalOutputBuffer();

    const feedMs = feed(buffer, Buffer.alloc(CHUNK_BYTES, 0x62));
    report('append', feedMs);

    expect(buffer.text()).toHaveLength(128 * 1024);
    expect(feedMs).toBeLessThan(APPEND_BUDGET_MS);
  }, 120_000);
});
