import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildKokoSftpWsUrl,
  buildKokoWsUrl,
  JumpServerClient,
  type JumpServerEndpoint
} from '../../src/jumpserver/JumpServerClient';
import { clearKokoCapabilityCache } from '../../src/jumpserver/kokoCapability';

describe('B1 & B2: KoKo 5.0 connect-ticket & WS Bearer handshake', () => {
  const settings = {
    baseUrl: 'https://jumpserver.example.com',
    orgId: 'org-1',
    username: 'alan',
    password: 'secret',
    verifyTls: true
  };

  const endpoint: JumpServerEndpoint = {
    host: 'koko.example.com',
    https_port: 8443
  };

  beforeEach(() => {
    clearKokoCapabilityCache();
  });

  afterEach(() => {
    clearKokoCapabilityCache();
  });

  it('Step 1.1: buildKokoWsUrl and buildKokoSftpWsUrl support optional ticket query', () => {
    const urlWithout = buildKokoWsUrl(settings.baseUrl, endpoint, 'token-1', 1000);
    expect(urlWithout).toBe('wss://koko.example.com:8443/koko/ws/terminal/?disableautohash=false&token=token-1&_=1000');
    expect(urlWithout).not.toContain('ticket=');

    const urlWith = buildKokoWsUrl(settings.baseUrl, endpoint, 'token-1', 1000, 'ticket-uuid-1');
    expect(urlWith).toBe('wss://koko.example.com:8443/koko/ws/terminal/?disableautohash=false&token=token-1&_=1000&ticket=ticket-uuid-1');

    const sftpWithout = buildKokoSftpWsUrl(settings.baseUrl, endpoint, 'token-1', 1000);
    expect(sftpWithout).toBe('wss://koko.example.com:8443/koko/ws/sftp/?token=token-1&_=1000');
    expect(sftpWithout).not.toContain('ticket=');

    const sftpWith = buildKokoSftpWsUrl(settings.baseUrl, endpoint, 'token-1', 1000, 'ticket-uuid-2');
    expect(sftpWith).toBe('wss://koko.example.com:8443/koko/ws/sftp/?token=token-1&_=1000&ticket=ticket-uuid-2');
  });

  it('Step 1.2: createKokoConnectTicket sends POST with Bearer, Referer, X-TZ, X-JMS-ORG and body', async () => {
    let capturedRequest: { url: string; headers: Record<string, string>; body: any } | undefined;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token-123' }), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        capturedRequest = {
          url,
          headers: (init?.headers as Record<string, string>) || {},
          body: JSON.parse(String(init?.body || '{}'))
        };
        return new Response(
          JSON.stringify({
            ticket: 'ticket-uuid-123',
            token_id: 'token-1',
            org_id: 'org-1',
            expires_in: 1800
          }),
          { status: 201 }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result = await client.createKokoConnectTicket({ endpoint, tokenId: 'token-1' });

    expect(result.ticket).toBe('ticket-uuid-123');
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toBe('https://koko.example.com:8443/koko/api/connect-ticket/');
    expect(capturedRequest!.headers.Authorization).toBe('Bearer bearer-token-123');
    expect(capturedRequest!.headers['X-JMS-ORG']).toBe('org-1');
    expect(capturedRequest!.headers['X-TZ']).toBeDefined();
    expect(capturedRequest!.headers.Referer).toContain('koko.example.com');
    expect(capturedRequest!.body).toEqual({
      token_id: 'token-1',
      org_id: 'org-1'
    });
  });

  it('Step 1.3: on 5.0, openKokoWebSocket uses ticket and skips Django form login (ensureWebSession 0 calls, warmup=0)', async () => {
    let loginFormCalls = 0;
    let ticketCalls = 0;
    let upgradedUrl = '';
    let upgradedHeaders: any = {};

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token-1' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        ticketCalls++;
        return new Response(JSON.stringify({ ticket: 'ticket-uuid-abc', token_id: 'token-1' }), { status: 201 });
      }
      if (url.includes('/core/auth/login') || url.includes('/koko/connect/')) {
        loginFormCalls++;
        return new Response('<html>login</html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async (url: string, opts: any) => {
      upgradedUrl = url;
      upgradedHeaders = opts.headers;
      return fakeSocket as any;
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    await client.openKokoWebSocket({
      endpoint,
      tokenId: 'token-1',
      cols: 80,
      rows: 24,
      webSocketFactory: wsFactory
    });

    expect(ticketCalls).toBe(1);
    expect(loginFormCalls).toBe(0); // 0 form logins on 5.0
    expect(upgradedUrl).toContain('&ticket=ticket-uuid-abc');
    expect(client.lastKokoWarmupMs()).toBe(0);
  });

  it('Step 2: on 5.0, if ticket endpoint fails (e.g. 404), falls back gracefully to cookie authentication', async () => {
    let loginPostCalled = false;
    let upgradedUrl = '';
    let upgradedCookie = '';

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token-1' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('/core/auth/login')) {
        if (init?.method === 'POST') {
          loginPostCalled = true;
          return new Response('', {
            status: 302,
            headers: {
              'set-cookie': 'sessionid=cookie-sess-1; Path=/',
              location: '/koko/connect/'
            }
          });
        }
        return new Response('<input name="csrfmiddlewaretoken" value="csrf-123">', { status: 200 });
      }
      if (url.includes('/koko/connect/')) {
        const cookie = String((init?.headers as Record<string, string>)?.Cookie || '');
        if (!cookie.includes('sessionid=')) {
          return new Response('', {
            status: 302,
            headers: { location: '/core/auth/login/?next=/koko/connect/' }
          });
        }
        return new Response('<html>koko</html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async (url: string, opts: any) => {
      upgradedUrl = url;
      upgradedCookie = opts.headers?.Cookie || '';
      return fakeSocket as any;
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    await client.openKokoWebSocket({
      endpoint,
      tokenId: 'token-1',
      cols: 80,
      rows: 24,
      webSocketFactory: wsFactory
    });

    expect(loginPostCalled).toBe(true);
    expect(upgradedUrl).not.toContain('ticket=');
    expect(upgradedCookie).toContain('sessionid=cookie-sess-1');
  });

  it('Step 3: caches ticket by (tokenId, kind) for 25 min and clears on setOrgId', async () => {
    let ticketCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-1' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        ticketCalls++;
        return new Response(JSON.stringify({ ticket: `ticket-${ticketCalls}`, token_id: 'token-1' }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async () => fakeSocket as any);

    const client = new JumpServerClient(settings, fetchMock as any);

    // Call 1: fetches ticket-1
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });
    expect(ticketCalls).toBe(1);

    // Call 2 within window: reuses ticket-1 (0 new calls)
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });
    expect(ticketCalls).toBe(1);

    // Change org -> ticket cache cleared (§B.4.4)
    client.setOrgId('org-2');
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });
    expect(ticketCalls).toBe(2);
  });

  it('Step 4: terminal and sftp fetch separate tickets even if token is identical (§B.4.5)', async () => {
    let ticketCalls = 0;
    const ticketsIssued: string[] = [];

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-1' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        ticketCalls++;
        const ticket = `ticket-${ticketCalls}`;
        ticketsIssued.push(ticket);
        return new Response(JSON.stringify({ ticket, token_id: 'token-shared' }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async () => fakeSocket as any);

    const client = new JumpServerClient(settings, fetchMock as any);

    // Terminal connects
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-shared', cols: 80, rows: 24, webSocketFactory: wsFactory });
    expect(ticketCalls).toBe(1);

    // SFTP connects with shared token -> must fetch separate ticket for (token-shared, 'sftp')
    await client.openKokoSftpWebSocket({ endpoint, tokenId: 'token-shared', webSocketFactory: wsFactory });
    expect(ticketCalls).toBe(2);
    expect(ticketsIssued[0]).not.toBe(ticketsIssued[1]);
  });

  it('Step 5: refreshes ticket on WS 401 handshake failure and retries once', async () => {
    let ticketCalls = 0;
    let wsAttempts = 0;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-1' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        ticketCalls++;
        return new Response(JSON.stringify({ ticket: `ticket-${ticketCalls}`, token_id: 'token-1' }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async (url: string) => {
      wsAttempts++;
      if (wsAttempts === 1) {
        // First handshake fails with 401 (e.g. ticket expired on server)
        throw new Error('Unexpected server response: 401 Unauthorized');
      }
      return fakeSocket as any;
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });

    expect(wsAttempts).toBe(2);
    expect(ticketCalls).toBe(2); // Second ticket was fetched after 401
  });

  it('B2 Step 1: 5.0 with kokoBearerHandshake enabled sends Authorization: Bearer on WS and skips ticket', async () => {
    let ticketCalls = 0;
    let wsHeaders: any = {};

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token-live' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        ticketCalls++;
        return new Response(JSON.stringify({ ticket: 'ticket-1', token_id: 'token-1' }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async (_url: string, opts: any) => {
      wsHeaders = opts.headers;
      return fakeSocket as any;
    });

    const client = new JumpServerClient(settings, fetchMock as any, { kokoBearerHandshake: true });
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });

    expect(wsHeaders.Authorization).toBe('Bearer bearer-token-live');
    expect(ticketCalls).toBe(0); // Ticket skipped when Bearer handshake succeeds
  });

  it('B2 Step 2: stale Bearer receiving 401 strips Authorization header and retries once with ticket', async () => {
    let wsAttempts = 0;
    const wsHeadersHistory: any[] = [];
    let ticketCalls = 0;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'stale-bearer' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      if (url.includes('/koko/api/connect-ticket/')) {
        ticketCalls++;
        return new Response(JSON.stringify({ ticket: 'fallback-ticket', token_id: 'token-1' }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async (_url: string, opts: any) => {
      wsAttempts++;
      wsHeadersHistory.push(opts.headers);
      if (wsAttempts === 1) {
        // Bearer rejected with 401
        throw new Error('Unexpected server response: 401 Unauthorized');
      }
      return fakeSocket as any;
    });

    const client = new JumpServerClient(settings, fetchMock as any, { kokoBearerHandshake: true });
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });

    expect(wsAttempts).toBe(2);
    expect(wsHeadersHistory[0].Authorization).toBe('Bearer stale-bearer');
    expect(wsHeadersHistory[1].Authorization).toBeUndefined(); // Header stripped
    expect(ticketCalls).toBe(1); // Fell back to ticket
  });

  it('B2 Step 3: on 4.x, Bearer is never attached even if kokoBearerHandshake is true', async () => {
    let wsHeaders: any = {};

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token-1' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        return new Response(JSON.stringify(['4.1.0']), { status: 200 });
      }
      if (url.includes('/core/auth/login')) {
        if (init?.method === 'POST') {
          return new Response('', {
            status: 302,
            headers: {
              'set-cookie': 'sessionid=cookie-sess-4x; Path=/',
              location: '/koko/connect/'
            }
          });
        }
        return new Response('<input name="csrfmiddlewaretoken" value="csrf-123">', { status: 200 });
      }
      if (url.includes('/koko/connect/')) {
        const cookie = String((init?.headers as Record<string, string>)?.Cookie || '');
        if (!cookie.includes('sessionid=')) {
          return new Response('', {
            status: 302,
            headers: { location: '/core/auth/login/?next=/koko/connect/' }
          });
        }
        return new Response('<html>koko</html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const fakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const wsFactory = vi.fn(async (_url: string, opts: any) => {
      wsHeaders = opts.headers;
      return fakeSocket as any;
    });

    const client = new JumpServerClient(settings, fetchMock as any, { kokoBearerHandshake: true });
    await client.openKokoWebSocket({ endpoint, tokenId: 'token-1', cols: 80, rows: 24, webSocketFactory: wsFactory });

    expect(wsHeaders.Authorization).toBeUndefined();
    expect(wsHeaders.Cookie).toContain('sessionid=cookie-sess-4x');
  });
});
