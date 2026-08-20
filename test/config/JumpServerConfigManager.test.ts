import { describe, expect, it } from 'vitest';
import { JumpServerConfigManager, type ExtensionMemento, type SecretStore } from '../../src/config/JumpServerConfigManager';
import type { CachedJumpServerAsset, CachedJumpServerNode, JumpServerBastion, JumpServerSettings } from '../../src/config/schema';

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
    updatedAt: 1,
    ...overrides
  };
}

function bastion(overrides: Partial<JumpServerBastion> = {}): JumpServerBastion {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Prod',
    baseUrl: 'https://prod.example.com',
    orgId: '',
    username: 'alan',
    verifyTls: true,
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
    ...overrides,
    bastionId: overrides.bastionId ?? 'b1'
  };
}

function node(overrides: Partial<CachedJumpServerNode> = {}): CachedJumpServerNode {
  return {
    id: 'node-web',
    name: 'Web',
    path: ['Production', 'Web'],
    assetIds: ['asset-1'],
    raw: {},
    ...overrides,
    bastionId: overrides.bastionId ?? 'b1'
  };
}

function legacyAsset() {
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
    raw: {}
  };
}

describe('JumpServerConfigManager', () => {
  it('stores a bastion in global state and password in SecretStorage', async () => {
    const globalState = new MemoryMemento();
    const secrets = new MemorySecretStore();
    const manager = new JumpServerConfigManager(globalState, secrets);
    const saved = bastion();

    await manager.saveBastion(saved, 'super-secret');

    expect(await manager.listBastions()).toEqual([expect.objectContaining(saved)]);
    expect(await manager.requirePassword(saved.id)).toBe('super-secret');
    expect(JSON.stringify(globalState.data.get('jumpserverManager.bastions'))).not.toContain('super-secret');
  });

  it('deletes one bastion and its password', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
    const saved = bastion();

    await manager.saveBastion(saved, 'super-secret');
    await manager.deleteBastion(saved.id);

    expect(await manager.listBastions()).toEqual([]);
    await expect(manager.requirePassword(saved.id)).rejects.toThrow('JumpServer password is not configured.');
  });

  it('stores and returns sanitized cached assets', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveCachedAssets('b1', [asset({ raw: { id: 'asset-1', token: 'secret-token' } })]);

    expect(await manager.listCachedAssets()).toEqual([asset({ raw: { id: 'asset-1' } })]);
  });

  it('stores and returns sanitized cached JumpServer nodes', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveCachedAssetNodes('b1', [node({ raw: { id: 'node-web', cookie: 'secret-cookie' } })]);

    expect(await manager.listCachedAssetNodes()).toEqual([node({ raw: { id: 'node-web' } })]);
  });

  it('legacy saveSettings creates the first bastion', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore(), {
      idFactory: () => 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    });
    await manager.saveSettings(settings(), 'super-secret');
    expect(await manager.listBastions()).toHaveLength(1);
    expect(await manager.requirePassword('cccccccc-cccc-cccc-cccc-cccccccccccc')).toBe('super-secret');
  });

  it('migrates singleton settings into one bastion and moves the password', async () => {
    const globalState = new MemoryMemento();
    const secrets = new MemorySecretStore();
    await globalState.update('jumpserverManager.settings', settings());
    await secrets.store('jumpserverManager.password', 'super-secret');
    await globalState.update('jumpserverManager.cachedAssets', [legacyAsset()]);
    const manager = new JumpServerConfigManager(globalState, secrets, {
      idFactory: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });

    const bastions = await manager.listBastions();
    expect(bastions).toHaveLength(1);
    expect(bastions[0]).toMatchObject({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      username: 'alan',
      baseUrl: 'https://jumpserver.example.com'
    });
    expect(await manager.requirePassword('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe('super-secret');
    expect(await secrets.get('jumpserverManager.password')).toBeUndefined();
    expect(globalState.data.has('jumpserverManager.settings')).toBe(false);
    expect(await manager.listCachedAssets('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toEqual([
      expect.objectContaining({ id: 'asset-1', bastionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
    ]);
  });

  it('re-stamps a helper default bastionId during migration', async () => {
    const globalState = new MemoryMemento();
    const secrets = new MemorySecretStore();
    await globalState.update('jumpserverManager.settings', settings());
    await secrets.store('jumpserverManager.password', 'super-secret');
    await globalState.update('jumpserverManager.cachedAssets', [asset({ id: 'asset-1' })]);
    await globalState.update('jumpserverManager.cachedAssetNodes', [node({ id: 'node-web' })]);
    const manager = new JumpServerConfigManager(globalState, secrets, {
      idFactory: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });

    expect(await manager.listCachedAssets('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toEqual([
      expect.objectContaining({ id: 'asset-1', bastionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
    ]);
    expect(await manager.listCachedAssetNodes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toEqual([
      expect.objectContaining({ id: 'node-web', bastionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
    ]);
  });

  it('saves and deletes one bastion without touching another', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore(), {
      idFactory: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    });
    await manager.saveBastion({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Prod',
      baseUrl: 'https://prod.example.com',
      orgId: '',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    }, 'prod-secret');
    await manager.saveBastion({
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Test',
      baseUrl: 'https://test.example.com',
      orgId: '',
      username: 'bob',
      verifyTls: true,
      updatedAt: 1
    }, 'test-secret');
    await manager.saveCachedAssets('11111111-1111-1111-1111-111111111111', [
      asset({ id: 'a', bastionId: '11111111-1111-1111-1111-111111111111' })
    ]);

    await manager.deleteBastion('11111111-1111-1111-1111-111111111111');

    expect(await manager.listBastions()).toEqual([
      expect.objectContaining({ id: '22222222-2222-2222-2222-222222222222' })
    ]);
    expect(await manager.listCachedAssets()).toEqual([]);
    await expect(manager.requirePassword('22222222-2222-2222-2222-222222222222')).resolves.toBe('test-secret');
  });

  it('lists all cached assets or filters by bastion id', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
    await manager.saveCachedAssets('b1', [asset({ id: 'a', bastionId: 'b1' })]);
    await manager.saveCachedAssets('b2', [asset({ id: 'b', bastionId: 'b2' })]);

    expect(await manager.listCachedAssets()).toEqual([
      expect.objectContaining({ id: 'a', bastionId: 'b1' }),
      expect.objectContaining({ id: 'b', bastionId: 'b2' })
    ]);
    expect(await manager.listCachedAssets('b1')).toEqual([
      expect.objectContaining({ id: 'a', bastionId: 'b1' })
    ]);
  });

  it('replaces only the given bastion cached assets', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
    await manager.saveCachedAssets('b1', [asset({ id: 'a' })]);
    await manager.saveCachedAssets('b2', [asset({ id: 'b', bastionId: 'b2' })]);
    await manager.saveCachedAssets('b1', [asset({ id: 'c' })]);

    expect(await manager.listCachedAssets()).toEqual([
      expect.objectContaining({ id: 'b', bastionId: 'b2' }),
      expect.objectContaining({ id: 'c', bastionId: 'b1' })
    ]);
  });

  it('stamps bastionId on cached assets before parse', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveCachedAssets('b1', [asset({ bastionId: '' })]);
    await manager.saveCachedAssetNodes('b1', [node({ bastionId: '' })]);

    expect(await manager.listCachedAssets('b1')).toEqual([
      expect.objectContaining({ id: 'asset-1', bastionId: 'b1' })
    ]);
    expect(await manager.listCachedAssetNodes('b1')).toEqual([
      expect.objectContaining({ id: 'node-web', bastionId: 'b1' })
    ]);
  });

  it('lists all cached nodes or filters by bastion id', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
    await manager.saveCachedAssetNodes('b1', [node({ id: 'n1', bastionId: 'b1' })]);
    await manager.saveCachedAssetNodes('b2', [node({ id: 'n2', bastionId: 'b2' })]);

    expect(await manager.listCachedAssetNodes()).toEqual([
      expect.objectContaining({ id: 'n1', bastionId: 'b1' }),
      expect.objectContaining({ id: 'n2', bastionId: 'b2' })
    ]);
    expect(await manager.listCachedAssetNodes('b1')).toEqual([
      expect.objectContaining({ id: 'n1', bastionId: 'b1' })
    ]);
  });

  it('throws when bastion or password is missing', async () => {
    const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
    const missingId = '11111111-1111-1111-1111-111111111111';

    await expect(manager.requireBastion(missingId)).rejects.toThrow('JumpServer is not configured.');
    await expect(manager.requirePassword(missingId)).rejects.toThrow('JumpServer password is not configured.');
    await expect(manager.requireSettings()).rejects.toThrow('JumpServer is not configured.');
    await expect(manager.requirePassword()).rejects.toThrow('JumpServer password is not configured.');
  });

  it('does not re-migrate when bastions already exist', async () => {
    const globalState = new MemoryMemento();
    const secrets = new MemorySecretStore();
    const existing = bastion({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Prod'
    });
    await globalState.update('jumpserverManager.bastions', [existing]);
    await globalState.update('jumpserverManager.settings', settings());
    await secrets.store('jumpserverManager.password', 'legacy-secret');
    const manager = new JumpServerConfigManager(globalState, secrets, {
      idFactory: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });

    expect(await manager.listBastions()).toEqual([
      expect.objectContaining({ id: existing.id, name: 'Prod' })
    ]);
    expect(globalState.data.has('jumpserverManager.settings')).toBe(true);
    expect(await secrets.get('jumpserverManager.password')).toBe('legacy-secret');
  });

  it('does not re-migrate an empty bastion list after legacy settings are gone', async () => {
    const globalState = new MemoryMemento();
    const manager = new JumpServerConfigManager(globalState, new MemorySecretStore(), {
      idFactory: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });
    await globalState.update('jumpserverManager.bastions', []);

    expect(await manager.listBastions()).toEqual([]);
    expect(globalState.data.get('jumpserverManager.bastions')).toEqual([]);
  });

  it('writes an empty bastion list when nothing is stored', async () => {
    const globalState = new MemoryMemento();
    const manager = new JumpServerConfigManager(globalState, new MemorySecretStore());

    expect(await manager.listBastions()).toEqual([]);
    expect(globalState.data.get('jumpserverManager.bastions')).toEqual([]);
  });

  it('drops invalid cache rows during migration and still deletes legacy settings', async () => {
    const globalState = new MemoryMemento();
    const secrets = new MemorySecretStore();
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await globalState.update('jumpserverManager.settings', settings());
    await secrets.store('jumpserverManager.password', 'super-secret');
    await globalState.update('jumpserverManager.cachedAssets', [
      legacyAsset(),
      { not: 'an asset' }
    ]);
    await globalState.update('jumpserverManager.cachedAssetNodes', [
      {
        id: 'node-web',
        name: 'Web',
        path: ['Production', 'Web'],
        assetIds: ['asset-1'],
        raw: {}
      },
      { id: '' }
    ]);
    const manager = new JumpServerConfigManager(globalState, secrets, {
      idFactory: () => id
    });

    await manager.listBastions();

    expect(await manager.listCachedAssets(id)).toEqual([
      expect.objectContaining({ id: 'asset-1', bastionId: id })
    ]);
    expect(await manager.listCachedAssetNodes(id)).toEqual([
      expect.objectContaining({ id: 'node-web', bastionId: id })
    ]);
    expect(globalState.data.has('jumpserverManager.settings')).toBe(false);
    expect(await secrets.get('jumpserverManager.password')).toBeUndefined();
    await expect(manager.listCachedAssets()).resolves.toEqual([
      expect.objectContaining({ id: 'asset-1', bastionId: id })
    ]);
  });

  it('drops corrupt cached rows when listing after bastions already exist', async () => {
    const globalState = new MemoryMemento();
    const existing = bastion();
    await globalState.update('jumpserverManager.bastions', [existing]);
    await globalState.update('jumpserverManager.cachedAssets', [
      asset({ id: 'asset-1', bastionId: existing.id }),
      { bad: true }
    ]);
    await globalState.update('jumpserverManager.cachedAssetNodes', [
      node({ id: 'node-web', bastionId: existing.id }),
      { id: '' }
    ]);
    const manager = new JumpServerConfigManager(globalState, new MemorySecretStore());

    expect(await manager.listCachedAssets()).toEqual([
      expect.objectContaining({ id: 'asset-1', bastionId: existing.id })
    ]);
    expect(await manager.listCachedAssetNodes()).toEqual([
      expect.objectContaining({ id: 'node-web', bastionId: existing.id })
    ]);
  });
});
