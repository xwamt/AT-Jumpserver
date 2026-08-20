import { UserVisibleError } from '../utils/errors';

export type JumpServerFailureClass =
  | 'auth-rejected'
  | 'forbidden'
  | 'not-found'
  | 'throttled'
  | 'server-error'
  | 'client-error'
  | 'unexpected-status';

/**
 * "HTTP 502" in a log line tells a user nothing they can act on. The class does:
 * `auth-rejected` means re-enter the password, `server-error` means the bastion
 * is unwell, `throttled` means back off.
 */
export function classifyRestFailure(status: number): JumpServerFailureClass {
  if (status === 401) {
    return 'auth-rejected';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 408 || status === 429) {
    return 'throttled';
  }
  if (status >= 500) {
    return 'server-error';
  }
  if (status >= 400) {
    return 'client-error';
  }
  return 'unexpected-status';
}

export function apiErrorMessageFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['detail', 'msg', 'error', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

export class JumpServerApiError extends UserVisibleError {
  readonly statusCode?: number;
  readonly method?: string;
  readonly path?: string;
  readonly reason: JumpServerFailureClass;
  readonly details?: unknown;

  constructor(
    detail: string,
    input: {
      statusCode?: number;
      method?: string;
      path?: string;
      reason: JumpServerFailureClass;
      details?: unknown;
    }
  ) {
    const statusPart = input.statusCode !== undefined ? `HTTP ${input.statusCode}` : 'request failed';
    super(`JumpServer request failed with ${statusPart}: ${detail}`);
    this.name = 'JumpServerApiError';
    this.statusCode = input.statusCode;
    this.method = input.method;
    this.path = input.path;
    this.reason = input.reason;
    this.details = input.details;
  }
}
