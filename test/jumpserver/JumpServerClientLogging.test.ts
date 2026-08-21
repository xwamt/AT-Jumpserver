import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyRestFailure, JumpServerClient } from '../../src/jumpserver/JumpServerClient';
import { setLogSink, type LogSink } from '../../src/utils/logger';

const settings = {
  baseUrl: 'https://jumpserver.example.com',
  orgId: '',
  username: 'alan',
  password: 'secret',
  verifyTls: true
};

const lines: string[] = [];

const sink: LogSink = {
  trace: (message) => lines.push(`trace ${message}`),
  debug: (message) => lines.push(`debug ${message}`),
  info: (message) => lines.push(`info ${message}`),
  warn: (message) => lines.push(`warn ${message}`),
  error: (message) => lines.push(`error ${message}`)
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function hang(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

beforeEach(() => {
  lines.length = 0;
  setLogSink(sink);
});

afterEach(() => {
  setLogSink(undefined);
});

describe('classifyRestFailure', () => {
  it('names the failure class a JumpServer status belongs to', () => {
    expect(classifyRestFailure(401)).toBe('auth-rejected');
    expect(classifyRestFailure(403)).toBe('forbidden');
    expect(classifyRestFailure(404)).toBe('not-found');
    expect(classifyRestFailure(429)).toBe('throttled');
    expect(classifyRestFailure(502)).toBe('server-error');
    expect(classifyRestFailure(418)).toBe('client-error');
  });
});

describe('JumpServerClient logging', () => {
  it('says which timeout budget ran out, not just that something timed out', async () => {
    const client = new JumpServerClient(
      settings,
      (url) => (url.includes('/authentication/auth/') ? Promise.resolve(jsonResponse({ token: 'bearer-1' })) : hang()),
      { requestMs: 20, listingMs: 40 }
    );

    await expect(client.getUserProfile()).rejects.toThrow(/timed out/i);
    await expect(client.listAssetNodes()).rejects.toThrow(/timed out/i);

    expect(lines).toContain('warn REST request budget exhausted after 20ms: /api/v1/users/profile/');
    expect(lines).toContain(
      'warn REST listing budget exhausted after 40ms: /api/v1/perms/users/self/nodes/all-with-assets/tree/'
    );
  });

  it('logs the classification of a REST failure rather than a bare status', async () => {
    const client = new JumpServerClient(settings, (url) =>
      Promise.resolve(
        url.includes('/authentication/auth/')
          ? jsonResponse({ token: 'bearer-1' })
          : jsonResponse({ detail: 'nope' }, 503)
      )
    );

    await expect(client.getAssetDetail('asset-1')).rejects.toThrow(/HTTP 503/);

    expect(lines).toContain('warn REST server-error (HTTP 503): /api/v1/perms/users/self/assets/asset-1/');
  });

  it('reports how many pages an asset sync walked and how many assets it got', async () => {
    const client = new JumpServerClient(settings, async (url) => {
      if (url.includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
      return jsonResponse({
        count: 5,
        results: Array.from({ length: Math.max(0, Math.min(2, 5 - offset)) }, (_item, index) => ({
          id: `asset-${offset + index}`,
          name: `asset-${offset + index}`
        }))
      });
    });

    await client.listAllAssets({ pageSize: 2, treePaths: new Map() });

    expect(lines).toContain('info asset sync walked 3 page(s): 5 of 5 asset(s)');
  });

  it('logs REST bearer reuse after the first login', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/authentication/auth/')) {
        return jsonResponse({ token: 'bearer-1' });
      }
      return jsonResponse({ id: 'user-1' });
    });
    const client = new JumpServerClient(settings, fetchMock);

    await client.getUserProfile();
    await client.getUserProfile();

    expect(lines).toContain('info REST bearer login');
    expect(lines).toContain('info REST bearer reused');
  });

  it('never writes a connection token into the channel, even from a failing URL', async () => {
    const client = new JumpServerClient(settings, () => hang(), { requestMs: 10 });

    await expect(client.getSmartEndpoint('super-secret-token')).rejects.toThrow(/timed out/i);

    expect(lines.join('\n')).not.toContain('super-secret-token');
  });
});
