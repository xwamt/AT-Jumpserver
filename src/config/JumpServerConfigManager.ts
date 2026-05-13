import {
  parseCachedJumpServerAssets,
  parseJumpServerSettings,
  sanitizeCachedAssetRaw,
  type CachedJumpServerAsset,
  type JumpServerSettings
} from './schema';

const SETTINGS_KEY = 'jumpserverManager.settings';
const ASSETS_KEY = 'jumpserverManager.cachedAssets';
const PASSWORD_KEY = 'jumpserverManager.password';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class JumpServerConfigManager {
  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore
  ) {}

  async getSettings(): Promise<JumpServerSettings | undefined> {
    const raw = this.globalState.get<unknown | undefined>(SETTINGS_KEY, undefined);
    return raw ? parseJumpServerSettings(raw) : undefined;
  }

  async requireSettings(): Promise<JumpServerSettings> {
    const settings = await this.getSettings();
    if (!settings) {
      throw new Error('JumpServer is not configured.');
    }
    return settings;
  }

  async saveSettings(settings: JumpServerSettings, password?: string): Promise<void> {
    await this.globalState.update(SETTINGS_KEY, parseJumpServerSettings(settings));
    if (password !== undefined) {
      await this.secrets.store(PASSWORD_KEY, password);
    }
  }

  async deleteSettings(): Promise<void> {
    await this.globalState.update(SETTINGS_KEY, undefined);
    await this.globalState.update(ASSETS_KEY, undefined);
    await this.secrets.delete(PASSWORD_KEY);
  }

  async getPassword(): Promise<string | undefined> {
    return this.secrets.get(PASSWORD_KEY);
  }

  async requirePassword(): Promise<string> {
    const password = await this.getPassword();
    if (!password) {
      throw new Error('JumpServer password is not configured.');
    }
    return password;
  }

  async saveCachedAssets(assets: CachedJumpServerAsset[]): Promise<void> {
    const sanitized = assets.map((asset) => ({
      ...asset,
      raw: sanitizeCachedAssetRaw(asset.raw)
    }));
    await this.globalState.update(ASSETS_KEY, parseCachedJumpServerAssets(sanitized));
  }

  async listCachedAssets(): Promise<CachedJumpServerAsset[]> {
    return parseCachedJumpServerAssets(this.globalState.get<unknown[]>(ASSETS_KEY, []));
  }
}
