export function buildOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export function rewritePaginationRef(baseUrl: string, nextRef: string): string {
  const origin = buildOrigin(baseUrl);
  const absolute = nextRef.startsWith('http://') || nextRef.startsWith('https://')
    ? nextRef
    : `${origin}${nextRef.startsWith('/') ? '' : '/'}${nextRef}`;
  const parsed = new URL(absolute);
  parsed.protocol = new URL(origin).protocol;
  parsed.host = new URL(origin).host;
  return parsed.toString();
}
