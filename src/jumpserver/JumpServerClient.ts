import type { CachedJumpServerAsset, CachedJumpServerNode } from '../config/schema';
import type { JumpServerAccountRef, JumpServerConnectionProtocol, JumpServerEndpoint, JumpServerSettingsWithPassword } from './types';
import { createJumpServerFetch, type FetchLike } from './restTransport';
import WebSocket from 'ws';
export type KokoWebSocket = Pick<WebSocket, 'send' | 'close' | 'on'>;
export type WebSocketFactory = (url: string, options: WebSocket.ClientOptions) => Promise<KokoWebSocket>;

interface ListPage {
  results?: unknown[];
  items?: unknown[];
  data?: unknown[];
  count?: number;
  total?: number;
}

type AssetPathMap = Map<string, string[]>;

export interface JumpServerTimeouts {
  /** Auth, connection tokens, endpoints, KoKo warmup: single lookups. */
  requestMs: number;
  /** Bulk permission listings, which a large deployment answers slowly. */
  listingMs: number;
  /** KoKo WebSocket handshake. */
  webSocketMs: number;
}

/**
 * Without these, a JumpServer that accepts the TCP connection and then stops
 * talking leaves the tree view, the terminal and every MCP tool call pending
 * forever, with no cancel affordance anywhere in the UI.
 */
export const DEFAULT_JUMPSERVER_TIMEOUTS: JumpServerTimeouts = {
  requestMs: 15_000,
  listingMs: 60_000,
  webSocketMs: 15_000
};

export const DEFAULT_CONNECT_OPTIONS = {
  charset: 'default',
  disableautohash: false,
  token_reusable: false,
  resolution: 'auto',
  backspaceAsCtrlH: false,
  appletConnectMethod: 'web',
  virtualappConnectMethod: 'web',
  reusable: false,
  rdp_connection_speed: 'auto'
} as const;

export const DEFAULT_MYSQL_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export const DEFAULT_SFTP_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export function buildOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export interface JumpServerCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
}

export function resolveJumpServerUrl(baseUrl: string, pathOrUrl: string): string {
  const origin = buildOrigin(baseUrl);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${origin}${pathOrUrl}`;
  const target = new URL(url);
  if (target.origin !== origin) {
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

export function buildKokoConnectUrl(baseUrl: string, tokenId: string, timestamp = Date.now()): string {
  const origin = buildOrigin(baseUrl);
  return `${origin}/koko/connect/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function buildKokoWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now()
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  return `${scheme}://${authority}/koko/ws/terminal/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function buildKokoSftpWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now()
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  return `${scheme}://${authority}/koko/ws/sftp/?token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function parseCsrfMiddlewareToken(html: string): string {
  const match = html.match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/i);
  if (!match) {
    throw new Error('Unable to find csrfmiddlewaretoken in JumpServer login page.');
  }
  return match[1];
}

export function normalizeJumpServerAsset(item: Record<string, any>): CachedJumpServerAsset {
  const platform = item.platform;
  const category = item.category;
  const type = item.type;
  const zone = item.zone;
  const nodePath = extractNodePath(item);
  const zoneName = typeof zone === 'object' && zone ? String(zone.name || '') : String(zone || '');

  return {
    id: String(item.id || ''),
    name: String(item.name || item.address || item.id || ''),
    address: String(item.address || ''),
    platform: typeof platform === 'object' && platform ? String(platform.name || '') : String(platform || ''),
    category: typeof category === 'object' && category ? String(category.value || '') : String(category || ''),
    type: typeof type === 'object' && type ? String(type.value || '') : String(type || ''),
    zoneName: zoneName || nodePath.at(-1) || '',
    nodePath,
    protocolNames: extractProtocolNames(item),
    raw: item
  };
}

