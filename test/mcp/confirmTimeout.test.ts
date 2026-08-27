import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmWithTimeout,
  MCP_CONFIRM_TIMEOUT_MS
} from '../../src/mcp/confirmTimeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('confirmWithTimeout', () => {
  it('stays below the hub 120s invoke timeout so a retry cannot double-execute', () => {
    expect(MCP_CONFIRM_TIMEOUT_MS).toBe(100_000);
    expect(MCP_CONFIRM_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it('returns the answer when the user responds in time', async () => {
    await expect(confirmWithTimeout(Promise.resolve('Continue'))).resolves.toBe('Continue');
  });

  it('resolves undefined (cancel) when the modal is never answered', async () => {
    vi.useFakeTimers();
    const neverAnswered = new Promise<string>(() => {});

    const result = confirmWithTimeout(neverAnswered);
    await vi.advanceTimersByTimeAsync(MCP_CONFIRM_TIMEOUT_MS);

    await expect(result).resolves.toBeUndefined();
  });

  it('keeps a late dismissal from racing past the timeout', async () => {
    vi.useFakeTimers();
    let answer: ((value: string) => void) | undefined;
    const prompt = new Promise<string>((resolve) => {
      answer = resolve;
    });

    const result = confirmWithTimeout(prompt);
    await vi.advanceTimersByTimeAsync(MCP_CONFIRM_TIMEOUT_MS);
    answer?.('Continue');

    await expect(result).resolves.toBeUndefined();
  });
});
