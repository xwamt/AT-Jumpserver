import { createHash } from 'node:crypto';
import { buildOrigin, rewritePaginationRef } from './urls';

export { buildOrigin, rewritePaginationRef };

export function buildSelfAssetListPath(limit: number, offset: number): string {
  const params = new URLSearchParams({
    all: '1',
    display: '1',
    limit: String(limit),
    offset: String(offset)
  });
  return `/api/v1/perms/users/self/assets/?${params.toString()}`;
}

export function pageSignature(records: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(records)).digest('hex');
}

const WAIT_RE = /Expected available in (\d+) second/i;

export function throttleWaitMs(message: string, details?: unknown): number {
  const extra = details && typeof details === 'object' && 'detail' in details
    ? String((details as { detail?: unknown }).detail ?? '')
    : '';
  const match = WAIT_RE.exec(`${message} ${extra}`);
  if (!match) {
    return 5_000;
  }
  return Math.max(Number(match[1]), 1) * 1_000;
}
