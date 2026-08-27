import { afterEach, describe, expect, it, vi } from 'vitest';
import { JumpServerClientPool } from '../../src/jumpserver/JumpServerClientPool';
import type { JumpServerClient } from '../../src/jumpserver/JumpServerClient';
import type { JumpServerSettingsWithPassword } from '../../src/jumpserver/types';
import { setLogSink } from '../../src/utils/logger';

function settings(overrides: Partial<JumpServerSettingsWithPassword> = {}): JumpServerSettingsWithPassword {
  return {
    baseUrl: 'https://jumpserver.example.com',
    orgId: 'org-1',
    username: 'alan',
    password: 'secret',
    verifyTls: true,
    ...overrides
  };
}

function poolWithStubs() {
  const constructed: Array<{ setOrgId: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  const pool = new JumpServerClientPool((next) => {
    const stub = { settings: next, setOrgId: vi.fn(), dispose: vi.fn() };
    constructed.push(stub);
    return stub as unknown as JumpServerClient;
  });
  return { pool, constructed };
}

afterEach(() => {
  setLogSink(undefined);
});

describe('JumpServerClientPool', () => {
  it('returns the same client for the same bastion identity', () => {
    const { pool, constructed } = poolWithStubs();

    const first = pool.acquire('bastion-1', settings());
    const second = pool.acquire('bastion-1', settings());

    expect(second).toBe(first);
    expect(constructed).toHaveLength(1);
  });

  it('keeps separate clients for different bastions', () => {
    const { pool, constructed } = poolWithStubs();

    const prod = pool.acquire('prod', settings({ baseUrl: 'https://prod.example.com' }));
    const test = pool.acquire('test', settings({ baseUrl: 'https://test.example.com' }));

    expect(test).not.toBe(prod);
    expect(constructed).toHaveLength(2);
  });

  it('rebuilds the client when the password changes', () => {
    const { pool, constructed } = poolWithStubs();

    const first = pool.acquire('bastion-1', settings({ password: 'old' }));
    const second = pool.acquire('bastion-1', settings({ password: 'new' }));

    expect(second).not.toBe(first);
    expect(constructed).toHaveLength(2);
  });

  it('reuses the client when only the org changes and updates orgId', () => {
    const { pool, constructed } = poolWithStubs();

    const first = pool.acquire('bastion-1', settings({ orgId: 'org-1' }));
    const second = pool.acquire('bastion-1', settings({ orgId: 'org-2' }));

    expect(second).toBe(first);
    expect(constructed).toHaveLength(1);
    expect(constructed[0].setOrgId).toHaveBeenCalledWith('org-2');
  });

  it('drops a cached client so the next acquire is fresh', () => {
    const { pool, constructed } = poolWithStubs();

    const first = pool.acquire('bastion-1', settings());
    pool.drop('bastion-1');
    const second = pool.acquire('bastion-1', settings());

    expect(second).not.toBe(first);
    expect(constructed).toHaveLength(2);
    expect(constructed[0].dispose).toHaveBeenCalledTimes(1);
    expect(constructed[1].dispose).not.toHaveBeenCalled();
  });

  it('dropAll forgets every cached client', () => {
    const { pool, constructed } = poolWithStubs();

    pool.acquire('prod', settings({ baseUrl: 'https://prod.example.com' }));
    pool.acquire('test', settings({ baseUrl: 'https://test.example.com' }));
    pool.dropAll();
    pool.acquire('prod', settings({ baseUrl: 'https://prod.example.com' }));
    pool.acquire('test', settings({ baseUrl: 'https://test.example.com' }));

    expect(constructed).toHaveLength(4);
    expect(constructed[0].dispose).toHaveBeenCalledTimes(1);
    expect(constructed[1].dispose).toHaveBeenCalledTimes(1);
    expect(constructed[2].dispose).not.toHaveBeenCalled();
    expect(constructed[3].dispose).not.toHaveBeenCalled();
  });

  it('disposes the replaced client when the identity changes', () => {
    const { pool, constructed } = poolWithStubs();

    pool.acquire('bastion-1', settings({ password: 'old' }));
    pool.acquire('bastion-1', settings({ password: 'new' }));

    expect(constructed).toHaveLength(2);
    expect(constructed[0].dispose).toHaveBeenCalledTimes(1);
    expect(constructed[1].dispose).not.toHaveBeenCalled();
  });

  it('tolerates a client without dispose when dropping it', () => {
    const pool = new JumpServerClientPool(() => ({ setOrgId: () => undefined } as unknown as JumpServerClient));

    pool.acquire('bastion-1', settings());

    expect(() => pool.drop('bastion-1')).not.toThrow();
  });

  it('peek returns the live client without ever building one', () => {
    const { pool, constructed } = poolWithStubs();

    expect(pool.peek('bastion-1')).toBeUndefined();
    const client = pool.acquire('bastion-1', settings());

    expect(pool.peek('bastion-1')).toBe(client);
    expect(pool.peek('bastion-2')).toBeUndefined();
    expect(constructed).toHaveLength(1);
  });

  it('passes the web-session store through to the factory for new clients', () => {
    const factory = vi.fn(() => ({ setOrgId: vi.fn() } as unknown as JumpServerClient));
    const pool = new JumpServerClientPool(factory);
    const store = { load: async () => undefined, save: async () => undefined, clear: async () => undefined };

    pool.acquire('bastion-1', settings(), { webSessionStore: store });

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://jumpserver.example.com' }), {
      webSessionStore: store
    });
  });

  it('hands a late web-session store to an already-cached client', () => {
    const attachWebSessionStore = vi.fn();
    const pool = new JumpServerClientPool(() =>
      ({ setOrgId: vi.fn(), attachWebSessionStore, dispose: vi.fn() } as unknown as JumpServerClient)
    );
    const store = { load: async () => undefined, save: async () => undefined, clear: async () => undefined };

    // First acquired by a path with no SecretStorage in reach, then by one
    // that has it: the cached client must still end up with the store.
    pool.acquire('bastion-1', settings());
    pool.acquire('bastion-1', settings(), { webSessionStore: store });

    expect(attachWebSessionStore).toHaveBeenCalledWith(store);
  });

  it('tolerates cached test doubles without attachWebSessionStore', () => {
    const { pool } = poolWithStubs();
    const store = { load: async () => undefined, save: async () => undefined, clear: async () => undefined };

    pool.acquire('bastion-1', settings());

    expect(() => pool.acquire('bastion-1', settings(), { webSessionStore: store })).not.toThrow();
  });

  it('logs whether acquire reused a client', () => {
    const lines: string[] = [];
    setLogSink({
      trace: (m) => lines.push(m),
      debug: (m) => lines.push(m),
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m)
    });
    const { pool } = poolWithStubs();
    pool.acquire('bastion-1', settings());
    pool.acquire('bastion-1', settings());
    expect(lines).toContain('JumpServer client created for bastion bastion-1');
    expect(lines).toContain('JumpServer client reused for bastion bastion-1');
  });
});
