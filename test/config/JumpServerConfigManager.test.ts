import { describe, expect, it } from 'vitest';
import { JumpServerConfigManager, type ExtensionMemento, type SecretStore } from '../../src/config/JumpServerConfigManager';
import type { CachedJumpServerAsset, JumpServerSettings } from '../../src/config/schema';

class MemoryMemento implements ExtensionMemento {
  data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

class MemorySecretStore implements SecretStore {
  data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function settings(overrides: Partial<JumpServerSettings> = {}): JumpServerSettings {
  return {
    baseUrl: 'https://jumpserver.example.com',
    orgId: '',
    username: 'alan',
    verifyTls: true,
    connectTimeout: 30,
    updatedAt: 1,
    ...overrides
  };
}

function asset(overrides: Partial<CachedJumpServerAsset> = {}): CachedJumpServerAsset {
  return {
    id: 'asset-1',
    name: 'web-1',
    address: '10.0.0.10',
    platform: 'Linux',
    category: 'host',
    type: 'server',
    zoneName: 'prod-zone',
    nodePath: ['Production', 'Web'],
    protocolNames: ['ssh'],
    raw: {},
    ...overrides
  };
}

describe('JumpServerConfigManager', () => {
  it('stores settings in global state and password in SecretStorage', async () => {
    const globalState = new MemoryMemento();
    const secrets = new MemorySecretStore();
    const manager = new JumpServerConfigManager(globalState, secrets);

    await manager.saveSettings(settings(), 'super-secret');

    expect(await manager.getSettings()).toEqual(settings());
    expect(await manager.getPassword()).toBe('super-secret');
    expect(JSON.stringify(globalState.data.get('jumpserverManager.settings'))).not.toContain('super-secret');
  });

  it('deletes settings and password together', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveSettings(settings(), 'super-secret');
    await manager.deleteSettings();

    expect(await manager.getSettings()).toBeUndefined();
    expect(await manager.getPassword()).toBeUndefined();
  });

  it('stores and returns sanitized cached assets', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveCachedAssets([asset({ raw: { id: 'asset-1', token: 'secret-token' } })]);

    expect(await manager.listCachedAssets()).toEqual([asset({ raw: { id: 'asset-1' } })]);
  });
});
