const SENSITIVE_KEY = /password|secret|token|cookie|authorization|private/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Authorization:\s*Bearer\s+[^;\r\n]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Cookie:\s*[^;\r\n]+/gi, 'Cookie: [REDACTED]')
    .replace(/\b(token|password|secret|cookie)=([^;\s]+)/gi, '$1=[REDACTED]');
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return redactSensitiveText(String(error));
}
