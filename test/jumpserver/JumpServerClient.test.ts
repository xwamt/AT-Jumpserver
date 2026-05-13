import { describe, expect, it, vi } from 'vitest';
import {
  buildConnectionTokenPayload,
  buildKokoConnectUrl,
  buildKokoWsUrl,
  buildOrigin,
  DEFAULT_CONNECT_OPTIONS,
  JumpServerClient,
  normalizeJumpServerAsset,
  parseCsrfMiddlewareToken,
  resolveFirstUsableAccount
} from '../../src/jumpserver/JumpServerClient';

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

  it('selects the first usable account without exposing account choice to users', () => {
    expect(
      resolveFirstUsableAccount({
        permed_accounts: [
          { id: 'account-1', username: 'root' },
          { id: 'account-2', name: 'deploy' }
        ]
      })
    ).toEqual({ id: 'account-1', username: 'root' });
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

describe('JumpServerClient REST flow', () => {
  it('authenticates and sends Bearer plus org headers when listing assets', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'bearer-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'asset-1', name: 'web-1' }], count: 1 }))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new JumpServerClient({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      password: 'secret',
      verifyTls: true,
      connectTimeout: 30
    }, fetchMock);

    const assets = await client.listAssets({ limit: 200, offset: 0 });

    expect(assets).toHaveLength(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://jumpserver.example.com/api/v1/authentication/auth/', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'alan', password: 'secret' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/users/profile/', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer bearer-1',
        Accept: 'application/json',
        'X-JMS-ORG': 'org-1'
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/api/v1/perms/users/user-1/assets/?limit=200&offset=0', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer bearer-1',
        Accept: 'application/json',
        'X-JMS-ORG': 'org-1'
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://jumpserver.example.com/api/v1/perms/users/user-1/nodes/all-with-assets/tree/', expect.objectContaining({
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
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
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
      connectTimeout: 30
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
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
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
      connectTimeout: 30
    }, fetchMock);

    const nodes = await client.listAssetNodes();

    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://jumpserver.example.com/api/v1/perms/users/user-1/nodes/all-with-assets/tree/', expect.any(Object));

    expect(nodes.map((node) => node.path)).toEqual([
      ['DEFAULT'],
      ['DEFAULT', 'PROD'],
      ['DEFAULT', 'PROD', 'offline-prod'],
      ['DEFAULT', 'PROD', 'offline-prod', 'Middleware']
    ]);
    expect(nodes.at(-1)?.assetIds).toEqual(['asset-1']);
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
      connectTimeout: 30
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

  it('warms up KoKo web session with csrf and cookies', async () => {
    const fetchMock = vi.fn()
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
      connectTimeout: 30
    }, fetchMock);

    await client.warmupKokoConnectPage('token-1', 1000);

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/core/auth/login/?next=/koko/connect/', expect.objectContaining({
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
});
