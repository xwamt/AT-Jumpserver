import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from '../../test-fixtures/selfSignedTls';
import { listenHttp, listenHttps, type TestServer } from './testHttpServer';
import {
  assetPathsFromNodes,
  cookiesForUrl,
  defaultWebSocketFactory,
  parseSetCookieHeader,
  resolveJumpServerUrl,
  buildConnectionTokenPayload,
  buildSftpConnectionTokenPayload,
  buildMysqlConnectionTokenPayload,
  buildRedisConnectionTokenPayload,
  buildKokoConnectUrl,
  buildKokoSftpWsUrl,
  buildKokoWsUrl,
  buildOrigin,
  DEFAULT_CONNECT_OPTIONS,
  DEFAULT_MYSQL_CONNECT_OPTIONS,
  DEFAULT_REDIS_CONNECT_OPTIONS,
  DEFAULT_SFTP_CONNECT_OPTIONS,
  extractAssetTreeNodes,
  JumpServerApiError,
  JumpServerClient,
  normalizeJumpServerAsset,
  parseCsrfMiddlewareToken,
  resolveFirstUsableAccount
} from '../../src/jumpserver/JumpServerClient';
import { DEFAULT_ORG_ID } from '../../src/jumpserver/orgs';

describe('JumpServerClient pure helpers', () => {
  it('builds browser origin from baseUrl', () => {
    expect(buildOrigin('https://jumpserver.example.com/root')).toBe('https://jumpserver.example.com');
  });

  it('builds KoKo connect page URL', () => {
    expect(buildKokoConnectUrl('https://jumpserver.example.com/', 'token-1', 1000)).toBe(
      'https://jumpserver.example.com/koko/connect/?disableautohash=false&token=token-1&_=1000'
    );
  });

  it('builds KoKo websocket URL from smart endpoint', () => {
    expect(
      buildKokoWsUrl('https://jumpserver.example.com', { host: 'koko.example.com', https_port: 8443 }, 'token-1', 1000)
    ).toBe('wss://koko.example.com:8443/koko/ws/terminal/?disableautohash=false&token=token-1&_=1000');
  });

  it('builds KoKo SFTP websocket URL from smart endpoint', () => {
    expect(
      buildKokoSftpWsUrl('https://jumpserver.example.com', { host: 'koko.example.com', https_port: 8443 }, 'token-1', 1000)
    ).toBe('wss://koko.example.com:8443/koko/ws/sftp/?token=token-1&_=1000');
  });

  it('parses csrfmiddlewaretoken from JumpServer login HTML', () => {
    expect(parseCsrfMiddlewareToken('<input name="csrfmiddlewaretoken" value="csrf-1">')).toBe('csrf-1');
  });

  it('normalizes JumpServer assets like Ahell', () => {
    expect(
      normalizeJumpServerAsset({
        id: 'asset-1',
        name: 'web-1',
        address: '10.0.0.10',
        platform: { name: 'Linux' },
        category: { value: 'host' },
        type: { value: 'server' },
        nodes: [{ name: 'Production' }, { name: 'Web' }],
        zone: { name: 'zone-a' },
        protocols: [{ name: 'ssh' }]
      })
    ).toMatchObject({
      id: 'asset-1',
      name: 'web-1',
      nodePath: ['Production', 'Web'],
      zoneName: 'zone-a',
      protocolNames: ['ssh']
    });
  });

  it('normalizes multi-level JumpServer node paths from display path fields', () => {
    expect(
      normalizeJumpServerAsset({
        id: 'asset-1',
        name: 'gateway02',
        address: '11.0.139.162',
        nodes_display: '/Default/Production/Gateway',
        protocols: [{ name: 'ssh' }]
      })
    ).toMatchObject({
      nodePath: ['Default', 'Production', 'Gateway'],
      zoneName: 'Gateway'
    });
  });

  it('normalizes multi-level JumpServer node paths from node full values', () => {
    expect(
      normalizeJumpServerAsset({
        id: 'asset-1',
        name: 'gateway02',
        address: '11.0.139.162',
        nodes: [
          { id: 'node-1', name: 'Gateway', full_value: '/Default/Production/Gateway' },
          { id: 'node-2', name: 'Short' }
        ],
        protocols: [{ name: 'ssh' }]
      })
    ).toMatchObject({
      nodePath: ['Default', 'Production', 'Gateway'],
      zoneName: 'Gateway'
    });
  });

  it('rebuilds JumpServer zTree flat node responses into parent-child paths', () => {
    const nodes = extractAssetTreeNodes([
      { id: 'default-key', name: 'DEFAULT (42)', pId: '', isParent: true, meta: { type: 'node', data: { id: 'node-default', key: 'default-key', value: 'DEFAULT' } } },
      { id: 'prod-key', name: 'PROD (31)', pId: 'default-key', isParent: true, meta: { type: 'node', data: { id: 'node-prod', key: 'prod-key', value: 'PROD' } } },
      { id: 'middleware-key', name: 'Middleware (5)', pId: 'prod-key', isParent: true, meta: { type: 'node', data: { id: 'node-middleware', key: 'middleware-key', value: 'Middleware' } } },
      { id: 'asset-1', name: 'gateway02', pId: 'middleware-key', isParent: false, meta: { type: 'asset' } }
    ]);

    expect(nodes.map((node) => node.path)).toEqual([
      ['DEFAULT (42)'],
      ['DEFAULT (42)', 'PROD (31)'],
      ['DEFAULT (42)', 'PROD (31)', 'Middleware (5)']
    ]);
    expect(nodes.at(-1)?.assetIds).toEqual(['asset-1']);
  });

  it('rebuilds flat JumpServer node responses that use parent fields', () => {
    const nodes = extractAssetTreeNodes([
      { id: 'node-default', name: 'DEFAULT', parent: null, meta: { type: 'node', data: { id: 'node-default', key: 'node-default', value: 'DEFAULT', parent: '' } } },
      { id: 'node-prod', name: 'PROD', parent: 'node-default', meta: { type: 'node', data: { id: 'node-prod', key: 'node-prod', value: 'PROD', parent: 'node-default' } } },
      { id: 'node-service', name: 'service', parent: 'node-prod', meta: { type: 'node', data: { id: 'node-service', key: 'node-service', value: 'service', parent: 'node-prod' } } },
      { id: 'asset-1', name: 'gateway02', parent: 'node-service', meta: { type: 'asset', data: { id: 'asset-1', parent: 'node-service' } } }
    ]);

    expect(nodes.map((node) => node.path)).toEqual([
      ['DEFAULT'],
      ['DEFAULT', 'PROD'],
      ['DEFAULT', 'PROD', 'service']
    ]);
    expect(nodes.at(-1)?.assetIds).toEqual(['asset-1']);
  });

  it('selects a usable account with alias metadata without exposing account choice to users', () => {
    expect(
      resolveFirstUsableAccount({
        permed_accounts: [
          { id: 'account-1', alias: '@virtual', username: 'virtual', has_secret: true },
          { id: 'account-2', alias: 'mysql-root', username: 'root', has_secret: true },
          { id: 'account-3', name: 'deploy' }
        ]
      })
    ).toEqual({ id: 'account-2', alias: 'mysql-root', username: 'root', hasSecret: true });
  });

  it('builds Ahell-compatible connection-token payload', () => {
    expect(
      buildConnectionTokenPayload({
        assetId: 'asset-1',
        account: { id: 'account-1', username: 'root' },
        protocol: 'ssh'
      })
    ).toEqual({
      asset: 'asset-1',
      account: 'account-1',
      protocol: 'ssh',
      input_username: 'root',
      input_secret: '',
      connect_method: 'web_cli',
      connect_options: DEFAULT_CONNECT_OPTIONS
    });
  });


  it('builds MySQL db_client connection-token payload with account alias', () => {
    expect(buildMysqlConnectionTokenPayload({
      assetId: 'mysql-1',
      account: { id: 'account-id-1', alias: 'mysql-alias', username: 'root', hasSecret: true }
    })).toEqual({
      asset: 'mysql-1',
      account: 'mysql-alias',
      protocol: 'mysql',
      input_username: 'root',
      input_secret: '',
      connect_method: 'db_client',
      connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
    });
  });

  it('builds Redis db_client connection-token payload with account alias', () => {
    const redisPayload = buildRedisConnectionTokenPayload({
      assetId: 'redis-1',
      account: { id: 'acc-1', alias: '@redis', username: 'redis' }
    });
    expect(redisPayload).toEqual({
      asset: 'redis-1',
      account: '@redis',
      protocol: 'redis',
      input_username: 'redis',
      input_secret: '',
      connect_method: 'db_client',
      connect_options: DEFAULT_REDIS_CONNECT_OPTIONS
    });
    expect(buildConnectionTokenPayload({
      assetId: 'redis-1',
      account: { id: 'acc-1', alias: '@redis', username: 'redis' },
      protocol: 'redis'
    })).toEqual(redisPayload);
  });

  it('builds SFTP connection-token payload with the probe-confirmed method', () => {
    expect(buildSftpConnectionTokenPayload({
      assetId: 'asset-1',
      account: { id: 'account-1', username: 'root' }
    })).toEqual({
      asset: 'asset-1',
      account: 'account-1',
      protocol: 'sftp',
      input_username: 'root',
      input_secret: '',
      connect_method: 'sftp',
      connect_options: DEFAULT_SFTP_CONNECT_OPTIONS
    });
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html', ...(init.headers || {}) },
    ...init
  });
}

describe('JumpServerClient full asset pagination', () => {
  const settings = {
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  };

  function assetRecords(offset: number, size: number): Array<Record<string, string>> {
    return Array.from({ length: size }, (_unused, index) => ({
      id: `asset-${offset + index}`,
      name: `host-${offset + index}`
    }));
  }

  function readOffset(url: string): number {
    return Number(new URL(url).searchParams.get('offset') ?? '0');
  }

  function readLimit(url: string): number {
    return Number(new URL(url).searchParams.get('limit') ?? '0');
  }

  /** Serves `total` assets, page by page, the way JumpServer's DRF paginator does. */
  function pagedJumpServer(total: number, options: { reportCount?: boolean; delayMs?: number } = {}) {
    const state = { inFlight: 0, peakInFlight: 0, pageRequests: [] as number[], treeRequests: 0 };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      if (url.includes('all-with-assets')) {
        state.treeRequests += 1;
        return jsonResponse([]);
      }
      state.inFlight += 1;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      const offset = readOffset(url);
      const limit = readLimit(url);
      state.pageRequests.push(offset);
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      state.inFlight -= 1;
      const results = assetRecords(offset, Math.max(0, Math.min(limit, total - offset)));
      return jsonResponse(options.reportCount === false ? results : { count: total, results });
    });
    return { fetchMock, state };
  }

  it('keeps paging until every asset JumpServer reports has been fetched', async () => {
    const { fetchMock, state } = pagedJumpServer(450);
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 200, treePaths: new Map() });

    expect(inventory.assets).toHaveLength(450);
    expect(inventory.total).toBe(450);
    expect(inventory.truncated).toBe(false);
    expect(inventory.assets.at(-1)?.id).toBe('asset-449');
    expect([...state.pageRequests].sort((a, b) => a - b)).toEqual([0, 200, 400]);
  });

  it('fetches the remaining pages concurrently but within the configured cap', async () => {
    const { fetchMock, state } = pagedJumpServer(2000, { delayMs: 5 });
    const client = new JumpServerClient(settings, fetchMock);

    await client.listAllAssets({ pageSize: 200, concurrency: 4, treePaths: new Map() });

    expect(state.peakInFlight).toBeGreaterThan(1);
    expect(state.peakInFlight).toBeLessThanOrEqual(4);
  });

  it('stops at the safety cap when JumpServer reports an impossible total', async () => {
    const { fetchMock, state } = pagedJumpServer(1000);
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 200, maxAssets: 500, treePaths: new Map() });

    expect(inventory.assets).toHaveLength(500);
    expect(inventory.total).toBe(1000);
    expect(inventory.truncated).toBe(true);
    expect(state.pageRequests).toHaveLength(3);
  });

  it('walks pages one at a time when JumpServer omits the count', async () => {
    const { fetchMock, state } = pagedJumpServer(450, { reportCount: false });
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 200, treePaths: new Map() });

    expect(inventory.assets).toHaveLength(450);
    expect(inventory.total).toBe(450);
    expect(inventory.truncated).toBe(false);
    expect(state.pageRequests).toEqual([0, 200, 400]);
  });

  it('fetches the node tree once no matter how many pages it walks', async () => {
    const { fetchMock, state } = pagedJumpServer(1000);
    const client = new JumpServerClient(settings, fetchMock);

    await client.listAllAssets({ pageSize: 200 });

    expect(state.treeRequests).toBe(1);
  });

  it('drops assets a shifting paginator handed back twice', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      // Both pages contain asset-1; a real paginator does this when a row is
      // inserted between page requests.
      return jsonResponse({
        count: 4,
        results: readOffset(url) === 0
          ? [{ id: 'asset-1', name: 'a' }, { id: 'asset-2', name: 'b' }]
          : [{ id: 'asset-1', name: 'a' }, { id: 'asset-3', name: 'c' }]
      });
    });
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 2, treePaths: new Map() });

    expect(inventory.assets.map((asset) => asset.id)).toEqual(['asset-1', 'asset-2', 'asset-3']);
  });

  it('does not loop forever when a reported page comes back empty', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      return jsonResponse(readOffset(url) === 0
        ? { count: 100_000, results: [{ id: 'asset-1', name: 'a' }] }
        : { count: 100_000, results: [] });
    });
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 1, maxAssets: 5, treePaths: new Map() });

    expect(inventory.assets.map((asset) => asset.id)).toEqual(['asset-1']);
    expect(inventory.total).toBe(100_000);
    expect(inventory.truncated).toBe(true);
  });

  it('follows a DRF next link rewritten onto the configured origin', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({
        count: 2,
        next: 'https://internal.example.com/api/v1/perms/users/self/assets/?all=1&display=1&limit=1&offset=1',
        results: [{ id: 'asset-0', name: 'a' }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        count: 2,
        next: null,
        results: [{ id: 'asset-1', name: 'b' }]
      }));
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 1, treePaths: new Map() });

    expect(inventory.assets.map((asset) => asset.id)).toEqual(['asset-0', 'asset-1']);
    const called = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(called.some((url) => url.startsWith('https://jumpserver.example.com/api/v1/perms/users/self/assets/') && url.includes('offset=1'))).toBe(true);
    expect(called.every((url) => !url.includes('internal.example.com'))).toBe(true);
  });

  it('stops when JumpServer repeats the same list page', async () => {
    const page = [{ id: 'asset-0', name: 'a' }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockImplementation(async () => jsonResponse(page));
    const client = new JumpServerClient(settings, fetchMock);

    const inventory = await client.listAllAssets({ pageSize: 1, maxAssets: 50, treePaths: new Map() });

    expect(inventory.assets).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/self/assets/')).length).toBeLessThan(5);
  });

  it('retries a throttled asset page using the JumpServer wait hint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'Expected available in 0 second' }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'asset-0', name: 'a' }], count: 1 }));
    const client = new JumpServerClient(settings, fetchMock, { sleep: async () => undefined });

    const inventory = await client.listAllAssets({ pageSize: 200, treePaths: new Map() });

    expect(inventory.assets).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/self/assets/')).length).toBe(2);
  });
});

