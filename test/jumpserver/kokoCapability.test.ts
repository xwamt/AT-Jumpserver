import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectKokoCapabilities,
  clearKokoCapabilityCache,
  type KokoCapabilities
} from '../../src/jumpserver/kokoCapability';
import { JumpServerClient } from '../../src/jumpserver/JumpServerClient';
import type { JumpServerSettingsWithPassword } from '../../src/jumpserver/types';

describe('B0: detectKokoCapabilities', () => {
  const settings: JumpServerSettingsWithPassword = {
    baseUrl: 'https://jumpserver.example.com',
    username: 'admin',
    password: 'secret-password',
    orgId: '',
    verifyTls: true
  };

  beforeEach(() => {
    clearKokoCapabilityCache();
  });

  afterEach(() => {
    clearKokoCapabilityCache();
  });

  it('Step 1.1: client/versions containing 5.0.0 returns { cookieLess: true } and caches it', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        callCount++;
        return new Response(JSON.stringify(['4.0.0', '4.1.0', '5.0.0']), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result1 = await detectKokoCapabilities(client, 'bastion-1');
    expect(result1).toEqual({ cookieLess: true });
    expect(callCount).toBe(1);

    // Second call uses cache
    const result2 = await detectKokoCapabilities(client, 'bastion-1');
    expect(result2).toEqual({ cookieLess: true });
    expect(callCount).toBe(1);
  });

  it('Step 1.2: client/versions returning 404 (e.g. v3.x) returns { cookieLess: false } and caches it', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        callCount++;
        return new Response('Not Found', { status: 404 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result1 = await detectKokoCapabilities(client, 'bastion-3x');
    expect(result1).toEqual({ cookieLess: false });
    expect(callCount).toBe(1);

    const result2 = await detectKokoCapabilities(client, 'bastion-3x');
    expect(result2).toEqual({ cookieLess: false });
    expect(callCount).toBe(1);
  });

  it('Step 1.3: client/versions returning 4.x list without 5.0.0 returns { cookieLess: false } and caches it', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        callCount++;
        return new Response(JSON.stringify(['4.0.0', '4.1.0', '4.1.2']), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result1 = await detectKokoCapabilities(client, 'bastion-4x');
    expect(result1).toEqual({ cookieLess: false });
    expect(callCount).toBe(1);

    const result2 = await detectKokoCapabilities(client, 'bastion-4x');
    expect(result2).toEqual({ cookieLess: false });
    expect(callCount).toBe(1);
  });

  it('Step 1.4: timeout / network error returns { cookieLess: false } and does NOT write cache', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        callCount++;
        throw new Error('Network timeout');
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result1 = await detectKokoCapabilities(client, 'bastion-timeout');
    expect(result1).toEqual({ cookieLess: false });
    expect(callCount).toBe(1);

    // Second call MUST retry and not use cache
    const result2 = await detectKokoCapabilities(client, 'bastion-timeout');
    expect(result2).toEqual({ cookieLess: false });
    expect(callCount).toBe(2);
  });

  it('Step 1.5: 500 server error returns { cookieLess: false } and does NOT write cache', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        callCount++;
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result1 = await detectKokoCapabilities(client, 'bastion-500');
    expect(result1).toEqual({ cookieLess: false });
    expect(callCount).toBe(1);

    // Second call MUST retry and not use cache
    const result2 = await detectKokoCapabilities(client, 'bastion-500');
    expect(result2).toEqual({ cookieLess: false });
    expect(callCount).toBe(2);
  });

  it('Step 1.6: unauthenticated client returns { cookieLess: false } and does NOT write cache', async () => {
    let authAttempts = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        authAttempts++;
        return new Response(JSON.stringify({ detail: 'Invalid credentials' }), { status: 401 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    const result1 = await detectKokoCapabilities(client, 'bastion-auth-fail');
    expect(result1).toEqual({ cookieLess: false });
    expect(authAttempts).toBeGreaterThanOrEqual(1);

    const prevAttempts = authAttempts;
    // Second call retries auth and does not return a cached negative result
    const result2 = await detectKokoCapabilities(client, 'bastion-auth-fail');
    expect(result2).toEqual({ cookieLess: false });
    expect(authAttempts).toBeGreaterThan(prevAttempts);
  });

  it('Step 2: clearKokoCapabilityCache invalidates cached entries', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/authentication/auth/')) {
        return new Response(JSON.stringify({ token: 'bearer-token' }), { status: 200 });
      }
      if (url.includes('/api/v1/settings/client/versions/')) {
        callCount++;
        return new Response(JSON.stringify(['5.0.0']), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new JumpServerClient(settings, fetchMock as any);
    await detectKokoCapabilities(client, 'bastion-clear');
    expect(callCount).toBe(1);

    clearKokoCapabilityCache('bastion-clear');
    await detectKokoCapabilities(client, 'bastion-clear');
    expect(callCount).toBe(2);
  });
});
