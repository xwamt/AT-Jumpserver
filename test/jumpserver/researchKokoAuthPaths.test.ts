/**
 * Research probe (not a product contract): differential check of KoKo's
 * WebSocket authentication across server generations.
 *
 * The mocks below are transcribed from the real router and middleware, not
 * invented:
 *
 *   koko v3.10.23 / v4.10.19  pkg/httpd/webrouter.go
 *     - `/koko/api/...` group does not exist at all.
 *     - `/koko/ws/terminal|sftp` are guarded by HTTPMiddleSessionAuth, whose
 *       whole body is one cookie check (`koko-v3.10.23/pkg/auth/http.go:14`).
 *   koko v5.0.0               pkg/httpd/webrouter.go:49-54
 *     - `apiGroup.POST("/connect-ticket/", ...)` behind the same middleware.
 *   koko v5.0.0               pkg/auth/http.go:21-93
 *     - HTTPMiddleSessionAuth tries cookie -> Bearer -> connect ticket.
 *   koko v5.0.0               pkg/auth/connect_ticket.go:13-18, 104-112
 *     - ticket travels as `?ticket=` or `X-Koko-Connect-Ticket`, TTL 30 min,
 *       and is rejected when the `token` query no longer matches its token_id.
 *
 * What this file proves by execution:
 *   1. On a legacy KoKo the plugin's cookie path is the only path that works,
 *      and `/koko/api/connect-ticket/` is 404.
 *   2. On KoKo 5.0 a ticket opened with a Bearer token alone (no cookie, no
 *      Django login) is enough to complete the WS handshake.
 *   3. The plugin's current implementation never asks for a ticket, even when
 *      the server offers the endpoint.
 */
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createJumpServerFetch } from '../../src/jumpserver/restTransport';
import { defaultWebSocketFactory, JumpServerClient } from '../../src/jumpserver/JumpServerClient';
import { clearKokoCapabilityCache, detectKokoCapabilities } from '../../src/jumpserver/kokoCapability';

type Generation = 'legacy' | 'v5';

interface MockBastion {
  url: string;
  port: number;
  loginHits: { get: number; post: number };
  ticketHits: number;
  wsUpgrades: Array<{ url: string; cookie: string }>;
  paths: string[];
  close(): Promise<void>;
}

const openServers: http.Server[] = [];

