import type { CachedJumpServerAsset, CachedJumpServerNode } from '../config/schema';
import type { JumpServerAccountRef, JumpServerConnectionProtocol, JumpServerEndpoint, JumpServerSettingsWithPassword } from './types';
export type { JumpServerEndpoint };
import { log } from '../utils/logger';
import { apiErrorMessageFromPayload, classifyRestFailure, JumpServerApiError } from './apiError';
import { buildSelfAssetListPath, pageSignature, rewritePaginationRef, throttleWaitMs } from './pagination';
import { GLOBAL_ORG_ID, type JumpServerOrg } from './orgs';
import { createJumpServerFetch, type FetchLike, JUMPSERVER_CLIENT_USER_AGENT } from './restTransport';
import { buildOrigin } from './urls';
import { type ConnectMethod, normalizeConnectMethods } from './connectMethods';
import { detectKokoCapabilities } from './kokoCapability';
import { Agent as HttpsAgent } from 'node:https';
import {
  cookiesForUrl,
  type JumpServerCookie,
  parseSetCookieHeader,
  parseStoredWebSession,
  resolveJumpServerUrl
} from './cookieJar';
import {
  type AssetPathMap,
  assetPathsFromNodes,
  extractAssetTreeNodes,
  extractAssetTreePaths,
  extractNodePath,
  extractProtocolNames,
  normalizeJumpServerAsset,
  resolveFirstUsableAccount,
  resolveUsableAccounts
} from './assetNormalizer';
import {
  buildConnectionTokenPayload,
  buildMysqlConnectionTokenPayload,
  buildRedisConnectionTokenPayload,
  buildSftpConnectionTokenPayload,
  currentOsParam,
  DEFAULT_CONNECT_OPTIONS,
  DEFAULT_MYSQL_CONNECT_OPTIONS,
  DEFAULT_REDIS_CONNECT_OPTIONS,
  DEFAULT_SFTP_CONNECT_OPTIONS
} from './tokenPayload';
import {
  buildKokoBaseUrl,
  buildKokoConnectUrl,
  buildKokoSftpWsUrl,
  buildKokoWsUrl,
  DEFAULT_JUMPSERVER_TIMEOUTS,
  defaultWebSocketFactory,
  isKokoLoginRedirect,
  type JumpServerTimeoutBudget,
  type JumpServerTimeouts,
  type KokoWebSocket,
  kokoWsAgentForEndpoint,
  logRoute,
  parseCsrfMiddlewareToken,
  type WebSocketFactory
} from './kokoEndpoints';

export type { JumpServerCookie } from './cookieJar';
export {
  cookiesForUrl,
  parseSetCookieHeader,
  resolveJumpServerUrl
} from './cookieJar';
export type { AssetPathMap } from './assetNormalizer';
export {
  assetPathsFromNodes,
  extractAssetTreeNodes,
  extractAssetTreePaths,
  extractNodePath,
  extractProtocolNames,
  normalizeJumpServerAsset,
  resolveFirstUsableAccount,
  resolveUsableAccounts
} from './assetNormalizer';
export {
  buildConnectionTokenPayload,
  buildMysqlConnectionTokenPayload,
  buildRedisConnectionTokenPayload,
  buildSftpConnectionTokenPayload,
  currentOsParam,
  DEFAULT_CONNECT_OPTIONS,
  DEFAULT_MYSQL_CONNECT_OPTIONS,
  DEFAULT_REDIS_CONNECT_OPTIONS,
  DEFAULT_SFTP_CONNECT_OPTIONS
} from './tokenPayload';
export type {
  JumpServerTimeoutBudget,
  JumpServerTimeouts,
  KokoWebSocket,
  WebSocketFactory
} from './kokoEndpoints';
export {
  buildKokoBaseUrl,
  buildKokoConnectUrl,
  buildKokoSftpWsUrl,
  buildKokoWsUrl,
  DEFAULT_JUMPSERVER_TIMEOUTS,
  defaultWebSocketFactory,
  isKokoLoginRedirect,
  kokoWsAgentForEndpoint,
  parseCsrfMiddlewareToken
} from './kokoEndpoints';

interface ListPage {
  results?: unknown[];
  items?: unknown[];
  data?: unknown[];
  count?: number;
  total?: number;
  next?: string | null;
}

export interface JumpServerAssetInventory {
  assets: CachedJumpServerAsset[];
  /** What JumpServer says it has, even when a cap stopped the sync short. */
  total: number;
  /** True when a safety cap stopped paging before the end. */
  truncated: boolean;
}

/** JumpServer's own DRF default; large enough that most bastions need 1-2 pages. */
export const ASSET_PAGE_SIZE = 200;
/**
 * Ceiling on what one refresh will pull into globalState. It exists so a
 * malformed `count` cannot make the extension page forever, not because 10k is
 * a supported deployment size.
 */
export const MAX_SYNCED_ASSETS = 10_000;
/** Parallel page fetches. Enough to hide latency, gentle enough for a bastion. */
export const ASSET_PAGE_CONCURRENCY = 4;
/** Initial listing try plus two retries after HTTP 429. */
const LISTING_RETRY_LIMIT = 3;

/**
 * Where the KoKo web-session cookies (sessionid + csrftoken) survive a window
 * reload. Injected rather than imported so this module never touches the
 * vscode API: the extension hands in a SecretStorage-backed implementation,
 * tests hand in an in-memory one.
 */