describe('JumpServerClient node tree reuse', () => {
  const settings = {
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  };

  it('derives asset paths from nodes the caller already fetched', () => {
    expect(
      assetPathsFromNodes([
        { id: 'n1', name: 'PROD', path: ['DEFAULT', 'PROD'], assetIds: ['asset-1', 'asset-2'], raw: {} },
        { id: 'n2', name: 'UAT', path: ['DEFAULT', 'UAT'], assetIds: ['asset-3'], raw: {} }
      ])
    ).toEqual(new Map([
      ['asset-1', ['DEFAULT', 'PROD']],
      ['asset-2', ['DEFAULT', 'PROD']],
      ['asset-3', ['DEFAULT', 'UAT']]
    ]));
  });

  it('skips the node tree endpoint when the caller injects the paths', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'asset-1', name: 'web-1' }], count: 1 }));
    const client = new JumpServerClient(settings, fetchMock);

    const assets = await client.listAssets({
      limit: 200,
      offset: 0,
      treePaths: new Map([['asset-1', ['DEFAULT', 'PROD']]])
    });

    expect(assets[0]).toMatchObject({ nodePath: ['DEFAULT', 'PROD'], zoneName: 'PROD' });
    expect(fetchMock.mock.calls.map(([url]) => url as string).filter((url) => url.includes('all-with-assets'))).toEqual([]);
  });

  it('verifies the account against the user profile without listing anything', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1', username: 'alan' }));
    const client = new JumpServerClient(settings, fetchMock);

    await expect(client.getUserProfile()).resolves.toMatchObject({ username: 'alan' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://jumpserver.example.com/api/v1/authentication/auth/',
      'https://jumpserver.example.com/api/v1/users/profile/'
    ]);
  });
});