export function extractNodePath(item: Record<string, any>): string[] {
  const candidates: string[][] = [];
  for (const field of ['node_path', 'nodePath', 'nodes_display', 'nodesDisplay']) {
    candidates.push(parseNodePathValue(item[field]));
  }
  const nodes = Array.isArray(item.nodes) ? item.nodes : [];
  candidates.push(nodes.flatMap((node) => parseNodeName(node)));
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    for (const field of ['full_value', 'fullValue', 'full_name', 'fullName', 'path', 'value', 'name']) {
      candidates.push(parseNodePathValue((node as Record<string, unknown>)[field]));
    }
  }
  return candidates.reduce<string[]>((best, candidate) => candidate.length > best.length ? candidate : best, []);
}

function parseNodeName(node: unknown): string[] {
  if (!node || typeof node !== 'object') {
    return [];
  }
  const name = (node as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? [name.trim()] : [];
}

function parseNodePathValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseNodePathValue(entry));
  }
  if (!value) {
    return [];
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['full_value', 'fullValue', 'full_name', 'fullName', 'path', 'value', 'name']) {
      const parsed = parseNodePathValue(record[field]);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return [];
  }
  return String(value)
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function extractProtocolNames(item: Record<string, any>): string[] {
  const rawProtocols = Array.isArray(item.permed_protocols)
    ? item.permed_protocols
    : Array.isArray(item.protocols)
      ? item.protocols
      : [];
  return rawProtocols
    .map((protocol: any) => String(protocol?.name || ''))
    .filter((name: string) => name.length > 0);
}

export function resolveFirstUsableAccount(detail: Record<string, any>): JumpServerAccountRef {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];
  const preferred = accounts.find((account) => account?.has_secret === true && !String(account?.alias ?? '').startsWith('@')) ?? accounts[0];
  if (preferred) {
    const id = preferred.id ? String(preferred.id) : '';
    const alias = preferred.alias ? String(preferred.alias) : undefined;
    const username = String(preferred.username || preferred.name || alias || '');
    if (id && username) {
      return {
        id,
        alias,
        username,
        hasSecret: typeof preferred.has_secret === 'boolean' ? preferred.has_secret : undefined
      };
    }
  }
  throw new Error('No usable JumpServer account was returned for this asset.');
}


export function buildConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  protocol: JumpServerConnectionProtocol;
}): Record<string, unknown> {
  if (input.protocol === 'mysql') {
    return buildMysqlConnectionTokenPayload(input);
  }
  if (input.protocol === 'sftp') {
    return buildSftpConnectionTokenPayload(input);
  }
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: input.protocol,
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'web_cli',
    connect_options: DEFAULT_CONNECT_OPTIONS
  };
}

export function buildSftpConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: 'sftp',
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'sftp',
    connect_options: DEFAULT_SFTP_CONNECT_OPTIONS
  };
}

export function buildMysqlConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.alias || input.account.id,
    protocol: 'mysql',
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'db_client',
    connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
  };
}


