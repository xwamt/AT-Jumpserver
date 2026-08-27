import { Agent as HttpsAgent } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_DETAIL_CACHE_LIMIT,
  JumpServerClient,
  kokoWsAgentForEndpoint
} from '../../src/jumpserver/JumpServerClient';
import { createWebSessionSecretStore, webSessionStoreKey } from '../../src/jumpserver/webSessionStore';
import { setLogSink } from '../../src/utils/logger';

const settings = {
  baseUrl: 'https://jumpserver.example.com',
  orgId: '',
  username: 'alan',
  password: 'secret',
  verifyTls: true
};

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

function fakeSocket() {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn(), ping: vi.fn(), terminate: vi.fn(), bufferedAmount: 0 };
}

/** An in-memory JumpServerWebSessionStore that records every interaction. */
function memoryStore(initial?: string) {
  let value = initial;
  const saves: string[] = [];
  const state = { clears: 0 };
  return {
    saves,
    state,
    value: () => value,
    load: async () => value,
    save: async (next: string) => {
      saves.push(next);
      value = next;
    },
    clear: async () => {
      state.clears += 1;
      value = undefined;
    }
  };
}

function storedSession(cookies: Array<Partial<{ name: string; value: string; domain: string }>>): string {
  return JSON.stringify({
    cookies: cookies.map((cookie) => ({
      name: 'sessionid',
      value: 'session-1',
      domain: 'jumpserver.example.com',
      hostOnly: true,
      path: '/',
      secure: false,
      ...cookie
    }))
  });
}

afterEach(() => {
  setLogSink(undefined);
});

describe('kokoWsAgentForEndpoint', () => {
  const agent = new HttpsAgent();

  afterEach(() => {
    agent.destroy();
  });

  it('returns the REST agent when the endpoint is the same https authority', () => {
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com', { host: 'jumpserver.example.com', https_port: 443 }, agent)).toBe(agent);
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com', {}, agent)).toBe(agent);
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com:8443', { host: 'jumpserver.example.com', https_port: 8443 }, agent)).toBe(agent);
    expect(kokoWsAgentForEndpoint('https://JUMPSERVER.example.com', { host: 'jumpserver.EXAMPLE.com' }, agent)).toBe(agent);
  });

  it('withholds the agent when the KoKo host differs from the REST host', () => {
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com', { host: 'koko.example.com', https_port: 443 }, agent)).toBeUndefined();
  });

  it('withholds the agent when only the https port differs', () => {
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com', { host: 'jumpserver.example.com', https_port: 8443 }, agent)).toBeUndefined();
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com:8443', { host: 'jumpserver.example.com' }, agent)).toBeUndefined();
  });

  it('never hands the https agent to a plain-http deployment', () => {
    expect(kokoWsAgentForEndpoint('http://jumpserver.example.com', { host: 'jumpserver.example.com' }, agent)).toBeUndefined();
  });

  it('returns undefined when the client has no agent to share', () => {
    expect(kokoWsAgentForEndpoint('https://jumpserver.example.com', { host: 'jumpserver.example.com' }, undefined)).toBeUndefined();
  });
});

describe('JumpServerClient smart endpoint by asset id', () => {
  it('queries the smart endpoint with asset_id instead of a token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ host: 'koko.example.com', https_port: 443 }));
    const client = new JumpServerClient(settings, fetchMock);

    const endpoint = await client.getSmartEndpointForAsset('asset-1');

    expect(endpoint.host).toBe('koko.example.com');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://jumpserver.example.com/api/v1/terminal/endpoints/smart/?protocol=https&asset_id=asset-1',
      expect.any(Object)
    );
  });

  it('shares the endpoint cache with the token-based lookup', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ host: 'koko.example.com', https_port: 443 }));
    const client = new JumpServerClient(settings, fetchMock);

    const first = await client.getSmartEndpointForAsset('asset-1');
    const second = await client.getSmartEndpoint('token-1');
    const third = await client.getSmartEndpointForAsset('asset-2');

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/terminal/endpoints/smart/'))).toHaveLength(1);
  });

  it('surfaces a 4xx so the caller can fall back to the token lookup', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'asset_id not supported' }, { status: 400 }));
    const client = new JumpServerClient(settings, fetchMock);

    await expect(client.getSmartEndpointForAsset('asset-1')).rejects.toThrow(/asset_id not supported/);
  });
});

describe('JumpServerClient asset detail cache cap', () => {
  it('drops the oldest detail once the cap is exceeded', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      const id = String(url).match(/assets\/(asset-\d+)\//)?.[1] ?? 'unknown';
      return jsonResponse({ id });
    });
    const client = new JumpServerClient(settings, fetchMock);
    const detailFetches = (assetId: string) =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes(`/self/assets/${assetId}/`)).length;

    for (let index = 0; index <= ASSET_DETAIL_CACHE_LIMIT; index += 1) {
      await client.getAssetDetail(`asset-${index}`);
    }

    // The 65th insert evicted asset-0 and only asset-0.
    await client.getAssetDetail('asset-0');
    expect(detailFetches('asset-0')).toBe(2);
    await client.getAssetDetail(`asset-${ASSET_DETAIL_CACHE_LIMIT}`);
    expect(detailFetches(`asset-${ASSET_DETAIL_CACHE_LIMIT}`)).toBe(1);
  });
});