describe('JumpServerClient timeouts', () => {
  const settings = {
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  };

  function hang(): Promise<Response> {
    return new Promise<Response>(() => undefined);
  }

  it('gives up on a JumpServer that accepts the request and never answers', async () => {
    const client = new JumpServerClient(settings, () => hang(), { requestMs: 20 });

    await expect(client.ensureAuthToken()).rejects.toThrow(/timed out after 20ms/i);
  });

  it('aborts the underlying request when the deadline passes', async () => {
    let seen: AbortSignal | undefined;
    const client = new JumpServerClient(settings, (_url, init) => {
      seen = init?.signal ?? undefined;
      return hang();
    }, { requestMs: 20 });

    await expect(client.ensureAuthToken()).rejects.toThrow(/timed out/i);
    expect(seen?.aborted).toBe(true);
  });

  it('keeps the JumpServer URL out of the timeout message so tokens cannot leak', async () => {
    const client = new JumpServerClient(settings, () => hang(), { requestMs: 20 });

    await expect(
      client.getSmartEndpoint('super-secret-token')
    ).rejects.toThrow(/^JumpServer request timed out after 20ms\.$/);
  });

  it('gives bulk listings a longer budget than ordinary REST calls', async () => {
    const client = new JumpServerClient(settings, (url) =>
      url.includes('/authentication/auth/') ? Promise.resolve(jsonResponse({ token: 'bearer-1' })) : hang(),
    { requestMs: 10, listingMs: 300 });

    const startedAt = Date.now();
    await expect(client.listAssetNodes()).rejects.toThrow(/timed out after 300ms/i);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it('does not arm a timer that outlives a request that answered in time', async () => {
    const client = new JumpServerClient(settings, () => Promise.resolve(jsonResponse({ token: 'bearer-1' })), {
      requestMs: 20
    });

    await expect(client.ensureAuthToken()).resolves.toBe('bearer-1');
    // A leaked 20ms timer would keep the event loop busy past its own deadline.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.cookieHeader()).toBe('');
  });
});

describe('defaultWebSocketFactory', () => {
  const listeners: net.Server[] = [];
  const accepted: net.Socket[] = [];

  afterEach(async () => {
    // net.Server.close() waits for accepted sockets, and a silent server never
    // releases them on its own.
    accepted.splice(0).forEach((socket) => socket.destroy());
    await Promise.all(listeners.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function acceptAndStaySilent(): Promise<number> {
    const server = net.createServer((socket) => accepted.push(socket));
    listeners.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('gives up on a KoKo handshake that never completes', async () => {
    const port = await acceptAndStaySilent();

    await expect(
      defaultWebSocketFactory(`ws://127.0.0.1:${port}/koko/ws/terminal/`, {}, 40)
    ).rejects.toThrow(/timed out after 40ms/i);
  });

  it('detaches its handshake listeners once the socket is open', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'JMS-KOKO' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const socket = await defaultWebSocketFactory(`ws://127.0.0.1:${port}/koko/ws/terminal/`, {}, 2000);

    expect(socket.listenerCount('open')).toBe(0);
    // A late failure must not reach the settled handshake promise, and must not
    // crash the extension host for want of an 'error' listener.
    expect(() => socket.emit('error', new Error('late failure'))).not.toThrow();
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('JumpServerClient health and orgs', () => {
  const settings = {
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  };

  it('reads health, orgs, and the current org', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: DEFAULT_ORG_ID, name: 'Default' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: DEFAULT_ORG_ID, name: 'Default' }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    await expect(client.healthCheck()).resolves.toEqual({ status: 'ok' });
    const orgs = await client.listAccessibleOrgs();
    expect(orgs).toEqual([{ id: DEFAULT_ORG_ID, name: 'Default' }]);
    await expect(client.getCurrentOrg()).resolves.toMatchObject({ id: DEFAULT_ORG_ID, name: 'Default' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://jumpserver.example.com/api/health/', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/api/v1/orgs/orgs/', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://jumpserver.example.com/api/v1/orgs/orgs/current/', expect.any(Object));
  });

  it('treats a missing health endpoint as optional', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    await expect(client.healthCheck()).resolves.toEqual({ skipped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/authentication/auth/'))).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).not.toEqual(expect.objectContaining({ Authorization: expect.anything() }));
  });

  it('follows a rewritten org list next link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({
        count: 2,
        next: 'https://internal.example.com/api/v1/orgs/orgs/?limit=1&cursor=page-2',
        results: [{ id: DEFAULT_ORG_ID, name: 'Default' }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        count: 2,
        next: null,
        results: [{ id: 'org-prod', name: 'Prod' }]
      }));
    const client = new JumpServerClient(settings, fetchMock);

    const orgs = await client.listAccessibleOrgs();

    expect(orgs).toEqual([
      { id: DEFAULT_ORG_ID, name: 'Default' },
      { id: 'org-prod', name: 'Prod' }
    ]);
    const called = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(called.some((url) => url === 'https://jumpserver.example.com/api/v1/orgs/orgs/?limit=1&cursor=page-2')).toBe(true);
    expect(called.every((url) => !url.includes('internal.example.com'))).toBe(true);
  });

  it('walks org pages by offset when count is present and next is missing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({
        count: 2,
        results: [{ id: DEFAULT_ORG_ID, name: 'Default' }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        count: 2,
        results: [{ id: 'org-prod', name: 'Prod' }]
      }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    await expect(client.listAccessibleOrgs()).resolves.toEqual([
      { id: DEFAULT_ORG_ID, name: 'Default' },
      { id: 'org-prod', name: 'Prod' }
    ]);
    const called = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(called.some((url) => url.includes('/api/v1/orgs/orgs/') && url.includes('offset=1'))).toBe(true);
  });

  it('skips org list entries that have no id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({
        results: [
          { name: 'Nameless' },
          { id: DEFAULT_ORG_ID, name: 'Default' },
          { id: '', name: 'Empty' }
        ]
      }));
    const client = new JumpServerClient(settings, fetchMock);

    await expect(client.listAccessibleOrgs()).resolves.toEqual([{ id: DEFAULT_ORG_ID, name: 'Default' }]);
  });
});

describe('JumpServerClient REST flow', () => {
  it('authenticates and sends Bearer plus org headers when listing assets', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'asset-1', name: 'web-1' }], count: 1 }))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    const assets = await client.listAssets({ limit: 200, offset: 0 });

    expect(assets).toHaveLength(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://jumpserver.example.com/api/v1/authentication/auth/', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'alan', password: 'secret' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/perms/users/self/assets/?all=1&display=1&limit=200&offset=0', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer bearer-1',
        Accept: 'application/json',
        'X-JMS-ORG': 'org-1'
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/api/v1/perms/users/self/nodes/all-with-assets/tree/', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer bearer-1',
        Accept: 'application/json',
        'X-JMS-ORG': 'org-1'
      })
    }));
  });

  it('merges full JumpServer directory paths from the user asset tree endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{
          id: 'asset-1',
          name: 'gateway02',
          address: '11.0.139.162',
          nodes: [{ name: 'Middleware' }],
          protocols: [{ name: 'ssh' }]
        }]
      }))
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'node-default',
          name: 'DEFAULT',
          children: [
            {
              id: 'node-prod',
              name: 'PROD',
              children: [
                {
                  id: 'node-offline-prod',
                  name: 'offline-prod',
                  children: [
                    {
                      id: 'node-middleware',
                      name: 'Middleware',
                      assets: [{ id: 'asset-1', name: 'gateway02' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    const assets = await client.listAssets({ limit: 200, offset: 0 });

    expect(assets[0]).toMatchObject({
      id: 'asset-1',
      nodePath: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'],
      zoneName: 'Middleware'
    });
  });

  it('lists JumpServer nodes from the node tree endpoint before assets are synced', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'node-default',
          name: 'DEFAULT',
          children: [
            {
              id: 'node-prod',
              name: 'PROD',
              children: [
                {
                  id: 'node-offline-prod',
                  name: 'offline-prod',
                  children: [
                    {
                      id: 'node-middleware',
                      name: 'Middleware',
                      assets: [{ id: 'asset-1', name: 'gateway02' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    const nodes = await client.listAssetNodes();

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/perms/users/self/nodes/all-with-assets/tree/', expect.any(Object));

    expect(nodes.map((node) => node.path)).toEqual([
      ['DEFAULT'],
      ['DEFAULT', 'PROD'],
      ['DEFAULT', 'PROD', 'offline-prod'],
      ['DEFAULT', 'PROD', 'offline-prod', 'Middleware']
    ]);
    expect(nodes.at(-1)?.assetIds).toEqual(['asset-1']);
  });

  it('loads asset details from the current-user self endpoint so non-admin users can connect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'asset-1',
        name: 'web-1',
        permed_protocols: [{ name: 'ssh' }],
        permed_accounts: [{ id: 'account-1', username: 'root', has_secret: true }]
      }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    await expect(client.getAssetDetail('asset-1')).resolves.toMatchObject({ id: 'asset-1' });

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/perms/users/self/assets/asset-1/', expect.any(Object));
  });

  it('creates connection token and smart endpoint requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ host: 'koko.example.com', https_port: 443 }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    const token = await client.createConnectionToken({
      assetId: 'asset-1',
      account: { id: 'account-1', username: 'root' },
      protocol: 'ssh'
    });
    const endpoint = await client.getSmartEndpoint(token.id);

    expect(token.id).toBe('token-1');
    expect(endpoint.host).toBe('koko.example.com');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/authentication/connection-token/', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"connect_method":"web_cli"')
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/api/v1/terminal/endpoints/smart/?protocol=https&token=token-1', expect.any(Object));
  });

  it('creates MySQL db_client connection tokens', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'mysql-token-1' }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    const token = await client.createConnectionToken({
      assetId: 'mysql-1',
      account: { id: 'account-id-1', alias: 'mysql-alias', username: 'root', hasSecret: true },
      protocol: 'mysql'
    });

    expect(token.id).toBe('mysql-token-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/authentication/connection-token/', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"connect_method":"db_client"')
    }));
  });

  it('warms up KoKo web session with csrf and cookies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/core/auth/login/?next=%2Fkoko%2Fconnect%2F%3Fdisableautohash%3Dfalse%26token%3Dtoken-1%26_%3D1000' } }))
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', { headers: { 'set-cookie': 'csrftoken=abc; Path=/' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' } }))
      .mockResolvedValueOnce(textResponse('ok'))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(textResponse('<html>koko</html>'));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    await client.warmupKokoConnectPage('token-1', 1000);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://jumpserver.example.com/koko/connect/?disableautohash=false&token=token-1&_=1000', expect.objectContaining({
      redirect: 'manual'
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/core/auth/login/?next=%2Fkoko%2Fconnect%2F%3Fdisableautohash%3Dfalse%26token%3Dtoken-1%26_%3D1000', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Cookie: 'csrftoken=abc'
      })
    }));
    expect(fetchMock).toHaveBeenLastCalledWith('https://jumpserver.example.com/koko/connect/?disableautohash=false&token=token-1&_=1000', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'csrftoken=abc; sessionid=session-1'
      })
    }));
  });

  it('retries KoKo warmup once with a fresh web session when the connect page redirects to login', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/core/auth/login/?next=%2Fkoko%2Fconnect%2F%3Fdisableautohash%3Dfalse%26token%3Dtoken-1%26_%3D1000' } }))
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', { headers: { 'set-cookie': 'csrftoken=abc; Path=/' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/ui/', 'set-cookie': 'sessionid=expired; Path=/' } }))
      .mockResolvedValueOnce(textResponse('ok'))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/core/auth/login/' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/core/auth/login/?next=%2Fkoko%2Fconnect%2F%3Fdisableautohash%3Dfalse%26token%3Dtoken-1%26_%3D1000' } }))
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-2">', { headers: { 'set-cookie': 'csrftoken=def; Path=/' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/ui/', 'set-cookie': 'sessionid=session-2; Path=/' } }))
      .mockResolvedValueOnce(textResponse('ok'))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(textResponse('<html>koko</html>'));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    await client.warmupKokoConnectPage('token-1', 1000);

    expect(fetchMock).toHaveBeenNthCalledWith(8, 'https://jumpserver.example.com/core/auth/login/?next=%2Fkoko%2Fconnect%2F%3Fdisableautohash%3Dfalse%26token%3Dtoken-1%26_%3D1000', expect.objectContaining({
      headers: expect.not.objectContaining({ Cookie: expect.stringContaining('sessionid=expired') })
    }));
    expect(fetchMock).toHaveBeenLastCalledWith('https://jumpserver.example.com/koko/connect/?disableautohash=false&token=token-1&_=1000', expect.objectContaining({
      headers: expect.objectContaining({
        Cookie: 'csrftoken=def; sessionid=session-2'
      })
    }));
  });

  it('refreshes an expired Bearer token once when a REST request returns unauthorized', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-old' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'token expired' }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-new' }))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    await expect(client.listAssetNodes()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/perms/users/self/nodes/all-with-assets/tree/', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer bearer-old' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://jumpserver.example.com/api/v1/perms/users/self/nodes/all-with-assets/tree/', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer bearer-new' })
    }));
  });

  it('does not treat HTTP 403 as an expired Bearer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'forbidden' }, { status: 403 }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'wrong-org',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    await expect(client.listAssetNodes()).rejects.toMatchObject({ reason: 'forbidden', statusCode: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens KoKo SFTP websocket with warmed cookies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/core/auth/login/?next=%2Fkoko%2Fconnect%2F%3Fdisableautohash%3Dfalse%26token%3Dtoken-1' } }))
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', { headers: { 'set-cookie': 'csrftoken=abc; Path=/' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' } }))
      .mockResolvedValueOnce(textResponse('ok'))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(textResponse('<html>koko</html>'));
    const socket = { send: vi.fn(), close: vi.fn(), on: vi.fn(), ping: vi.fn(), terminate: vi.fn(), bufferedAmount: 0 };
    const webSocketFactory = vi.fn(async () => socket);
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
    }, fetchMock);

    await client.openKokoSftpWebSocket({
      endpoint: { host: 'koko.example.com', https_port: 443 },
      tokenId: 'token-1',
      timestamp: 1000,
      webSocketFactory
    });

    expect(webSocketFactory).toHaveBeenCalledWith('wss://koko.example.com/koko/ws/sftp/?token=token-1&_=1000', expect.objectContaining({
      origin: 'https://jumpserver.example.com',
      rejectUnauthorized: true,
      headers: expect.objectContaining({ Cookie: 'csrftoken=abc; sessionid=session-1' })
    }));
  });

  it('surfaces the JumpServer detail field instead of a bare status', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      return jsonResponse({ detail: 'You do not have permission to perform this action.' }, { status: 403 });
    });
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    const error = await client.getAssetDetail('asset-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JumpServerApiError);
    expect(String(error)).toMatch(/You do not have permission to perform this action/);
    expect((error as JumpServerApiError).reason).toBe('forbidden');
  });

  it('sends an RFC 1123 Date header on REST calls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    await client.getUserProfile();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://jumpserver.example.com/api/v1/users/profile/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Date: expect.stringMatching(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
        })
      })
    );
  });

  it('surfaces the API detail when authentication fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'Unable to log in with provided credentials.' }, { status: 400 }));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    }, fetchMock);

    const error = await client.getUserProfile().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JumpServerApiError);
    expect(String(error)).toMatch(/Unable to log in with provided credentials/);
  });
});