export async function defaultWebSocketFactory(
  url: string,
  options: WebSocket.ClientOptions,
  timeoutMs = DEFAULT_JUMPSERVER_TIMEOUTS.webSocketMs
): Promise<WebSocket> {
  const socket = new WebSocket(url, ['JMS-KOKO'], options);
  await new Promise<void>((resolve, reject) => {
    // Both handshake listeners have to come off on settle: the session attaches
    // its own 'error' handler afterwards, and a stale one here would keep
    // rejecting a promise nobody is waiting on any more. A no-op sink takes
    // their place because ws throws when an 'error' event has no listener at
    // all - including the one terminate() raises below.
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.on('error', () => undefined);
      finish();
    };
    const onOpen = (): void => settle(resolve);
    const onError = (error: Error): void => settle(() => reject(error));
    const timer = setTimeout(() => settle(() => {
      socket.terminate();
      reject(new Error(`JumpServer WebSocket handshake timed out after ${timeoutMs}ms.`));
    }), timeoutMs);
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return socket;
}

/**
 * Races `run` against a deadline and aborts it when the deadline wins. The
 * abort is what frees the socket; the race is what guarantees the caller gets
 * an answer even from a `fetchImpl` that ignores signals.
 */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // The URL can carry a connection token, so it never reaches the message.
      const error = new Error(`JumpServer request timed out after ${timeoutMs}ms.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export class JumpServerClient {
  private authToken = '';
  private cookies: JumpServerCookie[] = [];
  private readonly fetchImpl: FetchLike;
  private readonly timeouts: JumpServerTimeouts;

  constructor(
    private readonly settings: JumpServerSettingsWithPassword,
    fetchImpl?: FetchLike,
    timeouts: Partial<JumpServerTimeouts> = {}
  ) {
    this.fetchImpl = fetchImpl ?? createJumpServerFetch({ verifyTls: settings.verifyTls });
    this.timeouts = { ...DEFAULT_JUMPSERVER_TIMEOUTS, ...timeouts };
  }

  async ensureAuthToken(): Promise<string> {
    if (this.authToken) {
      return this.authToken;
    }
    const response = await this.request('/api/v1/authentication/auth/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: this.settings.username, password: this.settings.password })
    }, false);
    const body = await response.json() as { token?: unknown };
    if (!body.token) {
      throw new Error('JumpServer auth response did not include token.');
    }
    this.authToken = String(body.token);
    return this.authToken;
  }

  async listAssets(input: { limit: number; offset: number }): Promise<CachedJumpServerAsset[]> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(
      `/api/v1/perms/users/self/assets/?limit=${input.limit}&offset=${input.offset}`,
      {},
      this.timeouts.listingMs
    );
    const body = await response.json() as ListPage | unknown[];
    const treePaths = await this.safeListAssetTreePaths();
    const items = Array.isArray(body)
      ? body
      : Array.isArray(body.results)
        ? body.results
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.data)
            ? body.data
            : [];
    return items
      .filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'))
      .map((item) => normalizeJumpServerAsset(item))
      .map((asset) => this.applyTreePath(asset, treePaths));
  }

  async listAssetTreePaths(): Promise<AssetPathMap> {
    return nodesToAssetPathMap(await this.listAssetNodes());
  }

  async listAssetNodes(): Promise<CachedJumpServerNode[]> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(
      '/api/v1/perms/users/self/nodes/all-with-assets/tree/',
      {},
      this.timeouts.listingMs
    );
    return extractAssetTreeNodes(await response.json());
  }

  async getAssetDetail(assetId: string): Promise<Record<string, any>> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(`/api/v1/perms/users/self/assets/${encodeURIComponent(assetId)}/`);
    return await response.json() as Record<string, any>;
  }

  async createConnectionToken(input: { assetId: string; account: JumpServerAccountRef; protocol: JumpServerConnectionProtocol }): Promise<{ id: string }> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildConnectionTokenPayload(input))
    });
    const body = await response.json() as { id?: unknown };
    if (!body.id) {
      throw new Error(input.protocol === 'mysql'
        ? 'JumpServer MySQL connection-token response did not include id.'
        : 'JumpServer connection-token response did not include id.');
    }
    return { id: String(body.id) };
  }

  async getSmartEndpoint(tokenId: string): Promise<JumpServerEndpoint> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(`/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`);
    return await response.json() as JumpServerEndpoint;
  }

  async warmupKokoConnectPage(tokenId: string, timestamp = Date.now()): Promise<void> {
    const authenticated = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
    if (authenticated) {
      return;
    }
    this.cookies = [];
    const retried = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
    if (!retried) {
      throw new Error('KoKo web session is not authenticated.');
    }
  }

  private async tryWarmupKokoConnectPage(tokenId: string, timestamp: number): Promise<boolean> {
    const connectUrl = buildKokoConnectUrl(this.settings.baseUrl, tokenId, timestamp);
    const initialConnectResponse = await this.request(connectUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'manual'
    }, false);
    if (initialConnectResponse.ok) {
      return true;
    }
    if (![301, 302, 303, 307, 308].includes(initialConnectResponse.status)) {
      throw new Error(`KoKo connect warmup failed with HTTP ${initialConnectResponse.status}.`);
    }

    const loginPath = initialConnectResponse.headers.get('location') || '/core/auth/login/?next=/koko/connect/';
    const loginPage = await this.request(loginPath, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    }, false);
    const csrfToken = parseCsrfMiddlewareToken(await loginPage.text());

    const body = new URLSearchParams({
      csrfmiddlewaretoken: csrfToken,
      username: this.settings.username,
      password: this.settings.password,
      auto_login: 'on'
    });

    const loginSubmit = await this.request(loginPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Referer: resolveJumpServerUrl(this.settings.baseUrl, loginPath),
        Origin: buildOrigin(this.settings.baseUrl)
      },
      body: body.toString(),
      redirect: 'manual'
    }, false);

    let location = loginSubmit.headers.get('location');
    for (let index = 0; index < 5 && location; index += 1) {
      const redirectResponse = await this.request(location, { redirect: 'manual' }, false);
      if (![301, 302, 303, 307, 308].includes(redirectResponse.status)) {
        break;
      }
      location = redirectResponse.headers.get('location');
    }

    await this.request('/api/v1/users/profile/', { headers: { Accept: 'application/json' } }, false);
    const connectResponse = await this.request(connectUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'manual'
    }, false);
    if ([301, 302, 303, 307, 308].includes(connectResponse.status)) {
      return false;
    }
    if (!connectResponse.ok) {
      throw new Error(`KoKo connect warmup failed with HTTP ${connectResponse.status}.`);
    }
    return true;
  }

  async openKokoWebSocket(input: {
    endpoint: JumpServerEndpoint;
    tokenId: string;
    cols: number;
    rows: number;
    webSocketFactory?: WebSocketFactory;
  }): Promise<KokoWebSocket> {
    await this.warmupKokoConnectPage(input.tokenId);
    const url = buildKokoWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId);
    const factory = input.webSocketFactory ?? this.timedWebSocketFactory();
    return factory(url, {
      origin: buildOrigin(this.settings.baseUrl),
      headers: {
        Cookie: this.cookieHeader(),
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': 'AT JumpServer Terminal'
      },
      rejectUnauthorized: this.settings.verifyTls
    });
  }

  async openKokoSftpWebSocket(input: {
    endpoint: JumpServerEndpoint;
    tokenId: string;
    timestamp?: number;
    webSocketFactory?: WebSocketFactory;
  }): Promise<KokoWebSocket> {
    await this.warmupKokoConnectPage(input.tokenId);
    const url = buildKokoSftpWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId, input.timestamp);
    const factory = input.webSocketFactory ?? this.timedWebSocketFactory();
    return factory(url, {
      origin: buildOrigin(this.settings.baseUrl),
      headers: {
        Cookie: this.cookieHeader(),
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': 'AT JumpServer SFTP'
      },
      rejectUnauthorized: this.settings.verifyTls
    });
  }

  cookieHeader(): string {
    return cookiesForUrl(this.cookies, `${buildOrigin(this.settings.baseUrl)}/`);
  }

  private timedWebSocketFactory(): WebSocketFactory {
    return (url, options) => defaultWebSocketFactory(url, options, this.timeouts.webSocketMs);
  }

  restHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: 'application/json'
    };
    if (this.settings.orgId) {
      headers['X-JMS-ORG'] = this.settings.orgId;
    }
    return headers;
  }

  private async safeListAssetTreePaths(): Promise<AssetPathMap> {
    try {
      return await this.listAssetTreePaths();
    } catch {
      return new Map();
    }
  }

  private applyTreePath(asset: CachedJumpServerAsset, treePaths: AssetPathMap): CachedJumpServerAsset {
    const nodePath = treePaths.get(asset.id);
    if (!nodePath || nodePath.length === 0) {
      return asset;
    }
    return {
      ...asset,
      nodePath,
      zoneName: asset.zoneName || nodePath.at(-1) || ''
    };
  }

  private async authenticatedRequest(
    pathOrUrl: string,
    init: RequestInit = {},
    timeoutMs = this.timeouts.requestMs
  ): Promise<Response> {
    await this.ensureAuthToken();
    let response = await this.request(pathOrUrl, this.withRestHeaders(init), false, timeoutMs);
    if (!isUnauthorizedResponse(response)) {
      if (!response.ok) {
        throw new Error(`JumpServer request failed with HTTP ${response.status}.`);
      }
      return response;
    }
    this.resetRestAuth();
    await this.ensureAuthToken();
    response = await this.request(pathOrUrl, this.withRestHeaders(init), false, timeoutMs);
    if (!response.ok) {
      throw new Error(`JumpServer request failed with HTTP ${response.status}.`);
    }
    return response;
  }

  private withRestHeaders(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        ...headersToRecord(init.headers),
        ...this.restHeaders()
      }
    };
  }

  private resetRestAuth(): void {
    this.authToken = '';
  }

  private async request(
    pathOrUrl: string,
    init: RequestInit = {},
    requireOk = true,
    timeoutMs = this.timeouts.requestMs
  ): Promise<Response> {
    const url = resolveJumpServerUrl(this.settings.baseUrl, pathOrUrl);
    const headers = headersToRecord(init.headers);
    const cookieHeader = cookiesForUrl(this.cookies, url);
    if (cookieHeader && !hasHeader(headers, 'Cookie')) {
      headers.Cookie = cookieHeader;
    }
    const response = await withDeadline(
      (signal) => this.fetchImpl(url, { ...init, headers, signal }),
      timeoutMs
    );
    this.captureCookies(response, url);
    if (requireOk && !response.ok) {
      throw new Error(`JumpServer request failed with HTTP ${response.status}.`);
    }
    return response;
  }

  private captureCookies(response: Response, requestUrl: string): void {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
      return;
    }
    for (const cookie of parseSetCookieHeader(setCookie, requestUrl)) {
      const existing = this.cookies.findIndex(
        (candidate) => candidate.name === cookie.name && candidate.domain === cookie.domain && candidate.path === cookie.path
      );
      if (existing >= 0) {
        this.cookies[existing] = cookie;
      } else {
        this.cookies.push(cookie);
      }
    }
  }
}

function isUnauthorizedResponse(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

export function extractAssetTreePaths(payload: unknown): AssetPathMap {
  return nodesToAssetPathMap(extractAssetTreeNodes(payload));
}

export function extractAssetTreeNodes(payload: unknown): CachedJumpServerNode[] {
  const items = treeItems(payload);
  if (isFlatAssetTree(items)) {
    return flatAssetTreeNodes(items);
  }
  const nodes: CachedJumpServerNode[] = [];
  for (const item of items) {
    walkAssetTreeNode(item, [], nodes);
  }
  return nodes;
}

function nodesToAssetPathMap(nodes: CachedJumpServerNode[]): AssetPathMap {
  const paths: AssetPathMap = new Map();
  for (const node of nodes) {
    for (const assetId of node.assetIds) {
      paths.set(assetId, node.path);
    }
  }
  return paths;
}

function treeItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  for (const field of ['results', 'items', 'data', 'children']) {
    if (Array.isArray(record[field])) {
      return record[field];
    }
  }
  return [payload];
}

function isFlatAssetTree(items: unknown[]): boolean {
  return items.some((item) => Boolean(item && typeof item === 'object' && parentKey(item as Record<string, unknown>)));
}

function flatAssetTreeNodes(items: unknown[]): CachedJumpServerNode[] {
  const records = items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  const nodeRecords = records.filter((record) => !isAssetTreeLeaf(record));
  const nodesByKey = new Map<string, Record<string, unknown>>();
  const assetsByParentKey = new Map<string, string[]>();

  for (const record of nodeRecords) {
    const key = treeItemKey(record);
    if (key) {
      nodesByKey.set(key, record);
    }
  }

  for (const record of records.filter(isAssetTreeLeaf)) {
    const parent = parentKey(record);
    const assetId = stringField(record, ['id', 'key', 'value']);
    if (!parent || !assetId) {
      continue;
    }
    const assetIds = assetsByParentKey.get(parent) ?? [];
    assetIds.push(assetId);
    assetsByParentKey.set(parent, assetIds);
  }

  const pathCache = new Map<string, string[]>();
  const buildPath = (record: Record<string, unknown>, seen = new Set<string>()): string[] => {
    const key = treeItemKey(record);
    if (key && pathCache.has(key)) {
      return pathCache.get(key) ?? [];
    }
    const label = treeNodeLabel(record);
    const parent = parentKey(record);
    const parentRecord = parent ? nodesByKey.get(parent) : undefined;
    const path = parentRecord && (!key || !seen.has(key))
      ? [...buildPath(parentRecord, key ? new Set([...seen, key]) : seen), label]
      : [label];
    const normalized = path.filter((part) => part.length > 0);
    if (key) {
      pathCache.set(key, normalized);
    }
    return normalized;
  };

  return nodeRecords
    .map((record) => {
      const key = treeItemKey(record);
      const path = buildPath(record);
      return {
        id: nestedStringField(record, ['meta.data.id']) || key || path.join('/'),
        name: path.at(-1) || treeNodeLabel(record),
        path,
        assetIds: key ? assetsByParentKey.get(key) ?? [] : [],
        raw: record
      };
    })
    .filter((node) => node.path.length > 0);
}

function treeItemKey(record: Record<string, unknown>): string {
  return nestedStringField(record, ['key', 'id', 'value', 'meta.data.key']);
}

function parentKey(record: Record<string, unknown>): string {
  return nestedStringField(record, [
    'pId',
    'pid',
    'parent',
    'parent_key',
    'parentKey',
    'parent_id',
    'parentId',
    'meta.parent',
    'meta.parent_key',
    'meta.parentKey',
    'meta.data.parent',
    'meta.data.parent_key',
    'meta.data.parentKey'
  ]);
}

function treeNodeLabel(record: Record<string, unknown>): string {
  return nestedStringField(record, ['name', 'title', 'label', 'value', 'meta.data.value']);
}

function walkAssetTreeNode(node: unknown, parentPath: string[], nodes: CachedJumpServerNode[]): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  const record = node as Record<string, unknown>;
  if (isAssetTreeLeaf(record)) {
    return;
  }

  const label = stringField(record, ['name', 'title', 'label', 'value']);
  const currentPath = label ? [...parentPath, label] : parentPath;
  const children = treeItems(record.children);
  const assetIds = [
    ...assetIdsFromValue(record.assets),
    ...assetIdsFromValue(record.asset),
    ...children
      .filter((child) => child && typeof child === 'object' && isAssetTreeLeaf(child as Record<string, unknown>))
      .map((child) => stringField(child as Record<string, unknown>, ['id', 'key', 'value']))
      .filter((id) => id.length > 0)
  ];
  if (label && currentPath.length > 0) {
    nodes.push({
      id: stringField(record, ['id', 'key']) || currentPath.join('/'),
      name: label,
      path: currentPath,
      assetIds,
      raw: record
    });
  }
  for (const child of children) {
    if (!child || typeof child !== 'object' || isAssetTreeLeaf(child as Record<string, unknown>)) {
      continue;
    }
    walkAssetTreeNode(child, currentPath, nodes);
  }
}

function assetIdsFromValue(value: unknown): string[] {
  const ids: string[] = [];
  for (const asset of treeItems(value)) {
    if (asset && typeof asset === 'object') {
      const id = stringField(asset as Record<string, unknown>, ['id', 'key', 'value']);
      if (id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function isAssetTreeLeaf(record: Record<string, unknown>): boolean {
  const meta = record.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : {};
  const type = String(record.type || record.kind || record.node_type || meta.type || '').toLowerCase();
  return record.is_asset === true || type === 'asset' || type === 'host';
}

function stringField(record: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return '';
}

function nestedStringField(record: Record<string, unknown>, paths: string[]): string {
  for (const path of paths) {
    let value: unknown = record;
    for (const segment of path.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return '';
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
