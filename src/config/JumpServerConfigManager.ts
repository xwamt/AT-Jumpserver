import { randomUUID } from 'node:crypto';
import {
  bastionDisplayName,
  parseCachedJumpServerAssets,
  parseCachedJumpServerNodes,
  parseJumpServerBastion,
  parseJumpServerBastionList,
  parseJumpServerSettings,
  sanitizeCachedAssetRaw,
  type CachedJumpServerAsset,
  type CachedJumpServerNode,
  type JumpServerBastion,
  type JumpServerSettings
} from './schema';

const BASTIONS_KEY = 'jumpserverManager.bastions';
const SETTINGS_KEY = 'jumpserverManager.settings';
const ASSETS_KEY = 'jumpserverManager.cachedAssets';
const NODES_KEY = 'jumpserverManager.cachedAssetNodes';
const PASSWORD_KEY = 'jumpserverManager.password';
const passwordKey = (id: string) => `jumpserverManager.password.${id}`;

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

function stampBastionId(rows: unknown, bastionId: string): unknown[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return row;
    }
    return { ...(row as Record<string, unknown>), bastionId };
  });
}

export class JumpServerConfigManager {
  private readonly idFactory: () => string;

  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore,
    options?: { idFactory?: () => string }
  ) {
    this.idFactory = options?.idFactory ?? randomUUID;
  }

  async listBastions(): Promise<JumpServerBastion[]> {
    await this.migrateIfNeeded();
    return parseJumpServerBastionList(this.globalState.get<unknown>(BASTIONS_KEY, []));
  }

  async getBastion(id: string): Promise<JumpServerBastion | undefined> {
    return (await this.listBastions()).find((item) => item.id === id);
  }

  async requireBastion(id: string): Promise<JumpServerBastion> {
    const bastion = await this.getBastion(id);
    if (!bastion) {
      throw new Error('JumpServer is not configured.');
    }
    return bastion;
  }

  async saveBastion(bastion: JumpServerBastion, password?: string): Promise<void> {
    await this.migrateIfNeeded();
    const parsed = parseJumpServerBastion(bastion);
    const bastions = await this.listBastions();
    const index = bastions.findIndex((item) => item.id === parsed.id);
    const next = index === -1
      ? [...bastions, parsed]
      : bastions.map((item, itemIndex) => (itemIndex === index ? parsed : item));
    await this.globalState.update(BASTIONS_KEY, next);
    if (password !== undefined) {
      await this.secrets.store(passwordKey(parsed.id), password);
    }
  }

  async deleteBastion(id: string): Promise<void> {
    await this.migrateIfNeeded();
    const bastions = (await this.listBastions()).filter((item) => item.id !== id);
    const assets = (await this.listCachedAssets()).filter((asset) => asset.bastionId !== id);
    const nodes = (await this.listCachedAssetNodes()).filter((node) => node.bastionId !== id);
    await this.globalState.update(BASTIONS_KEY, bastions);
    await this.globalState.update(ASSETS_KEY, assets);
    await this.globalState.update(NODES_KEY, nodes);
    await this.secrets.delete(passwordKey(id));
  }

  async getSettings(): Promise<JumpServerSettings | undefined> {
    const [first] = await this.listBastions();
    if (!first) {
      return undefined;
    }
    return {
      baseUrl: first.baseUrl,
      orgId: first.orgId,
      username: first.username,
      verifyTls: first.verifyTls,
      updatedAt: first.updatedAt
    };
  }

  async requireSettings(): Promise<JumpServerSettings> {
    const settings = await this.getSettings();
    if (!settings) {
      throw new Error('JumpServer is not configured.');
    }
    return settings;
  }

  async saveSettings(settings: JumpServerSettings, password?: string): Promise<void> {
    await this.migrateIfNeeded();
    const parsed = parseJumpServerSettings(settings);
    const bastions = await this.listBastions();
    if (bastions.length === 0) {
      await this.saveBastion({
        id: this.idFactory(),
        name: bastionDisplayName('', parsed.baseUrl),
        baseUrl: parsed.baseUrl,
        orgId: parsed.orgId,
        username: parsed.username,
        verifyTls: parsed.verifyTls,
        updatedAt: parsed.updatedAt
      }, password);
      return;
    }
    const first = bastions[0];
    await this.saveBastion({
      ...first,
      ...parsed,
      id: first.id,
      name: first.name
    }, password);
  }

  async deleteSettings(): Promise<void> {
    await this.migrateIfNeeded();
    for (const bastion of await this.listBastions()) {
      await this.secrets.delete(passwordKey(bastion.id));
    }
    await this.secrets.delete(PASSWORD_KEY);
    await this.globalState.update(BASTIONS_KEY, []);
    await this.globalState.update(ASSETS_KEY, undefined);
    await this.globalState.update(NODES_KEY, undefined);
    await this.globalState.update(SETTINGS_KEY, undefined);
  }

  async getPassword(id?: string): Promise<string | undefined> {
    await this.migrateIfNeeded();
    const bastionId = id ?? (await this.listBastions())[0]?.id;
    if (!bastionId) {
      return undefined;
    }
    return this.secrets.get(passwordKey(bastionId));
  }

  async requirePassword(id?: string): Promise<string> {
    const password = await this.getPassword(id);
    if (!password) {
      throw new Error('JumpServer password is not configured.');
    }
    return password;
  }

  async saveCachedAssets(bastionId: string, assets: CachedJumpServerAsset[]): Promise<void> {
    await this.migrateIfNeeded();
    const others = (await this.listCachedAssets()).filter((asset) => asset.bastionId !== bastionId);
    const stamped = assets.map((asset) => ({
      ...asset,
      bastionId,
      raw: sanitizeCachedAssetRaw(asset.raw)
    }));
    await this.globalState.update(ASSETS_KEY, parseCachedJumpServerAssets([...others, ...stamped]));
  }

  async listCachedAssets(bastionId?: string): Promise<CachedJumpServerAsset[]> {
    await this.migrateIfNeeded();
    const assets = parseCachedJumpServerAssets(this.globalState.get<unknown[]>(ASSETS_KEY, []));
    return bastionId ? assets.filter((asset) => asset.bastionId === bastionId) : assets;
  }

  async saveCachedAssetNodes(bastionId: string, nodes: CachedJumpServerNode[]): Promise<void> {
    await this.migrateIfNeeded();
    const others = (await this.listCachedAssetNodes()).filter((node) => node.bastionId !== bastionId);
    const stamped = nodes.map((node) => ({
      ...node,
      bastionId,
      raw: sanitizeCachedAssetRaw(node.raw)
    }));
    await this.globalState.update(NODES_KEY, parseCachedJumpServerNodes([...others, ...stamped]));
  }

  async listCachedAssetNodes(bastionId?: string): Promise<CachedJumpServerNode[]> {
    await this.migrateIfNeeded();
    const nodes = parseCachedJumpServerNodes(this.globalState.get<unknown[]>(NODES_KEY, []));
    return bastionId ? nodes.filter((node) => node.bastionId === bastionId) : nodes;
  }

  private async migrateIfNeeded(): Promise<void> {
    const rawBastions = this.globalState.get<unknown | undefined>(BASTIONS_KEY, undefined);
    if (rawBastions !== undefined) {
      const parsed = parseJumpServerBastionList(rawBastions);
      if (parsed.length > 0) {
        return;
      }
      const legacy = this.readLegacySettings();
      if (!legacy) {
        return;
      }
      await this.migrateFromLegacy(legacy);
      return;
    }

    const legacy = this.readLegacySettings();
    if (legacy) {
      await this.migrateFromLegacy(legacy);
      return;
    }
    await this.globalState.update(BASTIONS_KEY, []);
  }

  private readLegacySettings(): JumpServerSettings | undefined {
    const raw = this.globalState.get<unknown | undefined>(SETTINGS_KEY, undefined);
    if (raw === undefined || raw === null) {
      return undefined;
    }
    try {
      return parseJumpServerSettings(raw);
    } catch {
      return undefined;
    }
  }

  private async migrateFromLegacy(settings: JumpServerSettings): Promise<void> {
    const id = this.idFactory();
    const bastion = parseJumpServerBastion({
      id,
      name: bastionDisplayName('', settings.baseUrl),
      baseUrl: settings.baseUrl,
      orgId: settings.orgId,
      username: settings.username,
      verifyTls: settings.verifyTls,
      updatedAt: settings.updatedAt
    });
    await this.globalState.update(BASTIONS_KEY, [bastion]);

    const password = await this.secrets.get(PASSWORD_KEY);
    if (password !== undefined) {
      await this.secrets.store(passwordKey(id), password);
      await this.secrets.delete(PASSWORD_KEY);
    }

    const stampedAssets = stampBastionId(this.globalState.get<unknown>(ASSETS_KEY, []), id);
    await this.globalState.update(ASSETS_KEY, parseCachedJumpServerAssets(stampedAssets));
    const stampedNodes = stampBastionId(this.globalState.get<unknown>(NODES_KEY, []), id);
    await this.globalState.update(NODES_KEY, parseCachedJumpServerNodes(stampedNodes));
    await this.globalState.update(SETTINGS_KEY, undefined);
  }
}