describe('resolveJumpServerUrl', () => {
  it('resolves a relative path against the configured JumpServer origin', () => {
    expect(resolveJumpServerUrl('https://jumpserver.example.com/root', '/core/auth/login/?next=%2Fkoko%2F')).toBe(
      'https://jumpserver.example.com/core/auth/login/?next=%2Fkoko%2F'
    );
  });

  it('accepts an absolute URL that stays on the JumpServer origin', () => {
    expect(resolveJumpServerUrl('https://jumpserver.example.com', 'https://jumpserver.example.com:443/ui/')).toBe(
      'https://jumpserver.example.com:443/ui/'
    );
  });

  it('rejects an absolute URL that points at another host', () => {
    expect(() => resolveJumpServerUrl('https://jumpserver.example.com', 'https://evil.example.com/login/')).toThrow(
      /cross-origin/i
    );
  });

  it('rejects a downgrade to http on the same host', () => {
    expect(() => resolveJumpServerUrl('https://jumpserver.example.com', 'http://jumpserver.example.com/login/')).toThrow(
      /cross-origin/i
    );
  });
});

describe('JumpServer cookie jar scoping', () => {
  it('records the request host as a host-only domain when Set-Cookie omits Domain', () => {
    expect(parseSetCookieHeader('sessionid=session-1; Path=/', 'https://jumpserver.example.com/core/auth/login/')).toEqual([
      { name: 'sessionid', value: 'session-1', domain: 'jumpserver.example.com', hostOnly: true, path: '/', secure: false }
    ]);
  });

  it('does not send JumpServer cookies to another host', () => {
    const jar = parseSetCookieHeader('sessionid=session-1; Path=/', 'https://jumpserver.example.com/');
    expect(cookiesForUrl(jar, 'https://evil.example.com/login/')).toBe('');
  });

  it('sends JumpServer cookies back to the host that set them', () => {
    const jar = [
      ...parseSetCookieHeader('csrftoken=abc; Path=/', 'https://jumpserver.example.com/'),
      ...parseSetCookieHeader('sessionid=session-1; Path=/', 'https://jumpserver.example.com/')
    ];
    expect(cookiesForUrl(jar, 'https://jumpserver.example.com/koko/connect/')).toBe('csrftoken=abc; sessionid=session-1');
  });

  it('keeps a path-scoped cookie out of requests to unrelated paths', () => {
    const jar = parseSetCookieHeader('kokoid=k1; Path=/koko', 'https://jumpserver.example.com/koko/connect/');
    expect(cookiesForUrl(jar, 'https://jumpserver.example.com/koko/ws/')).toBe('kokoid=k1');
    expect(cookiesForUrl(jar, 'https://jumpserver.example.com/api/v1/users/profile/')).toBe('');
  });

  it('never sends a Secure cookie over plain http', () => {
    const jar = parseSetCookieHeader('sessionid=s1; Path=/; Secure', 'https://jumpserver.example.com/');
    expect(cookiesForUrl(jar, 'http://jumpserver.example.com/')).toBe('');
  });
});

