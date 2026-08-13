/**
 * The single redaction pass for everything this extension shows or logs.
 *
 * Two copies of `redactSensitiveText` used to live here and under
 * `src/jumpserver/`, and they caught different things: this one knew about PEM
 * keys and `password=`, the other knew about bearer tokens, cookie headers and
 * `token=`. The weaker one was the one `formatError` used, so the production
 * error path - toasts, bridge 500 bodies, terminal status lines - printed KoKo
 * connection tokens and JumpServer session cookies verbatim (audit J-P1-10).
 * This is the union of both, and there is only one of it.
 */
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;
/** A bearer token contains no whitespace, so stopping there keeps the rest of a log line intact. */
const BEARER_PATTERN = /Authorization:\s*Bearer\s+[^;\s]+/gi;
const COOKIE_HEADER_PATTERN = /Cookie:\s*[^;\r\n]+/gi;
/**
 * Value terminators are `;`, `&` and whitespace, which covers the three shapes
 * a credential actually arrives in: a cookie jar (`a=1; b=2`), a KoKo query
 * string (`?token=x&_=1`), and prose (`password = hunter2`). Keeping the key
 * visible is deliberate - a log line that says which credential was rejected is
 * worth far more than one that says `[REDACTED]` and nothing else.
 */
const CREDENTIAL_PAIR_PATTERN = /\b(csrftoken|sessionid|token|password|secret|cookie)\s*=\s*([^;\s&]+)/gi;

const SENSITIVE_KEY = /password|secret|token|cookie|authorization|private/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_PATTERN, 'Authorization: Bearer [REDACTED]')
    .replace(COOKIE_HEADER_PATTERN, 'Cookie: [REDACTED]')
    .replace(CREDENTIAL_PAIR_PATTERN, '$1=[REDACTED]');
}

export function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitiveValue(entry);
  }
  return output;
}

export function toUserMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  if (typeof error === 'string') {
    return redactSensitiveText(error);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return redactSensitiveText(message);
    }
  }
  return 'Unexpected error';
}

/** Alias kept because half the call sites read better with this name. */
export const errorMessage = toUserMessage;