export interface JumpServerWebSessionStore {
  load(): Promise<string | undefined>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Ceiling on cached asset detail payloads. Details carry the full account and
 * protocol listing per asset, and an unbounded map of them would grow with
 * every asset a user ever hovered.
 */
export const ASSET_DETAIL_CACHE_LIMIT = 64;

export { classifyRestFailure, JumpServerApiError } from './apiError';
export { JUMPSERVER_CLIENT_USER_AGENT } from './restTransport';
export { buildOrigin } from './urls';

export function rfc1123Date(now = new Date()): string {
  return now.toUTCString().replace(/UTC$/, 'GMT');
}

function normalizeJumpServerOrgs(records: unknown[]): JumpServerOrg[] {
  const orgs: JumpServerOrg[] = [];
  for (const item of records) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (!id) {
      continue;
    }
    const name = (item as { name?: unknown }).name;
    orgs.push({ id: String(id), name: String(name || id) });
  }
  return orgs;
}

/**
 * Races `run` against a deadline and aborts it when the deadline wins. The
 * abort is what frees the socket; the race is what guarantees the caller gets
 * an answer even from a `fetchImpl` that ignores signals.
 */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  budget: JumpServerTimeoutBudget,
  route: string
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // The URL can carry a connection token, so it never reaches the message.
      const error = new Error(`JumpServer request timed out after ${timeoutMs}ms.`);
      // Which budget ran out is the whole diagnosis: a listing timeout means the
      // deployment is large, a request timeout means the bastion is wedged.
      log.warn(`REST ${budget} budget exhausted after ${timeoutMs}ms: ${route}`);
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
  private authInflight: Promise<string> | undefined;
  private warmupInflight: Promise<void> | undefined;
  private assetDetails = new Map<string, Record<string, any>>();
  private detailInflight = new Map<string, Promise<Record<string, any>>>();
  private restAuthEncoding: 'json' | 'form' | undefined;
  private smartEndpoint: JumpServerEndpoint | undefined;
  private cookies: JumpServerCookie[] = [];
  private connectMethodsCache: { methods: Record<string, ConnectMethod[]>; expiresAt: number } | undefined;
  private connectMethodsInflight: Promise<Record<string, ConnectMethod[]>> | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly agent: HttpsAgent | undefined;
  private readonly timeouts: JumpServerTimeouts;
  private readonly sleep: (ms: number) => Promise<void>;
  private orgId: string;
  private webSessionStore: JumpServerWebSessionStore | undefined;
  private webSessionRestore: Promise<void> | undefined;
  private webSessionInflight: Promise<void> | undefined;
  private readonly kokoBearerHandshake: boolean;
  private bastionId?: string;
  private readonly ticketCache = new Map<string, { ticket: string; tokenId: string; expiresAt: number }>();
  private readonly ticketInflight = new Map<string, Promise<string>>();
  /** Django warmup share of the most recent openKoko*WebSocket call. */
  private lastWarmupMs = 0;

  constructor(
    private readonly settings: JumpServerSettingsWithPassword,
    fetchImpl?: FetchLike,
    options: Partial<JumpServerTimeouts> & {
      sleep?: (ms: number) => Promise<void>;
      webSessionStore?: JumpServerWebSessionStore;
      kokoBearerHandshake?: boolean;
      bastionId?: string;
    } = {}
  ) {
    const { sleep, webSessionStore, kokoBearerHandshake, bastionId, ...timeouts } = options;
    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    } else {
      // One warm TLS connection saves a full handshake on every REST call,
      // which is most of the latency of a connect on a far-away bastion.
      this.agent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 });
      this.fetchImpl = createJumpServerFetch({ verifyTls: settings.verifyTls, agent: this.agent });
    }
    this.timeouts = { ...DEFAULT_JUMPSERVER_TIMEOUTS, ...timeouts };
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.orgId = settings.orgId;
    this.kokoBearerHandshake = Boolean(kokoBearerHandshake);
    this.bastionId = bastionId;
    if (webSessionStore) {
      this.attachWebSessionStore(webSessionStore);
    }
  }

  getBastionId(): string | undefined {
    return this.bastionId;
  }

  setBastionId(bastionId: string): void {
    this.bastionId = bastionId;
  }

  /**
   * Late store attachment, for a pooled client first built by a code path
   * that had no SecretStorage in reach (the asset refresh, for one). The
   * first store wins; a client never swaps stores mid-life.
   */
  attachWebSessionStore(store: JumpServerWebSessionStore): void {
    if (this.webSessionStore) {
      return;
    }
    this.webSessionStore = store;
    this.webSessionRestore = this.restoreWebSession().catch(() => undefined);
  }

  setOrgId(orgId: string): void {
    this.orgId = orgId;
    this.connectMethodsCache = undefined;
    this.ticketCache.clear();
  }

  invalidateTicket(tokenId: string, kind: 'terminal' | 'sftp'): void {
    this.ticketCache.delete(`${tokenId}:${kind}`);
  }

  async createKokoConnectTicket(input: {
    endpoint: JumpServerEndpoint;
    tokenId: string;
    orgId?: string;
  }): Promise<{ ticket: string; tokenId: string; expiresIn: number }> {
    await this.ensureAuthToken();
    const kokoBase = buildKokoBaseUrl(this.settings.baseUrl, input.endpoint);
    const kokoOrigin = buildOrigin(kokoBase);
    const url = `${kokoBase}/koko/api/connect-ticket/`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Referer: `${kokoOrigin}/`,
      Origin: kokoOrigin,
      'User-Agent': JUMPSERVER_CLIENT_USER_AGENT,
      'X-TZ': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    };
    const orgId = input.orgId ?? this.orgId;
    if (orgId) {
      headers['X-JMS-ORG'] = orgId;
    }
    const body = JSON.stringify({
      token_id: input.tokenId,
      org_id: orgId || ''
    });

    const response = await this.request(
      url,
      {
        method: 'POST',
        headers,
        body
      },
      false,
      'request',
      [kokoOrigin]
    );

    if (response.status === 404) {
      throw new JumpServerApiError('KoKo connect-ticket endpoint not found (HTTP 404)', {
        statusCode: 404,
        method: 'POST',
        path: logRoute(url),
        reason: 'not-found'
      });
    }

    if (!response.ok) {
      throw new JumpServerApiError(`KoKo connect-ticket failed with HTTP ${response.status}`, {
        statusCode: response.status,
        method: 'POST',
        path: logRoute(url),
        reason: classifyRestFailure(response.status)
      });
    }

    const payload = (await response.json()) as { ticket?: unknown; token_id?: unknown; expires_in?: unknown };
    if (!payload.ticket) {
      throw new JumpServerApiError('KoKo connect-ticket response did not include ticket.', {
        statusCode: response.status,
        method: 'POST',
        path: logRoute(url),
        reason: 'unexpected-status'
      });
    }

    return {
      ticket: String(payload.ticket),
      tokenId: String(payload.token_id || input.tokenId),
      expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : 1800
    };
  }

  async getOrCreateKokoConnectTicket(
    endpoint: JumpServerEndpoint,
    tokenId: string,
    kind: 'terminal' | 'sftp'
  ): Promise<string> {
    const cacheKey = `${tokenId}:${kind}`;
    const cached = this.ticketCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.ticket;
    }

    const inflight = this.ticketInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = (async () => {
      const res = await this.createKokoConnectTicket({ endpoint, tokenId });
      const ttlMs = res.expiresIn ? Math.min(25 * 60, res.expiresIn - 300) * 1000 : 25 * 60 * 1000;
      this.ticketCache.set(cacheKey, {
        ticket: res.ticket,
        tokenId,
        expiresAt: Date.now() + Math.max(60_000, ttlMs)
      });
      return res.ticket;
    })().finally(() => {
      this.ticketInflight.delete(cacheKey);
    });

    this.ticketInflight.set(cacheKey, promise);
    return promise;
  }

  getBaseUrl(): string {
    return this.settings.baseUrl;
  }

  async getClientVersions(): Promise<string[]> {
    await this.ensureAuthToken();
    const response = await this.request(
      '/api/v1/settings/client/versions/',
      this.withRestHeaders({ method: 'GET' }),
      false
    );
    if (!response.ok) {
      const err = new JumpServerApiError(`Client versions request failed with HTTP ${response.status}`, {
        statusCode: response.status,
        method: 'GET',
        path: '/api/v1/settings/client/versions/',
        reason: classifyRestFailure(response.status)
      });
      throw err;
    }
    const data = await response.json();
    if (Array.isArray(data)) {
      return data.map(String);
    }
    if (data && typeof data === 'object' && Array.isArray((data as any).data)) {
      return (data as any).data.map(String);
    }
    return [];
  }

  /** Closes the keep-alive sockets. The client must not be used afterwards. */
  dispose(): void {
    this.agent?.destroy();
  }

  async ensureAuthToken(): Promise<string> {
    if (this.authToken) {
      log.info('REST bearer reused');
      return this.authToken;
    }
    if (this.authInflight) {
      return this.authInflight;
    }
    this.authInflight = this.loginRestBearer().finally(() => {
      this.authInflight = undefined;
    });
    return this.authInflight;
  }

  private async loginRestBearer(): Promise<string> {
    log.info('REST bearer login');
    // A bastion answers exactly one of the two encodings; retrying the one
    // that worked last time saves a guaranteed-to-fail round trip on every
    // re-login after a 401.
    const encodings: Array<'json' | 'form'> = this.restAuthEncoding === 'form' ? ['form', 'json'] : ['json', 'form'];
    for (let index = 0; index < encodings.length; index += 1) {
      const encoding = encodings[index];
      const token = await this.postRestAuth(encoding, index === encodings.length - 1);
      if (token) {
        this.authToken = token;
        this.restAuthEncoding = encoding;
        return this.authToken;
      }
    }
    throw new Error('JumpServer auth response did not include token.');
  }

  private async postRestAuth(encoding: 'json' | 'form', lastAttempt: boolean): Promise<string | undefined> {
    const credentials = { username: this.settings.username, password: this.settings.password };
    const response = await this.request('/api/v1/authentication/auth/', {
      method: 'POST',
      headers: {
        'content-type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: encoding === 'json' ? JSON.stringify(credentials) : new URLSearchParams(credentials).toString()
    }, false);
    if (!response.ok) {
      if (lastAttempt) {
        await this.requireOkResponse(response, '/api/v1/authentication/auth/', 'POST');
      }
      return undefined;
    }
    const body = await response.json() as { token?: unknown };
    if (body.token) {
      return String(body.token);
    }
    if (lastAttempt) {
      throw new JumpServerApiError(
        apiErrorMessageFromPayload(body, 'JumpServer auth response did not include token.'),
        {
          statusCode: response.status,
          method: 'POST',
          path: logRoute(resolveJumpServerUrl(this.settings.baseUrl, '/api/v1/authentication/auth/')),
          reason: classifyRestFailure(response.status),
          details: body
        }
      );
    }
    return undefined;
  }

  async listAssets(input: { limit: number; offset: number; treePaths?: AssetPathMap }): Promise<CachedJumpServerAsset[]> {
    const page = await this.fetchAssetPage(input.limit, input.offset);
    // all-with-assets/tree/ is the heaviest endpoint JumpServer exposes; a
    // caller that already holds the nodes must be able to say so.
    const treePaths = input.treePaths ?? await this.safeListAssetTreePaths();
    return this.toAssets(page.records, treePaths);
  }

  /**
   * Every asset the account can see, not just the first page.
   *
   * A bastion with more than one page of assets is the normal case, and a
   * single hard-coded page silently hid the rest from both the tree view and
   * the MCP cache.
   */
  async listAllAssets(input: {
    pageSize?: number;
    maxAssets?: number;
    concurrency?: number;
    treePaths?: AssetPathMap;
  } = {}): Promise<JumpServerAssetInventory> {
    const pageSize = boundedCount(input.pageSize, ASSET_PAGE_SIZE);
    const maxAssets = boundedCount(input.maxAssets, MAX_SYNCED_ASSETS);
    const concurrency = boundedCount(input.concurrency, ASSET_PAGE_CONCURRENCY);
    // Authenticate first so the two independent calls below cannot each decide
    // the token is missing and post the credentials twice.
    await this.ensureAuthToken();
    const [first, treePaths] = await Promise.all([
      this.fetchAssetPage(pageSize, 0),
      input.treePaths ? Promise.resolve(input.treePaths) : this.safeListAssetTreePaths()
    ]);
    const records = [...first.records];
    let pages = 1;
    const seen = new Set<string>([pageSignature(first.records)]);

    if (typeof first.total !== 'number') {
      if (typeof first.next === 'string' && first.next.length > 0) {
        // No count to plan offsets against, but the server names the next
        // page, so walk the links serially.
        let nextRef: string | null = first.next;
        while (nextRef && records.length < maxAssets) {
          const page = await this.fetchAssetPageFromPath(rewritePaginationRef(this.settings.baseUrl, nextRef));
          pages += 1;
          if (page.records.length === 0) {
            break;
          }
          const signature = pageSignature(page.records);
          if (seen.has(signature)) {
            break;
          }
          seen.add(signature);
          records.push(...page.records);
          nextRef = typeof page.next === 'string' && page.next.length > 0 ? page.next : null;
        }
      } else {
        // A bare array carries no count to plan against, so walk forward until a
        // page comes back short. The cap is the only other stop condition.
        let lastPageSize = first.records.length;
        for (let offset = pageSize; lastPageSize === pageSize && records.length < maxAssets; offset += pageSize) {
          const page = await this.fetchAssetPage(pageSize, offset);
          pages += 1;
          if (page.records.length === 0) {
            break;
          }
          const signature = pageSignature(page.records);
          if (seen.has(signature)) {
            break;
          }
          seen.add(signature);
          records.push(...page.records);
          lastPageSize = page.records.length;
        }
      }
    } else {
      // A known count makes every remaining offset computable up front, so
      // the pages can be fetched concurrently even when `next` is also set.
      const wanted = Math.min(first.total, maxAssets);
      const offsets: number[] = [];
      for (let offset = pageSize; offset < wanted; offset += pageSize) {
        offsets.push(offset);
      }
      let stop = false;
      for (let index = 0; index < offsets.length && !stop; index += concurrency) {
        const batch = await Promise.all(
          offsets.slice(index, index + concurrency).map((offset) => this.fetchAssetPage(pageSize, offset))
        );
        for (const page of batch) {
          pages += 1;
          if (page.records.length === 0) {
            stop = true;
            break;
          }
          const signature = pageSignature(page.records);
          if (seen.has(signature)) {
            stop = true;
            break;
          }
          seen.add(signature);
          records.push(...page.records);
        }
      }
    }

    // Concurrent pages over a shifting result set can repeat a row.
    const assets = dedupeAssetsById(this.toAssets(records, treePaths)).slice(0, maxAssets);
    const total = Math.max(first.total ?? assets.length, assets.length);
    const truncated = assets.length < total;
    // A short asset list is the failure users report, and the page count is what
    // separates "the bastion only has these" from "the sync stopped early".
    log.info(
      `asset sync walked ${pages} page(s): ${assets.length} of ${total} asset(s)` +
        (truncated ? ' (cache cap reached)' : '')
    );
    return { assets, total, truncated };
  }

  async listAssetTreePaths(): Promise<AssetPathMap> {
    return assetPathsFromNodes(await this.listAssetNodes());
  }

  async listAssetNodes(): Promise<CachedJumpServerNode[]> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(
      '/api/v1/perms/users/self/nodes/all-with-assets/tree/',
      {},
      'listing'
    );
    return extractAssetTreeNodes(await response.json());
  }

  /** Cheapest call that proves the credentials and the org header work. */
  async getUserProfile(): Promise<Record<string, unknown>> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest('/api/v1/users/profile/');
    return await response.json() as Record<string, unknown>;
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    const response = await this.request('/api/health/', { headers: { Accept: 'application/json' } }, false);
    if (response.status === 404) {
      return { skipped: true };
    }
    if (!response.ok) {
      await this.requireOkResponse(response, '/api/health/');
    }
    const raw = await response.text();
    if (!raw) {
      return {};
    }
    try {
      const payload = JSON.parse(raw) as unknown;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return payload as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  async listAccessibleOrgs(): Promise<JumpServerOrg[]> {
    const previousOrgId = this.orgId;
    try {
      this.setOrgId(GLOBAL_ORG_ID);
      let records: unknown[];
      try {
        records = await this.getPaginated('/api/v1/orgs/orgs/');
      } catch (error) {
        if (!(error instanceof JumpServerApiError) || error.reason !== 'forbidden') {
          throw error;
        }
        this.setOrgId('');
        records = await this.getPaginated('/api/v1/orgs/orgs/');
      }
      return normalizeJumpServerOrgs(records);
    } finally {
      this.setOrgId(previousOrgId);
    }
  }

  async getCurrentOrg(): Promise<JumpServerOrg> {
    const response = await this.authenticatedRequest('/api/v1/orgs/orgs/current/');
    const body = await response.json() as { id?: unknown; name?: unknown };
    if (!body.id) {
      throw new Error('JumpServer current org response did not include id.');
    }
    return { id: String(body.id), name: String(body.name || body.id) };
  }

  async getAssetDetail(assetId: string): Promise<Record<string, any>> {
    const cached = this.assetDetails.get(assetId);
    if (cached) {
      log.info(`asset detail reused for ${assetId}`);
      return cached;
    }
    // Prefetch and connect race for the same asset; the second caller must
    // join the first fetch instead of firing its own.
    const inflight = this.detailInflight.get(assetId);
    if (inflight) {
      log.info(`asset detail fetch joined for ${assetId}`);
      return inflight;
    }
    const fetching = this.fetchAssetDetail(assetId);
    this.detailInflight.set(assetId, fetching);
    try {
      const detail = await fetching;
      this.cacheAssetDetail(assetId, detail);
      return detail;
    } finally {
      // A rejection is never cached: dropping the in-flight entry either way
      // lets the next caller retry.
      this.detailInflight.delete(assetId);
    }
  }

  private async fetchAssetDetail(assetId: string): Promise<Record<string, any>> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(`/api/v1/perms/users/self/assets/${encodeURIComponent(assetId)}/`);
    return await response.json() as Record<string, any>;
  }

  private cacheAssetDetail(assetId: string, detail: Record<string, any>): void {
    // Re-inserting moves the id to the back, so the Map's iteration order is
    // least-recently-stored first and the first key is the eviction pick.
    this.assetDetails.delete(assetId);
    this.assetDetails.set(assetId, detail);
    while (this.assetDetails.size > ASSET_DETAIL_CACHE_LIMIT) {
      const oldest = this.assetDetails.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.assetDetails.delete(oldest);
    }
  }

  async getConnectMethods(): Promise<Record<string, ConnectMethod[]>> {
    const now = Date.now();
    if (this.connectMethodsCache && this.connectMethodsCache.expiresAt > now) {
      return this.connectMethodsCache.methods;
    }
    if (this.connectMethodsInflight) {
      return this.connectMethodsInflight;
    }
    this.connectMethodsInflight = (async () => {
      await this.ensureAuthToken();
      const os = currentOsParam();
      const response = await this.authenticatedRequest(
        `/api/v1/terminal/components/connect-methods/?os=${os}`
      );
      const json = await response.json();
      const methods = normalizeConnectMethods(json);
      this.connectMethodsCache = {
        methods,
        expiresAt: Date.now() + 30_000
      };
      return methods;
    })().finally(() => {
      this.connectMethodsInflight = undefined;
    });
    return this.connectMethodsInflight;
  }

  async markTokenReusable(tokenId: string): Promise<boolean> {
    try {
      await this.ensureAuthToken();
      const response = await this.authenticatedRequest(
        `/api/v1/authentication/connection-token/${encodeURIComponent(tokenId)}/reuse/`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ is_reusable: true })
        }
      );
      return response.ok;
    } catch (error) {
      log.debug(`markTokenReusable failed: ${String(error)}`);
      return false;
    }
  }

  async createConnectionToken(input: {
    assetId: string;
    account: JumpServerAccountRef;
    protocol: JumpServerConnectionProtocol;
    connectMethod?: string;
  }): Promise<{ id: string; personalCredentialId?: string }> {
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildConnectionTokenPayload(input))
    });
    const body = await response.json() as { id?: unknown; personal_credential_id?: unknown };
    if (!body.id) {
      throw new Error(input.protocol === 'mysql'
        ? 'JumpServer MySQL connection-token response did not include id.'
        : 'JumpServer connection-token response did not include id.');
    }
    return {
      id: String(body.id),
      personalCredentialId: body.personal_credential_id ? String(body.personal_credential_id) : undefined
    };
  }

  async getSmartEndpoint(tokenId: string): Promise<JumpServerEndpoint> {
    if (this.smartEndpoint) {
      log.info('KoKo endpoint reused');
      return this.smartEndpoint;
    }
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(
      `/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`
    );
    this.smartEndpoint = await response.json() as JumpServerEndpoint;
    return this.smartEndpoint;
  }

  /**
   * Same lookup keyed by asset id instead of a connection token, which lets a
   * connect resolve the endpoint while the token POST is still in flight. The
   * two lookups share the per-client cache: the smart endpoint is a property
   * of the deployment, not of the credential used to ask for it.
   */
  async getSmartEndpointForAsset(assetId: string): Promise<JumpServerEndpoint> {
    if (this.smartEndpoint) {
      log.info('KoKo endpoint reused');
      return this.smartEndpoint;
    }
    await this.ensureAuthToken();
    const response = await this.authenticatedRequest(
      `/api/v1/terminal/endpoints/smart/?protocol=https&asset_id=${encodeURIComponent(assetId)}`
    );
    this.smartEndpoint = await response.json() as JumpServerEndpoint;
    return this.smartEndpoint;
  }

  async warmupKokoConnectPage(tokenId: string, timestamp = Date.now()): Promise<void> {
    if (this.warmupInflight) {
      await this.warmupInflight;
      const again = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
      if (again) {
        return;
      }
    }
    this.warmupInflight = this.runWarmup(tokenId, timestamp).finally(() => {
      this.warmupInflight = undefined;
    });
    await this.warmupInflight;
  }

  private hasWebSessionCookie(): boolean {
    return this.cookies.some((cookie) => cookie.name === 'sessionid');
  }

  hasWebSession(): boolean {
    return this.hasWebSessionCookie();
  }

  /** Django warmup share of the most recent openKoko*WebSocket call, in ms. */
  lastKokoWarmupMs(): number {
    return this.lastWarmupMs;
  }

  /**
   * Makes sure the Django web session KoKo authenticates with exists, without
   * needing a connection token: the login form is posted with a tokenless
   * `next`. This is what lets a connect overlap the slowest cold step - the
   * form login - with the token and endpoint REST calls.
   */
  async ensureWebSession(): Promise<void> {
    await this.webSessionRestore;
    if (this.hasWebSessionCookie()) {
      return;
    }
    this.webSessionInflight ??= this.runWebSessionLogin().finally(() => {
      this.webSessionInflight = undefined;
    });
    return this.webSessionInflight;
  }

  private async runWebSessionLogin(): Promise<void> {
    const started = Date.now();
    const authenticated = await this.loginWebForm('/core/auth/login/?next=/koko/connect/');
    if (!authenticated) {
      await this.clearStoredWebSession();
      throw new Error('JumpServer web session login did not produce a session cookie.');
    }
    log.info(`KoKo web session login in ${Date.now() - started}ms`);
    await this.persistWebSession();
  }

  private async runWarmup(tokenId: string, timestamp: number): Promise<void> {
    const started = Date.now();
    try {
      const authenticated = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
      if (authenticated) {
        log.info(`KoKo warmup ok in ${Date.now() - started}ms`);
        await this.persistWebSession();
        return;
      }
      await this.invalidateWebSession();
      const retried = await this.tryWarmupKokoConnectPage(tokenId, timestamp);
      if (!retried) {
        await this.clearStoredWebSession();
        throw new Error('KoKo web session is not authenticated.');
      }
      log.info(`KoKo warmup login in ${Date.now() - started}ms`);
      await this.persistWebSession();
    } finally {
      this.lastWarmupMs = Date.now() - started;
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
      log.info('KoKo warmup skipped (already authenticated)');
      return true;
    }
    if (![301, 302, 303, 307, 308].includes(initialConnectResponse.status)) {
      throw new Error(`KoKo connect warmup failed with HTTP ${initialConnectResponse.status}.`);
    }

    const redirectLocation = initialConnectResponse.headers.get('location');
    if (!isKokoLoginRedirect(redirectLocation)) {
      return true;
    }
    if (await this.loginWebForm(redirectLocation || '/core/auth/login/?next=/koko/connect/')) {
      return true;
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

  /**
   * The Django form login that warmup and ensureWebSession share: GET the
   * login page for its csrf token, POST the credentials, then chase a few
   * redirect hops. Returns whether a sessionid is now in the jar.
   */
  private async loginWebForm(loginPath: string): Promise<boolean> {
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

    // The login POST usually carries the sessionid cookie itself; once it is
    // in the jar the login is done, and following the post-login redirects is
    // a wasted round trip before the WebSocket handshake proves the session.
    if (this.hasWebSessionCookie()) {
      return true;
    }
    let location = loginSubmit.headers.get('location');
    for (let index = 0; index < 5 && location; index += 1) {
      const redirectResponse = await this.request(location, { redirect: 'manual' }, false);
      // Some deployments only hand the session cookie out on a redirect hop.
      if (this.hasWebSessionCookie()) {
        return true;
      }
      if (![301, 302, 303, 307, 308].includes(redirectResponse.status)) {
        break;
      }
      location = redirectResponse.headers.get('location');
    }
    return this.hasWebSessionCookie();
  }

  /** Drops the sessionid from the jar and the store: it is proven stale. */
  private async invalidateWebSession(): Promise<void> {
    this.cookies = this.cookies.filter((cookie) => cookie.name !== 'sessionid');
    await this.clearStoredWebSession();
  }

  private async clearStoredWebSession(): Promise<void> {
    if (!this.webSessionStore) {
      return;
    }
    try {
      await this.webSessionStore.clear();
    } catch {
      // A failed clear only costs one doomed restore in the next window.
    }
  }

  private async persistWebSession(): Promise<void> {
    if (!this.webSessionStore) {
      return;
    }
    // Only the two cookies the KoKo handshake needs go to disk. Never the
    // password, never the Bearer token, never unrelated cookies.
    const cookies = this.cookies.filter((cookie) => cookie.name === 'sessionid' || cookie.name === 'csrftoken');
    if (!cookies.some((cookie) => cookie.name === 'sessionid')) {
      return;
    }
    try {
      await this.webSessionStore.save(JSON.stringify({ cookies }));
    } catch {
      // Persistence is an optimization; the in-memory jar still works.
    }
  }

  private async restoreWebSession(): Promise<void> {
    if (!this.webSessionStore) {
      return;
    }
    const raw = await this.webSessionStore.load();
    if (!raw) {
      return;
    }
    const restored = parseStoredWebSession(raw, this.settings.baseUrl);
    if (restored.length === 0) {
      return;
    }
    for (const cookie of restored) {
      const exists = this.cookies.some((candidate) =>
        candidate.name === cookie.name && candidate.domain === cookie.domain && candidate.path === cookie.path
      );
      if (!exists) {
        this.cookies.push(cookie);
      }
    }
    // Cookie names only: the values are live session credentials.
    log.info(`KoKo web session restored (${restored.map((cookie) => cookie.name).join(', ')})`);
  }

  async openKokoWebSocket(input: {
    endpoint: JumpServerEndpoint;
    tokenId: string;
    cols: number;
    rows: number;
    webSocketFactory?: WebSocketFactory;
  }): Promise<KokoWebSocket> {
    return this.openKokoSocket({
      kind: 'terminal',
      ...input
    });
  }

  async openKokoSftpWebSocket(input: {
    endpoint: JumpServerEndpoint;
    tokenId: string;
    timestamp?: number;
    webSocketFactory?: WebSocketFactory;
  }): Promise<KokoWebSocket> {
    return this.openKokoSocket({
      kind: 'sftp',
      ...input
    });
  }

  private async openKokoSocket(input: {
    kind: 'terminal' | 'sftp';
    endpoint: JumpServerEndpoint;
    tokenId: string;
    cols?: number;
    rows?: number;
    timestamp?: number;
    webSocketFactory?: WebSocketFactory;
  }): Promise<KokoWebSocket> {
    this.lastWarmupMs = 0;
    // A restored or in-flight web session is about to make the cookie-first
    // handshake below possible; starting a second form login instead would
    // waste the one already running.
    await this.webSessionRestore;
    await this.webSessionInflight?.catch(() => undefined);

    const open = (options?: { ticket?: string; bearerToken?: string; useCookie?: boolean }) => {
      const url = input.kind === 'sftp'
        ? buildKokoSftpWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId, input.timestamp, options?.ticket)
        : buildKokoWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId, undefined, options?.ticket);
      const factory = input.webSocketFactory ?? this.timedWebSocketFactory();
      const headers: Record<string, string> = {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': input.kind === 'sftp' ? 'AT JumpServer SFTP' : 'AT JumpServer Terminal'
      };
      if (options?.useCookie) {
        headers.Cookie = this.cookieHeader();
      }
      if (options?.bearerToken) {
        headers.Authorization = `Bearer ${options.bearerToken}`;
      }
      return factory(url, {
        origin: buildOrigin(this.settings.baseUrl),
        headers,
        rejectUnauthorized: this.settings.verifyTls,
        // Same-authority handshakes resume the REST agent's warm TLS session.
        agent: kokoWsAgentForEndpoint(this.settings.baseUrl, input.endpoint, this.agent)
      });
    };

    if (this.hasWebSessionCookie()) {
      try {
        log.info(`KoKo ${input.kind} websocket with cached session`);
        return await open({ useCookie: true });
      } catch {
        log.info(`KoKo ${input.kind} websocket handshake failed; probing capability / warming up`);
      }
    }

    const caps = await detectKokoCapabilities(this, this.bastionId);

    if (caps.cookieLess) {
      if (this.kokoBearerHandshake) {
        try {
          const bearer = await this.ensureAuthToken();
          return await open({ bearerToken: bearer });
        } catch (error: any) {
          log.warn(`KoKo WS Bearer handshake failed (${error?.message ?? String(error)}); retrying without Bearer`);
        }
      }

      try {
        const ticket = await this.getOrCreateKokoConnectTicket(input.endpoint, input.tokenId, input.kind);
        try {
          return await open({ ticket });
        } catch (wsError: any) {
          const is401 = wsError instanceof Error && /401/.test(wsError.message);
          if (is401) {
            log.info(`KoKo ticket WS handshake returned 401; refreshing ticket`);
            this.invalidateTicket(input.tokenId, input.kind);
            const freshTicket = await this.getOrCreateKokoConnectTicket(input.endpoint, input.tokenId, input.kind);
            return await open({ ticket: freshTicket });
          }
          throw wsError;
        }
      } catch (ticketError: any) {
        log.warn(`KoKo ticket handshake failed (${ticketError?.message ?? String(ticketError)}); falling back to cookie authentication`);
      }
    }

    await this.warmupKokoConnectPage(input.tokenId);
    return open({ useCookie: true });
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
      Accept: 'application/json',
      Date: rfc1123Date(),
      'User-Agent': JUMPSERVER_CLIENT_USER_AGENT
    };
    if (this.orgId) {
      headers['X-JMS-ORG'] = this.orgId;
    }
    return headers;
  }

  private async fetchAssetPage(limit: number, offset: number): Promise<{
    records: unknown[];
    total?: number;
    next?: string | null;
  }> {
    return this.fetchAssetPageFromPath(buildSelfAssetListPath(limit, offset));
  }

  private async getPaginated(path: string): Promise<unknown[]> {
    const first = await this.fetchListPage(path);
    const records = [...first.records];
    const seen = new Set<string>([pageSignature(first.records)]);

    if (typeof first.next === 'string' && first.next.length > 0) {
      let nextRef: string | null = first.next;
      while (nextRef) {
        const page = await this.fetchListPage(rewritePaginationRef(this.settings.baseUrl, nextRef));
        if (page.records.length === 0) {
          break;
        }
        const signature = pageSignature(page.records);
        if (seen.has(signature)) {
          break;
        }
        seen.add(signature);
        records.push(...page.records);
        nextRef = typeof page.next === 'string' && page.next.length > 0 ? page.next : null;
      }
    } else if (first.total !== undefined && first.records.length > 0) {
      const pageSize = first.records.length;
      for (let offset = pageSize; offset < first.total; offset += pageSize) {
        const page = await this.fetchListPage(appendLimitOffset(path, pageSize, offset));
        if (page.records.length === 0) {
          break;
        }
        const signature = pageSignature(page.records);
        if (seen.has(signature)) {
          break;
        }
        seen.add(signature);
        records.push(...page.records);
      }
    }
    return records;
  }

  private async fetchListPage(pathOrUrl: string): Promise<{
    records: unknown[];
    total?: number;
    next?: string | null;
  }> {
    const response = await this.authenticatedRequest(pathOrUrl, {}, 'listing');
    const body = await response.json() as ListPage | unknown[];
    return { records: listPageRecords(body), total: listPageTotal(body), next: listPageNext(body) };
  }

  private async fetchAssetPageFromPath(pathOrUrl: string): Promise<{
    records: unknown[];
    total?: number;
    next?: string | null;
  }> {
    await this.ensureAuthToken();
    let lastError: unknown;
    for (let attempt = 1; attempt <= LISTING_RETRY_LIMIT; attempt += 1) {
      try {
        const response = await this.authenticatedRequest(pathOrUrl, {}, 'listing');
        const body = await response.json() as ListPage | unknown[];
        return { records: listPageRecords(body), total: listPageTotal(body), next: listPageNext(body) };
      } catch (error) {
        lastError = error;
        if (attempt < LISTING_RETRY_LIMIT && error instanceof JumpServerApiError && error.reason === 'throttled') {
          await this.sleep(throttleWaitMs(error.message, error.details));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private toAssets(records: unknown[], treePaths: AssetPathMap): CachedJumpServerAsset[] {
    return records
      .filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'))
      .map((item) => normalizeJumpServerAsset(item))
      .map((asset) => this.applyTreePath(asset, treePaths));
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
    budget: JumpServerTimeoutBudget = 'request'
  ): Promise<Response> {
    await this.ensureAuthToken();
    const method = typeof init.method === 'string' ? init.method : 'GET';
    let response = await this.request(pathOrUrl, this.withRestHeaders(init), false, budget);
    if (!isUnauthorizedResponse(response)) {
      return await this.requireOkResponse(response, pathOrUrl, method);
    }
    this.resetRestAuth();
    await this.ensureAuthToken();
    response = await this.request(pathOrUrl, this.withRestHeaders(init), false, budget);
    return await this.requireOkResponse(response, pathOrUrl, method);
  }

  private async readErrorPayload(response: Response): Promise<unknown> {
    const raw = await response.text();
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  private async requireOkResponse(response: Response, pathOrUrl: string, method = 'GET'): Promise<Response> {
    if (response.ok) {
      return response;
    }
    const payload = await this.readErrorPayload(response);
    const route = logRoute(resolveJumpServerUrl(this.settings.baseUrl, pathOrUrl));
    const reason = classifyRestFailure(response.status);
    const detail = apiErrorMessageFromPayload(payload, `HTTP ${response.status}`);
    log.warn(`REST ${reason} (HTTP ${response.status}): ${route}`);
    throw new JumpServerApiError(detail, {
      statusCode: response.status,
      method,
      path: route,
      reason,
      details: payload
    });
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
    this.assetDetails.clear();
    this.detailInflight.clear();
    this.smartEndpoint = undefined;
  }

  private async request(
    pathOrUrl: string,
    init: RequestInit = {},
    requireOk = true,
    budget: JumpServerTimeoutBudget = 'request',
    allowedOrigins: string[] = []
  ): Promise<Response> {
    const url = resolveJumpServerUrl(this.settings.baseUrl, pathOrUrl, allowedOrigins);
    const headers = headersToRecord(init.headers);
    const cookieHeader = cookiesForUrl(this.cookies, url);
    if (cookieHeader && !hasHeader(headers, 'Cookie') && !hasHeader(headers, 'Authorization')) {
      headers.Cookie = cookieHeader;
    }
    if (!hasHeader(headers, 'Referer')) {
      headers.Referer = resolveJumpServerUrl(this.settings.baseUrl, '/');
    }
    if (!hasHeader(headers, 'Origin')) {
      headers.Origin = buildOrigin(this.settings.baseUrl);
    }
    const csrfCookie = this.cookies.find((candidate) => candidate.name === 'csrftoken');
    if (csrfCookie && !hasHeader(headers, 'X-CSRFToken')) {
      headers['X-CSRFToken'] = csrfCookie.value;
    }
    if (!hasHeader(headers, 'Date')) {
      headers.Date = rfc1123Date();
    }
    if (!hasHeader(headers, 'User-Agent')) {
      headers['User-Agent'] = JUMPSERVER_CLIENT_USER_AGENT;
    }
    const response = await withDeadline(
      (signal) => this.fetchImpl(url, { ...init, headers, signal }),
      budget === 'listing' ? this.timeouts.listingMs : this.timeouts.requestMs,
      budget,
      logRoute(url)
    );
    this.captureCookies(response, url);
    if (requireOk && !response.ok) {
      return await this.requireOkResponse(
        response,
        pathOrUrl,
        typeof init.method === 'string' ? init.method : 'GET'
      );
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
  return response.status === 401;
}

function appendLimitOffset(path: string, limit: number, offset: number): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}limit=${limit}&offset=${offset}`;
}

function listPageRecords(body: ListPage | unknown[]): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  for (const candidate of [body.results, body.items, body.data]) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function listPageTotal(body: ListPage | unknown[]): number | undefined {
  if (Array.isArray(body)) {
    return undefined;
  }
  for (const candidate of [body.count, body.total]) {
    if (Number.isInteger(candidate) && (candidate as number) >= 0) {
      return candidate;
    }
  }
  return undefined;
}

function listPageNext(body: ListPage | unknown[]): string | null | undefined {
  if (Array.isArray(body)) {
    return undefined;
  }
  if (typeof body.next === 'string' && body.next.length > 0) {
    return body.next;
  }
  if (body.next === null) {
    return null;
  }
  return undefined;
}

function dedupeAssetsById(assets: CachedJumpServerAsset[]): CachedJumpServerAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (!asset.id) {
      return true;
    }
    if (seen.has(asset.id)) {
      return false;
    }
    seen.add(asset.id);
    return true;
  });
}

function boundedCount(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
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