describe('JumpServerClient cross-origin redirect defense', () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function hostileRedirectSetup() {
    const attacker = await listenHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sessionid=attacker; Path=/' });
      res.end('<input name="csrfmiddlewaretoken" value="csrf-evil">');
    });
    const jumpserver = await listenHttp((req, res) => {
      if (req.url?.startsWith('/koko/connect/')) {
        res.writeHead(302, { location: `${attacker.url}/core/auth/login/?next=/koko/connect/` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('ok');
    });
    servers.push(attacker, jumpserver);
    const client = new JumpServerClient({
      baseUrl: jumpserver.url,
      orgId: '',
      username: 'alan',
      password: 'super-secret-bastion-password',
      verifyTls: true
    });
    return { attacker, jumpserver, client };
  }

  it('refuses a login redirect that leaves the JumpServer origin', async () => {
    const { client } = await hostileRedirectSetup();

    await expect(client.warmupKokoConnectPage('token-1', 1000)).rejects.toThrow(/cross-origin/i);
  });

  it('sends nothing at all to the host named by a cross-origin Location header', async () => {
    const { attacker, client } = await hostileRedirectSetup();

    await client.warmupKokoConnectPage('token-1', 1000).catch(() => undefined);

    expect(attacker.requests).toEqual([]);
  });
});

describe('JumpServerClient REST TLS verification', () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function selfSignedJumpServer(): Promise<TestServer> {
    const server = await listenHttps({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"token":"bearer-1"}');
    });
    servers.push(server);
    return server;
  }

  it('reaches a self-signed JumpServer over REST when verifyTls is off', async () => {
    const server = await selfSignedJumpServer();
    const client = new JumpServerClient({
      baseUrl: server.url,
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: false
    });

    await expect(client.ensureAuthToken()).resolves.toBe('bearer-1');
  });

  it('still refuses a self-signed JumpServer over REST when verifyTls is on', async () => {
    const server = await selfSignedJumpServer();
    const client = new JumpServerClient({
      baseUrl: server.url,
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: true
    });

    await expect(client.ensureAuthToken()).rejects.toThrow(/self.signed|self signed/i);
  });
});

