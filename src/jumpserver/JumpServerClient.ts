import type { CachedJumpServerAsset, CachedJumpServerNode } from '../config/schema';
import type { JumpServerAccountRef, JumpServerConnectionProtocol, JumpServerEndpoint, JumpServerSettingsWithPassword } from './types';
import WebSocket from 'ws';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
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

export function buildOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
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


export async function defaultWebSocketFactory(url: string, options: WebSocket.ClientOptions): Promise<KokoWebSocket> {
  const socket = new WebSocket(url, ['JMS-KOKO'], options);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

export class JumpServerClient {
  private authToken = '';
  private currentUserId = '';
  private readonly cookies = new Map<string, string>();
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly settings: JumpServerSettingsWithPassword,
    fetchImpl?: FetchLike
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
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
    const userId = await this.getCurrentUserId();
    const response = await this.request(`/api/v1/perms/users/${encodeURIComponent(userId)}/assets/?limit=${input.limit}&offset=${input.offset}`, {
      headers: this.restHeaders()
    });
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
    const userId = await this.getCurrentUserId();
    const response = await this.request(`/api/v1/perms/users/${encodeURIComponent(userId)}/nodes/all-with-assets/tree/`, {
      headers: this.restHeaders()
    });
    return extractAssetTreeNodes(await response.json());
  }

  async getAssetDetail(assetId: string): Promise<Record<string, any>> {
    await this.ensureAuthToken();
    const userId = await this.getCurrentUserId();
    const response = await this.request(`/api/v1/perms/users/${encodeURIComponent(userId)}/assets/${encodeURIComponent(assetId)}/`, {
      headers: this.restHeaders()
    });
    return await response.json() as Record<string, any>;
  }

  async createConnectionToken(input: { assetId: string; account: JumpServerAccountRef; protocol: JumpServerConnectionProtocol }): Promise<{ id: string }> {
    await this.ensureAuthToken();
    const response = await this.request('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { ...this.restHeaders(), 'content-type': 'application/json' },
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
    const response = await this.request(`/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`, {
      headers: this.restHeaders()
    });
    return await response.json() as JumpServerEndpoint;
  }

  async warmupKokoConnectPage(tokenId: string, timestamp = Date.now()): Promise<void> {
    const loginPath = '/core/auth/login/?next=/koko/connect/';
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
        Referer: `${buildOrigin(this.settings.baseUrl)}${loginPath}`,
        Origin: buildOrigin(this.settings.baseUrl),
        Cookie: this.cookieHeader()
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
    const connectResponse = await this.request(buildKokoConnectUrl(this.settings.baseUrl, tokenId, timestamp), {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: this.cookieHeader()
      },
      redirect: 'manual'
    }, false);
    if ([301, 302, 303, 307, 308].includes(connectResponse.status)) {
      throw new Error('KoKo web session is not authenticated.');
    }
    if (!connectResponse.ok) {
      throw new Error(`KoKo connect warmup failed with HTTP ${connectResponse.status}.`);
    }
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
    const factory = input.webSocketFactory ?? defaultWebSocketFactory;
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

  cookieHeader(): string {
    return Array.from(this.cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
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

  private async getCurrentUserId(): Promise<string> {
    if (this.currentUserId) {
      return this.currentUserId;
    }
    const response = await this.request('/api/v1/users/profile/', {
      headers: this.restHeaders()
    });
    const body = await response.json() as Record<string, unknown>;
    const id = stringField(body, ['id', 'pk', 'user_id', 'username']);
    if (!id) {
      throw new Error('JumpServer profile response did not include user id.');
    }
    this.currentUserId = id;
    return id;
  }

  private async request(pathOrUrl: string, init: RequestInit = {}, requireOk = true): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${buildOrigin(this.settings.baseUrl)}${pathOrUrl}`;
    const headers = headersToRecord(init.headers);
    const cookieHeader = this.cookieHeader();
    if (cookieHeader && !hasHeader(headers, 'Cookie')) {
      headers.Cookie = cookieHeader;
    }
    const response = await this.fetchImpl(url, { ...init, headers });
    this.captureCookies(response);
    if (requireOk && !response.ok) {
      throw new Error(`JumpServer request failed with HTTP ${response.status}.`);
    }
    return response;
  }

  private captureCookies(response: Response): void {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
      return;
    }
    for (const rawCookie of splitSetCookieHeader(setCookie)) {
      const [nameValue] = rawCookie.split(';');
      const separator = nameValue.indexOf('=');
      if (separator > 0) {
        this.cookies.set(nameValue.slice(0, separator).trim(), nameValue.slice(separator + 1).trim());
      }
    }
  }
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