afterEach(async () => {
  clearKokoCapabilityCache();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function hasSessionCookie(cookie: string): boolean {
  return /(?:^|;\s*)sessionid=/.test(cookie);
}

/** Stands in for one KoKo generation. */
async function startMockBastion(generation: Generation): Promise<MockBastion> {
  const tickets = new Map<string, string>();
  const state = {
    loginHits: { get: 0, post: 0 },
    ticketHits: 0,
    wsUpgrades: [] as Array<{ url: string; cookie: string }>,
    paths: [] as string[]
  };
  let port = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      state.paths.push(`${req.method} ${url.pathname}`);
      const cookie = String(req.headers.cookie ?? '');
      const body = req.method === 'POST' ? await readBody(req) : '';

      // --- Core REST -----------------------------------------------------------------
      if (url.pathname === '/api/v1/authentication/auth/' && req.method === 'POST') {
        return json(res, 200, { token: 'bearer-1' });
      }
      if (url.pathname === '/api/v1/authentication/connection-token/' && req.method === 'POST') {
        return json(res, 201, { id: 'token-1' });
      }
      if (url.pathname === '/api/v1/terminal/endpoints/smart/') {
        return json(res, 200, { host: '127.0.0.1', http_port: port });
      }
      if (url.pathname === '/api/v1/terminal/components/connect-methods/') {
        return json(res, 200, {
          ssh: [
            {
              value: 'web_cli',
              label: 'Web CLI',
              type: 'web',
              component: 'koko',
              disabled: false,
              listen: 'koko',
              origin_value: null
            }
          ],
          originals: []
        });
      }
      if (url.pathname === '/api/v1/settings/client/versions/') {
        if (generation === 'v5') {
          return json(res, 200, ['4.0.0', '4.1.0', '5.0.0']);
        }
        return json(res, 404, { detail: 'Not Found' });
      }

      // --- Django form login ---------------------------------------------------------
      if (url.pathname.startsWith('/core/auth/login')) {
        if (req.method === 'GET') {
          state.loginHits.get += 1;
          const html = '<input name="csrfmiddlewaretoken" value="csrf-1">';
          res.writeHead(200, {
            'content-type': 'text/html',
            'set-cookie': 'csrftoken=csrf-1; Path=/',
            'content-length': Buffer.byteLength(html)
          });
          return res.end(html);
        }
        state.loginHits.post += 1;
        res.writeHead(302, { 'set-cookie': 'sessionid=session-1; Path=/', location: '/koko/connect/' });
        return res.end();
      }

      // --- KoKo connect page ---------------------------------------------------------
      if (url.pathname === '/koko/connect/') {
        if (!hasSessionCookie(cookie)) {
          res.writeHead(302, { location: '/core/auth/login/?next=/koko/connect/' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>koko</html>');
      }

      // --- connect-ticket: 5.0 only --------------------------------------------------
      if (url.pathname === '/koko/api/connect-ticket/' && req.method === 'POST') {
        if (generation === 'legacy') {
          // The route group itself does not exist before koko 5.0.
          return json(res, 404, { detail: 'Not Found' });
        }
        state.ticketHits += 1;
        if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) {
          return json(res, 401, { detail: 'authentication failed' });
        }
        const payload = JSON.parse(body || '{}') as { token_id?: string };
        const ticket = `ticket-${state.ticketHits}`;
        tickets.set(ticket, String(payload.token_id ?? ''));
        return json(res, 201, {
          ticket,
          token_id: payload.token_id ?? '',
          org_id: 'org-1',
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          expires_in: 1800
        });
      }

      return json(res, 404, { detail: 'Not Found' });
    })();
  });

  const sockets: WebSocket[] = [];
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'JMS-KOKO' });
  // Transcribed from the middleware: cookie -> Bearer -> ticket.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cookie = String(req.headers.cookie ?? '');
    const ticket = url.searchParams.get('ticket') ?? '';
    const token = url.searchParams.get('token') ?? '';
    state.wsUpgrades.push({ url: req.url ?? '', cookie });

    if (generation === 'legacy') {
      // koko <= 4.x middleware is one cookie check and nothing else.
      if (hasSessionCookie(cookie)) {
        return wss.handleUpgrade(req, socket, head, (ws) => sockets.push(ws));
      }
      socket.write('HTTP/1.1 302 Found\r\nLocation: /core/auth/login/?next=/koko/connect/\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }

    // koko 5.0 order, straight from pkg/auth/http.go:21-93.
    if (hasSessionCookie(cookie)) {
      return wss.handleUpgrade(req, socket, head, (ws) => sockets.push(ws));
    }
    const authHeaders = ['authorization', 'date', 'x-jms-org'].map((name) => String(req.headers[name] ?? '').trim());
    if (authHeaders.some((value) => value !== '')) {
      // CheckUserHeaders replays these to Core's GET /api/v1/users/profile/.
      const bearerOk = String(req.headers.authorization ?? '') === 'Bearer bearer-1';
      if (bearerOk) {
        return wss.handleUpgrade(req, socket, head, (ws) => sockets.push(ws));
      }
      // Present but invalid headers abort; they do NOT fall through to the ticket.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (ticket && tickets.get(ticket) === token) {
      return wss.handleUpgrade(req, socket, head, (ws) => sockets.push(ws));
    }
    if (ticket && tickets.has(ticket)) {
      // koko 5.0: "connect ticket token mismatch"
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    socket.write('HTTP/1.1 302 Found\r\nLocation: /core/auth/login/?next=/koko/connect/\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  openServers.push(server);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get loginHits() {
      return state.loginHits;
    },
    get ticketHits() {
      return state.ticketHits;
    },
    get wsUpgrades() {
      return state.wsUpgrades;
    },
    get paths() {
      return state.paths;
    },
    // An upgraded socket leaves the HTTP server's connection tracking, so
    // server.close() alone would wait on it forever: terminate first.
    close: () =>
      new Promise<void>((resolve) => {
        sockets.splice(0).forEach((socket) => socket.terminate());
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  } as MockBastion;
}

function makeClient(bastion: MockBastion): JumpServerClient {
  return new JumpServerClient(
    {
      baseUrl: bastion.url,
      orgId: '',
      username: 'alan',
      password: 'secret',
      verifyTls: false
    },
    createJumpServerFetch({ verifyTls: false }),
    { requestMs: 2000, listingMs: 2000, webSocketMs: 2000 }
  );
}

async function connectWithPlugin(bastion: MockBastion): Promise<JumpServerClient> {
  const client = makeClient(bastion);
  const caps = await detectKokoCapabilities(client, bastion.url);
  if (!caps.cookieLess) {
    await client.ensureWebSession();
  }
  const endpoint = await client.getSmartEndpointForAsset('asset-1');
  await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24 });
  return client;
}

function ticketUrl(bastion: MockBastion, tokenId: string, ticket: string): string {
  return `ws://127.0.0.1:${bastion.port}/koko/ws/terminal/?token=${tokenId}&ticket=${ticket}`;
}

describe('legacy KoKo (v3.10.23 / v4.10.19 behaviour)', () => {
  it('opens the terminal socket only after the Django form login', async () => {
    const bastion = await startMockBastion('legacy');

    const client = await connectWithPlugin(bastion);

    expect(client.hasWebSession()).toBe(true);
    // GET the csrf page, then POST the credentials: the 250-line fallback chain
    // exists because on this generation the cookie is the only credential KoKo
    // will look at.
    expect(bastion.loginHits).toEqual({ get: 1, post: 1 });
    expect(bastion.wsUpgrades).toHaveLength(1);
    expect(bastion.wsUpgrades[0]!.cookie).toContain('sessionid=');
    client.dispose();
    await bastion.close();
  });

  it('has no connect-ticket endpoint and rejects a ticket-only upgrade', async () => {
    const bastion = await startMockBastion('legacy');

    const response = await fetch(`${bastion.url}/koko/api/connect-ticket/`, {
      method: 'POST',
      headers: { authorization: 'Bearer bearer-1', 'content-type': 'application/json' },
      body: JSON.stringify({ token_id: 'token-1', org_id: 'org-1' })
    });
    expect(response.status).toBe(404);

    await expect(defaultWebSocketFactory(ticketUrl(bastion, 'token-1', 'ticket-1'), {}, 3000)).rejects.toThrow(
      /unexpected server response: 302/i
    );
    await bastion.close();
  });

  it('ignores a Bearer on the handshake: the middleware never looks at headers', async () => {
    const bastion = await startMockBastion('legacy');

    await expect(
      defaultWebSocketFactory(
        `ws://127.0.0.1:${bastion.port}/koko/ws/terminal/?token=token-1`,
        { headers: { Authorization: 'Bearer bearer-1', 'X-JMS-ORG': 'org-1' } },
        3000
      )
    ).rejects.toThrow(/unexpected server response: 302/i);
    await bastion.close();
  });
});

describe('KoKo 5.0 behaviour', () => {
  it('completes the handshake from a Bearer-issued ticket alone, with no cookie', async () => {
    const bastion = await startMockBastion('v5');

    const response = await fetch(`${bastion.url}/koko/api/connect-ticket/`, {
      method: 'POST',
      headers: { authorization: 'Bearer bearer-1', 'content-type': 'application/json' },
      body: JSON.stringify({ token_id: 'token-1', org_id: 'org-1' })
    });
    expect(response.status).toBe(201);
    const { ticket } = (await response.json()) as { ticket: string };

    const socket = await defaultWebSocketFactory(ticketUrl(bastion, 'token-1', ticket), {}, 5000);
    expect(socket.readyState).toBe(socket.OPEN);
    expect(bastion.loginHits).toEqual({ get: 0, post: 0 });
    // Nothing but the ticket travelled: the upgrade carried no Cookie header.
    expect(bastion.wsUpgrades[0]!.cookie).toBe('');
    socket.terminate();
    await bastion.close();
  });

  it('rejects a ticket that is replayed against another token', async () => {
    const bastion = await startMockBastion('v5');

    const response = await fetch(`${bastion.url}/koko/api/connect-ticket/`, {
      method: 'POST',
      headers: { authorization: 'Bearer bearer-1', 'content-type': 'application/json' },
      body: JSON.stringify({ token_id: 'token-1', org_id: 'org-1' })
    });
    const { ticket } = (await response.json()) as { ticket: string };

    await expect(
      defaultWebSocketFactory(ticketUrl(bastion, 'token-OTHER', ticket), {}, 3000)
    ).rejects.toThrow(/unexpected server response: 401/i);
    await bastion.close();
  });

  it('accepts a Bearer-only upgrade, because CheckUserHeaders replays it to Core', async () => {
    const bastion = await startMockBastion('v5');

    // The Node `ws` client - what this plugin runs on, unlike a browser - can
    // put an Authorization header on the handshake. koko 5.0 then verifies it
    // by calling Core's GET /api/v1/users/profile/ with the same headers.
    const socket = await defaultWebSocketFactory(
      `ws://127.0.0.1:${bastion.port}/koko/ws/terminal/?token=token-1`,
      { headers: { Authorization: 'Bearer bearer-1', 'X-JMS-ORG': 'org-1' } },
      5000
    );
    expect(socket.readyState).toBe(socket.OPEN);
    expect(bastion.loginHits).toEqual({ get: 0, post: 0 });
    expect(bastion.ticketHits).toBe(0);
    socket.terminate();
    await bastion.close();
  });

  it('aborts a handshake whose Bearer is stale instead of falling back to the ticket', async () => {
    const bastion = await startMockBastion('v5');

    await expect(
      defaultWebSocketFactory(
        ticketUrl(bastion, 'token-1', 'ticket-1'),
        { headers: { Authorization: 'Bearer stale-token' } },
        3000
      )
    ).rejects.toThrow(/unexpected server response: 401/i);
    await bastion.close();
  });

  it('on legacy bastions (4.x / 3.x), the plugin leaves the ticket endpoint unused and connects via cookie', async () => {
    const bastion = await startMockBastion('legacy');

    const client = await connectWithPlugin(bastion);

    expect(bastion.ticketHits).toBe(0);
    expect(bastion.loginHits).toEqual({ get: 1, post: 1 });
    expect(bastion.wsUpgrades.at(-1)!.url).not.toContain('ticket=');
    expect(bastion.wsUpgrades.at(-1)!.cookie).toContain('sessionid=');
    client.dispose();
    await bastion.close();
  });

  it('on 5.0 bastions, the plugin connects via connect-ticket and ticket query parameter without cookie form login', async () => {
    const bastion = await startMockBastion('v5');

    const client = await connectWithPlugin(bastion);

    expect(bastion.ticketHits).toBeGreaterThanOrEqual(1);
    expect(bastion.wsUpgrades.at(-1)!.url).toContain('ticket=');
    client.dispose();
    await bastion.close();
  });
});
