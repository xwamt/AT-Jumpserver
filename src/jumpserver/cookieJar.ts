import { buildOrigin } from './urls';

export interface JumpServerCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
}

export function resolveJumpServerUrl(baseUrl: string, pathOrUrl: string, allowedOrigins: string[] = []): string {
  const origin = buildOrigin(baseUrl);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${origin}${pathOrUrl}`;
  const target = new URL(url);
  if (target.origin !== origin && !allowedOrigins.includes(target.origin)) {
    throw new Error(`Refusing cross-origin JumpServer request to ${target.origin} (expected ${origin}).`);
  }
  return url;
}

export function parseSetCookieHeader(header: string, requestUrl: string): JumpServerCookie[] {
  const request = new URL(requestUrl);
  const cookies: JumpServerCookie[] = [];
  for (const rawCookie of splitSetCookieHeader(header)) {
    const [nameValue, ...attributes] = rawCookie.split(';');
    const separator = nameValue.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const domainAttribute = cookieAttribute(attributes, 'domain');
    const pathAttribute = cookieAttribute(attributes, 'path');
    cookies.push({
      name: nameValue.slice(0, separator).trim(),
      value: nameValue.slice(separator + 1).trim(),
      domain: (domainAttribute ? domainAttribute.replace(/^\./, '') : request.hostname).toLowerCase(),
      hostOnly: !domainAttribute,
      // JumpServer (Django) always sends Path=/. RFC 6265 §5.1.4 would instead derive the
      // default from the request path, which would strand a /koko-issued cookie away from
      // the /api calls that share the same session.
      path: pathAttribute && pathAttribute.startsWith('/') ? pathAttribute : '/',
      secure: hasCookieFlag(attributes, 'secure')
    });
  }
  return cookies;
}

export function cookiesForUrl(cookies: JumpServerCookie[], url: string): string {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  const isSecureTransport = target.protocol === 'https:';
  return cookies
    .filter((cookie) => (cookie.secure ? isSecureTransport : true))
    .filter((cookie) => domainMatches(host, cookie))
    .filter((cookie) => pathMatches(target.pathname, cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function domainMatches(host: string, cookie: JumpServerCookie): boolean {
  return cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/**
 * Deserializes a persisted web session defensively: only the two cookie names
 * the KoKo handshake needs are accepted, and only when they still belong to
 * this bastion's host - the store is keyed by bastion id, but the base URL can
 * have been edited since the session was saved.
 */
export function parseStoredWebSession(raw: string, baseUrl: string): JumpServerCookie[] {
  let host: string;
  try {
    host = new URL(buildOrigin(baseUrl)).hostname.toLowerCase();
  } catch {
    return [];
  }
  let parsed: { cookies?: unknown };
  try {
    parsed = JSON.parse(raw) as { cookies?: unknown };
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
    return [];
  }
  const cookies: JumpServerCookie[] = [];
  for (const item of parsed.cookies) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.value !== 'string') {
      continue;
    }
    if (record.name !== 'sessionid' && record.name !== 'csrftoken') {
      continue;
    }
    const cookie: JumpServerCookie = {
      name: record.name,
      value: record.value,
      domain: typeof record.domain === 'string' && record.domain ? record.domain.toLowerCase() : host,
      hostOnly: record.hostOnly !== false,
      path: typeof record.path === 'string' && record.path.startsWith('/') ? record.path : '/',
      secure: record.secure === true
    };
    if (!domainMatches(host, cookie)) {
      continue;
    }
    cookies.push(cookie);
  }
  return cookies;
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function cookieAttribute(attributes: string[], name: string): string | undefined {
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    if (separator > 0 && attribute.slice(0, separator).trim().toLowerCase() === name) {
      return attribute.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function hasCookieFlag(attributes: string[], name: string): boolean {
  return attributes.some((attribute) => attribute.trim().toLowerCase() === name);
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}
