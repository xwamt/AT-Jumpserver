/**
 * How long the MCP command-confirmation modal may stay unanswered before it
 * counts as a cancel. The hub's invoke timeout is 120s, after which it retries
 * the call against another window's bridge; resolving the confirm below that
 * ceiling keeps an ignored dialog from turning into a double execution.
 */
export const MCP_CONFIRM_TIMEOUT_MS = 100_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Race a confirmation prompt against the timeout. An unanswered prompt
 * resolves to `undefined`, which callers must treat as a cancel.
 */
export async function confirmWithTimeout<T>(
  prompt: Thenable<T | undefined>,
  timeoutMs: number = MCP_CONFIRM_TIMEOUT_MS
): Promise<T | undefined> {
  return Promise.race([
    Promise.resolve(prompt),
    sleep(timeoutMs).then(() => undefined)
  ]);
}