describe('JumpServerClient web session persistence', () => {
  it('restores a persisted session and opens the KoKo socket without any warmup fetch', async () => {
    const store = memoryStore(storedSession([
      { name: 'sessionid', value: 'session-1' },
      { name: 'csrftoken', value: 'csrf-1' }
    ]));
    const fetchMock = vi.fn();
    const webSocketFactory = vi.fn(async () => fakeSocket());
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await client.openKokoWebSocket({
      endpoint: { host: 'koko.example.com', https_port: 443 },
      tokenId: 'token-1',
      cols: 80,
      rows: 24,
      webSocketFactory
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(webSocketFactory).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Cookie: expect.stringContaining('sessionid=session-1') })
    }));
  });

  it('makes ensureWebSession a no-op when a restored sessionid exists', async () => {
    const store = memoryStore(storedSession([{ name: 'sessionid', value: 'session-1' }]));
    const fetchMock = vi.fn();
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await client.ensureWebSession();

    expect(client.hasWebSession()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses restored cookies that no longer belong to the bastion host', async () => {
    const store = memoryStore(storedSession([{ name: 'sessionid', value: 'stolen', domain: 'evil.example.com' }]));
    const fetchMock = vi.fn(async () => textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">'));
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await client.ensureWebSession().catch(() => undefined);

    // The foreign cookie was dropped, so the client had to attempt a login.
    expect(fetchMock).toHaveBeenCalled();
    expect(client.cookieHeader()).not.toContain('stolen');
  });

  it('logs in through the Django form without any token in the URL and persists the cookies', async () => {
    const store = memoryStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', {
        headers: { 'set-cookie': 'csrftoken=abc; Path=/' }
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' }
      }));
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await client.ensureWebSession();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://jumpserver.example.com/core/auth/login/?next=/koko/connect/',
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://jumpserver.example.com/core/auth/login/?next=/koko/connect/',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('token='))).toBe(true);
    expect(client.hasWebSession()).toBe(true);
    const saved = JSON.parse(store.saves.at(-1) ?? '{}') as { cookies: Array<{ name: string }> };
    expect(saved.cookies.map((cookie) => cookie.name).sort()).toEqual(['csrftoken', 'sessionid']);
    // Session cookies only: never the password, never the Bearer token.
    expect(store.saves.at(-1)).not.toContain('secret');
    expect(store.saves.at(-1)).not.toContain('Bearer');
  });

  it('runs one form login when two ensureWebSession calls race', async () => {
    let posts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        return new Response('', {
          status: 302,
          headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' }
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">');
    });
    const client = new JumpServerClient(settings, fetchMock);

    await Promise.all([client.ensureWebSession(), client.ensureWebSession()]);

    expect(posts).toBe(1);
  });

  it('persists sessionid and csrftoken after a successful warmup login', async () => {
    const store = memoryStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { location: '/core/auth/login/?next=/koko/connect/' }
      }))
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">', {
        headers: { 'set-cookie': 'csrftoken=abc; Path=/' }
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' }
      }));
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await client.warmupKokoConnectPage('token-1', 1000);

    expect(store.saves).toHaveLength(1);
    const saved = JSON.parse(store.saves[0]) as { cookies: Array<{ name: string; value: string }> };
    expect(saved.cookies.map((cookie) => cookie.name).sort()).toEqual(['csrftoken', 'sessionid']);
    expect(store.saves[0]).not.toContain('secret');
  });

  it('clears the persisted session when the warmup login cannot authenticate', async () => {
    const store = memoryStore(storedSession([{ name: 'csrftoken', value: 'stale-csrf' }]));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const value = String(url);
      // The login URL carries `next=/koko/connect/`, so it must match first.
      if (value.includes('/core/auth/login/')) {
        // The POST never hands out a sessionid: the account cannot log in.
        return init?.method === 'POST'
          ? new Response('', { status: 302, headers: { location: '/ui/' } })
          : textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">');
      }
      if (value.includes('/koko/connect/')) {
        return new Response('', { status: 302, headers: { location: '/core/auth/login/?next=/koko/connect/' } });
      }
      if (value.includes('/ui/')) {
        return textResponse('ok');
      }
      return jsonResponse({ id: 'user-1' });
    });
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await expect(client.warmupKokoConnectPage('token-1', 1000)).rejects.toThrow(/not authenticated/i);

    expect(store.state.clears).toBeGreaterThan(0);
    expect(store.value()).toBeUndefined();
  });

  it('ignores a corrupt persisted value instead of failing the client', async () => {
    const store = memoryStore('{not json');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse('<input name="csrfmiddlewaretoken" value="csrf-1">'))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { location: '/ui/', 'set-cookie': 'sessionid=session-1; Path=/' }
      }));
    const client = new JumpServerClient(settings, fetchMock, { webSessionStore: store });

    await client.ensureWebSession();

    expect(client.hasWebSession()).toBe(true);
  });
});

describe('createWebSessionSecretStore', () => {
  it('scopes the SecretStorage key per bastion and round-trips values', async () => {
    const data = new Map<string, string>();
    const secrets = {
      get: vi.fn(async (key: string) => data.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        data.delete(key);
      })
    };
    const store = createWebSessionSecretStore(secrets, 'bastion-1');

    await store.save('{"cookies":[]}');
    expect(secrets.store).toHaveBeenCalledWith(webSessionStoreKey('bastion-1'), '{"cookies":[]}');
    expect(webSessionStoreKey('bastion-1')).toBe('jumpserver.webSession.bastion-1');

    await expect(store.load()).resolves.toBe('{"cookies":[]}');
    await store.clear();
    expect(data.size).toBe(0);
  });
});
