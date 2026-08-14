# AT JumpServer Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `C:\Users\alan\Desktop\jumpserver-plugins`, a standalone VS Code plugin that reuses the AT Terminal xterm UI and connects directly to JumpServer SSH assets through the REST + KoKo WebSocket flow implemented in Ahell.

**Architecture:** Start from `C:\Users\alan\Desktop\ssh-plugins` as a template, keep the terminal webview and focused terminal context, and replace SSH/SFTP/MCP behavior with JumpServer configuration, asset tree, REST client, and KoKo terminal session modules. The extension host owns credentials, token creation, KoKo warmup, WebSocket transport, and terminal message forwarding; the webview UI remains unchanged.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest, esbuild, `@xterm/*`, Node 20 APIs, and `ws` for KoKo WebSocket connections.

---

## Source Inputs

- Approved design: `C:\Users\alan\Desktop\Ahell-v0.0.2\docs\superpowers\specs\2026-05-13-at-jumpserver-terminal-design.md`
- Template plugin: `C:\Users\alan\Desktop\ssh-plugins`
- New plugin target: `C:\Users\alan\Desktop\jumpserver-plugins`
- Ahell JumpServer reference files:
  - `C:\Users\alan\Desktop\Ahell-v0.0.2\tools\services\jumpserver_client.py`
  - `C:\Users\alan\Desktop\Ahell-v0.0.2\tools\services\jumpserver_terminal_proxy_service.py`
  - `C:\Users\alan\Desktop\Ahell-v0.0.2\tools\services\jumpserver_resource_service.py`

## File Map

Create or keep these files in `C:\Users\alan\Desktop\jumpserver-plugins`:

- `package.json`: standalone extension manifest for AT JumpServer Terminal.
- `README.md`: user setup, supported scope, and manual verification.
- `esbuild.config.mjs`: build extension, terminal webview, and config webview bundles.
- `src/extension.ts`: extension activation, tree view, commands, terminal open/refresh/configure wiring.
- `src/config/schema.ts`: Zod schemas for JumpServer settings and cached assets.
- `src/config/JumpServerConfigManager.ts`: globalState + SecretStorage persistence.
- `src/jumpserver/types.ts`: JumpServer normalized domain types and message types.
- `src/jumpserver/redaction.ts`: error/log redaction helpers.
- `src/jumpserver/JumpServerClient.ts`: REST API, cookie jar, CSRF parsing, endpoint and KoKo URL builders.
- `src/jumpserver/JumpServerSession.ts`: KoKo terminal transport implementing the terminal session interface.
- `src/tree/JumpServerTreeProvider.ts`: group assets by `nodePath`, `zoneName`, or `Default`.
- `src/tree/TreeItems.ts`: group and asset tree item classes.
- `src/terminal/TerminalContext.ts`: copy from `ssh-plugins`, with names updated only if necessary.
- `src/webview/TerminalPanel.ts`: copy from `ssh-plugins`, replace `SshSession` factory with `JumpServerSession`.
- `src/webview/JumpServerConfigPanel.ts`: webview wrapper for configuration form.
- `src/webview/html.ts`: copy from `ssh-plugins`.
- `webview/terminal/*`: copy unchanged from `ssh-plugins`.
- `webview/jumpserver-config/index.ts`: configuration form frontend.
- `webview/jumpserver-config/index.css`: configuration form styling.
- `src/utils/errors.ts`, `src/utils/notifications.ts`, `src/utils/nonce.ts`: copy or trim from `ssh-plugins`.
- `media/at-terminal-icon.*`, `media/at-terminal-activity.svg`: copy from `ssh-plugins`, rename only if package metadata requires it.

Remove or leave unregistered these template areas:

- `src/ssh/*`
- `src/sftp/*`
- `src/mcp/*`
- `src/agent/*`
- `src/lrzsz/*` unless terminal transfer detection is intentionally kept; first version should omit it.
- SFTP, MCP, Agent, and direct SSH commands from `package.json`.

Test files to create:

- `test/config/JumpServerConfigManager.test.ts`
- `test/config/schema.test.ts`
- `test/jumpserver/JumpServerClient.test.ts`
- `test/jumpserver/JumpServerSession.test.ts`
- `test/jumpserver/redaction.test.ts`
- `test/tree/JumpServerTreeProvider.test.ts`
- `test/webview/TerminalPanel.test.ts`
- `test/webview/JumpServerConfigPanel.test.ts`
- `test/webview/html.test.ts`
- `test/package.manifest.test.ts`

---

### Task 1: Create Standalone Plugin Skeleton

**Files:**
- Create directory: `C:\Users\alan\Desktop\jumpserver-plugins`
- Copy from: `C:\Users\alan\Desktop\ssh-plugins`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\package.json`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\esbuild.config.mjs`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\tsconfig.json`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\vitest.config.ts`
- Delete or leave absent: unsupported SSH/SFTP/MCP/Agent source and tests
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\package.manifest.test.ts`

- [ ] **Step 1: Copy the template plugin**

Run from PowerShell:

```powershell
Copy-Item -Recurse -Force C:\Users\alan\Desktop\ssh-plugins C:\Users\alan\Desktop\jumpserver-plugins
Remove-Item -Recurse -Force C:\Users\alan\Desktop\jumpserver-plugins\.git
Remove-Item -Recurse -Force C:\Users\alan\Desktop\jumpserver-plugins\node_modules
Remove-Item -Recurse -Force C:\Users\alan\Desktop\jumpserver-plugins\dist
Remove-Item -Force C:\Users\alan\Desktop\jumpserver-plugins\*.vsix
```

Expected: `C:\Users\alan\Desktop\jumpserver-plugins` exists without nested git history, build output, VSIX packages, or node modules.

- [ ] **Step 2: Write the failing manifest test**

Create `test/package.manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('AT JumpServer Terminal manifest', () => {
  it('declares a standalone JumpServer terminal extension without SSH/SFTP/MCP commands', () => {
    expect(manifest.name).toBe('at-jumpserver-terminal');
    expect(manifest.displayName).toBe('AT JumpServer Terminal');
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('jumpserverManager');

    const commandIds = manifest.contributes.commands.map((command: { command: string }) => command.command);
    expect(commandIds).toEqual([
      'jumpserverManager.configure',
      'jumpserverManager.validate',
      'jumpserverManager.refresh',
      'jumpserverManager.connect',
      'jumpserverManager.disconnect',
      'jumpserverManager.reconnect'
    ]);
    expect(JSON.stringify(manifest)).not.toContain('sftp');
    expect(JSON.stringify(manifest)).not.toContain('run_remote_command');
    expect(JSON.stringify(manifest)).not.toContain('sshManager');
  });
});
```

- [ ] **Step 3: Run the manifest test and verify it fails**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/package.manifest.test.ts
```

Expected: FAIL because `package.json` still describes `at-terminal` and `sshManager`.

- [ ] **Step 4: Replace `package.json` with the JumpServer-only manifest**

Use this content for `package.json`:

```json
{
  "name": "at-jumpserver-terminal",
  "displayName": "AT JumpServer Terminal",
  "description": "JumpServer-backed terminal for VS Code.",
  "version": "0.1.0",
  "publisher": "local",
  "icon": "media/at-terminal-icon.png",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": [
    "onStartupFinished",
    "onView:jumpserverManager.assets"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "jumpserverManager",
          "title": "AT JumpServer",
          "icon": "media/at-terminal-activity.svg"
        }
      ]
    },
    "views": {
      "jumpserverManager": [
        {
          "id": "jumpserverManager.assets",
          "name": "Assets"
        }
      ]
    },
    "commands": [
      {
        "command": "jumpserverManager.configure",
        "title": "JumpServer: Configure"
      },
      {
        "command": "jumpserverManager.validate",
        "title": "JumpServer: Validate Account"
      },
      {
        "command": "jumpserverManager.refresh",
        "title": "JumpServer: Refresh Assets"
      },
      {
        "command": "jumpserverManager.connect",
        "title": "JumpServer: Connect"
      },
      {
        "command": "jumpserverManager.disconnect",
        "title": "JumpServer: Disconnect"
      },
      {
        "command": "jumpserverManager.reconnect",
        "title": "JumpServer: Reconnect"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "jumpserverManager.configure",
          "when": "view == jumpserverManager.assets",
          "group": "navigation@1"
        },
        {
          "command": "jumpserverManager.refresh",
          "when": "view == jumpserverManager.assets",
          "group": "navigation@2"
        }
      ],
      "view/item/context": [
        {
          "command": "jumpserverManager.connect",
          "when": "view == jumpserverManager.assets && viewItem == jumpserverAsset",
          "group": "inline@1"
        }
      ]
    },
    "configuration": {
      "title": "AT JumpServer Terminal",
      "properties": {
        "jumpserverManager.terminalFontSize": {
          "type": "number",
          "default": 14,
          "minimum": 8
        },
        "jumpserverManager.terminalFontFamily": {
          "type": "string",
          "default": "Cascadia Code, Menlo, monospace"
        },
        "jumpserverManager.scrollback": {
          "type": "number",
          "default": 5000,
          "minimum": 100
        },
        "jumpserverManager.semanticHighlight": {
          "type": "boolean",
          "default": true
        },
        "jumpserverManager.idleDisconnectMinutes": {
          "type": "number",
          "default": 60,
          "minimum": 0
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/xterm": "^5.5.0",
    "ws": "^8.18.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^20.19.0",
    "@types/vscode": "^1.85.0",
    "@types/ws": "^8.5.13",
    "@vscode/test-electron": "^2.5.2",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 5: Replace `esbuild.config.mjs` with JumpServer bundle entries**

Use this content:

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: false
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/terminal/index.ts'],
    outfile: 'dist/webview/terminal.js',
    platform: 'browser',
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/jumpserver-config/index.ts'],
    outfile: 'dist/webview/jumpserver-config.js',
    platform: 'browser',
    format: 'iife'
  })
];

const contexts = await Promise.all(contextConfigs);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching AT JumpServer Terminal bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
```

- [ ] **Step 6: Remove unsupported source and test directories**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
Remove-Item -Recurse -Force src\ssh,src\sftp,src\mcp,src\agent,src\lrzsz
Remove-Item -Recurse -Force test\ssh,test\sftp,test\mcp,test\agent,test\lrzsz
Remove-Item -Recurse -Force webview\server-form
```

Expected: unsupported modules are absent, but `webview\terminal`, `src\webview`, `src\terminal`, `src\utils`, `media`, and core config/test tooling remain.

- [ ] **Step 7: Install dependencies**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm install
```

Expected: `package-lock.json` includes `ws` and `@types/ws`; `node_modules` is installed locally.

- [ ] **Step 8: Verify manifest test passes**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/package.manifest.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit skeleton**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git init
git add package.json package-lock.json esbuild.config.mjs tsconfig.json vitest.config.ts media webview src test
git commit -m "chore: scaffold AT JumpServer Terminal plugin"
```

Expected: first standalone plugin commit is created.

---

### Task 2: Add JumpServer Configuration Schema And Secret Storage

**Files:**
- Create/Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\config\schema.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\config\JumpServerConfigManager.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\config\schema.test.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\config\JumpServerConfigManager.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `test/config/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  parseCachedJumpServerAsset,
  parseJumpServerSettings,
  sanitizeCachedAssetRaw
} from '../../src/config/schema';

describe('JumpServer config schema', () => {
  it('normalizes baseUrl and default settings', () => {
    expect(
      parseJumpServerSettings({
        baseUrl: 'https://jumpserver.example.com/',
        orgId: ' org-1 ',
        username: ' alan ',
        verifyTls: undefined,
        connectTimeout: undefined,
        updatedAt: 1
      })
    ).toEqual({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: true,
      connectTimeout: 30,
      updatedAt: 1
    });
  });

  it('rejects unsupported URLs and blank usernames', () => {
    expect(() => parseJumpServerSettings({ baseUrl: 'ftp://bad', username: 'alan', updatedAt: 1 })).toThrow();
    expect(() => parseJumpServerSettings({ baseUrl: 'https://jms.example.com', username: ' ', updatedAt: 1 })).toThrow();
  });

  it('parses cached assets with grouping metadata', () => {
    expect(
      parseCachedJumpServerAsset({
        id: 'asset-1',
        name: 'web-1',
        address: '10.0.0.10',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: 'prod-zone',
        nodePath: ['Production', 'Web'],
        protocolNames: ['ssh'],
        raw: { id: 'asset-1', name: 'web-1' }
      })
    ).toMatchObject({
      id: 'asset-1',
      name: 'web-1',
      nodePath: ['Production', 'Web'],
      protocolNames: ['ssh']
    });
  });

  it('removes credential-like fields from raw asset metadata', () => {
    expect(
      sanitizeCachedAssetRaw({
        id: 'asset-1',
        password: 'secret',
        token: 'bearer',
        nested: { cookie: 'session', keep: 'value' }
      })
    ).toEqual({
      id: 'asset-1',
      nested: { keep: 'value' }
    });
  });
});
```

- [ ] **Step 2: Write failing ConfigManager tests**

Create `test/config/JumpServerConfigManager.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/config/schema.test.ts test/config/JumpServerConfigManager.test.ts
```

Expected: FAIL because the schema and manager do not exist.

- [ ] **Step 4: Implement config schema**

Create `src/config/schema.ts`:

```ts
import { z } from 'zod';

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => /^https?:\/\//i.test(value), 'baseUrl must start with http:// or https://');

export const jumpServerSettingsSchema = z
  .object({
    baseUrl: httpUrlSchema,
    orgId: z.string().trim().optional().default(''),
    username: z.string().trim().min(1),
    verifyTls: z.boolean().default(true),
    connectTimeout: z.number().int().min(1).max(120).default(30),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();

export const cachedJumpServerAssetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    address: z.string().optional().default(''),
    platform: z.string().optional().default(''),
    category: z.string().optional().default(''),
    type: z.string().optional().default(''),
    zoneName: z.string().optional().default(''),
    nodePath: z.array(z.string()).default([]),
    protocolNames: z.array(z.string()).default([]),
    raw: z.record(z.unknown()).default({})
  })
  .strict();

export const cachedJumpServerAssetListSchema = z.array(cachedJumpServerAssetSchema);

export type JumpServerSettings = z.infer<typeof jumpServerSettingsSchema>;
export type CachedJumpServerAsset = z.infer<typeof cachedJumpServerAssetSchema>;

const SECRET_FIELD_PATTERN = /password|secret|token|cookie|authorization|private/i;

export function parseJumpServerSettings(value: unknown): JumpServerSettings {
  return jumpServerSettingsSchema.parse(value);
}

export function parseCachedJumpServerAsset(value: unknown): CachedJumpServerAsset {
  return cachedJumpServerAssetSchema.parse(value);
}

export function parseCachedJumpServerAssets(value: unknown): CachedJumpServerAsset[] {
  return cachedJumpServerAssetListSchema.parse(value);
}

export function sanitizeCachedAssetRaw(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      continue;
    }
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const nested = sanitizeCachedAssetRaw(rawValue);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
      continue;
    }
    result[key] = rawValue;
  }
  return result;
}
```

- [ ] **Step 5: Implement ConfigManager**

Create `src/config/JumpServerConfigManager.ts`:

```ts
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
```

- [ ] **Step 6: Run config tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/config/schema.test.ts test/config/JumpServerConfigManager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit config slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\config test\config
git commit -m "feat: add JumpServer configuration storage"
```

Expected: commit created.

---

### Task 3: Implement JumpServer Client Pure Functions And Redaction

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\types.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\redaction.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\JumpServerClient.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\jumpserver\redaction.test.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\jumpserver\JumpServerClient.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Create `test/jumpserver/redaction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redactSensitiveText, redactSensitiveValue } from '../../src/jumpserver/redaction';

describe('JumpServer redaction', () => {
  it('redacts credential-bearing strings', () => {
    expect(
      redactSensitiveText('Authorization: Bearer abc123; Cookie: sessionid=xyz; token=connection-token')
    ).toBe('Authorization: Bearer [REDACTED]; Cookie: [REDACTED]; token=[REDACTED]');
  });

  it('redacts nested object fields by key', () => {
    expect(
      redactSensitiveValue({
        username: 'alan',
        password: 'secret',
        nested: {
          cookie: 'session',
          keep: 'value'
        }
      })
    ).toEqual({
      username: 'alan',
      password: '[REDACTED]',
      nested: {
        cookie: '[REDACTED]',
        keep: 'value'
      }
    });
  });
});
```

- [ ] **Step 2: Write failing pure-function client tests**

Create `test/jumpserver/JumpServerClient.test.ts` with these initial tests:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildConnectionTokenPayload,
  buildKokoConnectUrl,
  buildKokoWsUrl,
  buildOrigin,
  DEFAULT_CONNECT_OPTIONS,
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver/redaction.test.ts test/jumpserver/JumpServerClient.test.ts
```

Expected: FAIL because `src/jumpserver` modules do not exist.

- [ ] **Step 4: Implement JumpServer types**

Create `src/jumpserver/types.ts`:

```ts
export interface JumpServerSettingsWithPassword {
  baseUrl: string;
  orgId: string;
  username: string;
  password: string;
  verifyTls: boolean;
  connectTimeout: number;
}

export interface JumpServerEndpoint {
  host?: string;
  https_port?: number;
  http_port?: number;
}

export interface JumpServerAccountRef {
  id: string;
  username: string;
}

export interface TerminalEvents {
  output(data: Buffer): void;
  status(message: string): void;
  error(error: unknown): void;
}

export interface KokoControlMessage {
  id?: string;
  type?: string;
  data?: unknown;
}
```

- [ ] **Step 5: Implement redaction**

Create `src/jumpserver/redaction.ts`:

```ts
const SENSITIVE_KEY = /password|secret|token|cookie|authorization|private/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Authorization:\s*Bearer\s+[^;\r\n]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Cookie:\s*[^;\r\n]+/gi, 'Cookie: [REDACTED]')
    .replace(/\b(token|password|secret|cookie)=([^;\s]+)/gi, '$1=[REDACTED]');
}

export function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitiveValue(entry);
  }
  return output;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return redactSensitiveText(String(error));
}
```

- [ ] **Step 6: Implement pure JumpServer client helpers**

Create the helper portion of `src/jumpserver/JumpServerClient.ts`:

```ts
import type { CachedJumpServerAsset } from '../config/schema';
import type { JumpServerAccountRef, JumpServerEndpoint, JumpServerSettingsWithPassword } from './types';

export const DEFAULT_CONNECT_OPTIONS = {
  charset: 'default',
  disableautohash: false,
  token_reusable: false,
  resolution: 'auto',
  backspaceAsCtrlH: false,
  appletConnectMethod: 'web',
  virtualappConnectMethod: 'web',
  reusable: false,
  rdp_connection_speed: 'auto'
} as const;

export function buildOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export function buildKokoConnectUrl(baseUrl: string, tokenId: string, timestamp = Date.now()): string {
  const origin = buildOrigin(baseUrl);
  return `${origin}/koko/connect/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function buildKokoWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now()
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  return `${scheme}://${authority}/koko/ws/terminal/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function parseCsrfMiddlewareToken(html: string): string {
  const match = html.match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/i);
  if (!match) {
    throw new Error('Unable to find csrfmiddlewaretoken in JumpServer login page.');
  }
  return match[1];
}

export function normalizeJumpServerAsset(item: Record<string, any>): CachedJumpServerAsset {
  const platform = item.platform;
  const category = item.category;
  const type = item.type;
  const nodes = Array.isArray(item.nodes) ? item.nodes : [];
  const zone = item.zone;
  const nodePath = nodes
    .filter((node: unknown): node is { name: string } => Boolean(node && typeof node === 'object' && 'name' in node))
    .map((node) => String(node.name));
  const zoneName = typeof zone === 'object' && zone ? String(zone.name || '') : String(zone || '');

  return {
    id: String(item.id || ''),
    name: String(item.name || item.address || item.id || ''),
    address: String(item.address || ''),
    platform: typeof platform === 'object' && platform ? String(platform.name || '') : String(platform || ''),
    category: typeof category === 'object' && category ? String(category.value || '') : String(category || ''),
    type: typeof type === 'object' && type ? String(type.value || '') : String(type || ''),
    zoneName: zoneName || nodePath.at(-1) || '',
    nodePath,
    protocolNames: extractProtocolNames(item),
    raw: item
  };
}

export function extractProtocolNames(item: Record<string, any>): string[] {
  const rawProtocols = Array.isArray(item.permed_protocols)
    ? item.permed_protocols
    : Array.isArray(item.protocols)
      ? item.protocols
      : [];
  return rawProtocols
    .map((protocol: any) => String(protocol?.name || ''))
    .filter((name: string) => name.length > 0);
}

export function resolveFirstUsableAccount(detail: Record<string, any>): JumpServerAccountRef {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];
  for (const account of accounts) {
    const id = account?.id ? String(account.id) : '';
    const username = account?.username || account?.name || account?.alias || '';
    if (id && username) {
      return { id, username: String(username) };
    }
  }
  throw new Error('No usable JumpServer account was returned for this asset.');
}

export function buildConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  protocol: 'ssh';
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: input.protocol,
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'web_cli',
    connect_options: DEFAULT_CONNECT_OPTIONS
  };
}

export class JumpServerClient {
  constructor(private readonly settings: JumpServerSettingsWithPassword) {}
}
```

- [ ] **Step 7: Run pure helper tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver/redaction.test.ts test/jumpserver/JumpServerClient.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit pure client helpers**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\jumpserver test\jumpserver
git commit -m "feat: add JumpServer client helpers"
```

Expected: commit created.

---

### Task 4: Implement JumpServer REST Client And Cookie Warmup

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\JumpServerClient.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\jumpserver\JumpServerClient.test.ts`

- [ ] **Step 1: Extend client tests with mocked fetch**

Add `vi` to the existing Vitest import at the top of `test/jumpserver/JumpServerClient.test.ts`, and add `JumpServerClient` to the existing `../../src/jumpserver/JumpServerClient` import list. Then append these helper functions and tests after the existing pure-helper `describe` block:

```ts
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
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'asset-1', name: 'web-1' }], count: 1 }));
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
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jumpserver.example.com/api/v1/perms/users/self/assets/?limit=200&offset=0', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer bearer-1',
        Accept: 'application/json',
        'X-JMS-ORG': 'org-1'
      })
    }));
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
```

- [ ] **Step 2: Run extended client tests and verify they fail**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver/JumpServerClient.test.ts
```

Expected: FAIL because REST methods are not implemented.

- [ ] **Step 3: Implement REST methods, response checking, and cookie jar**

Replace `JumpServerClient` class in `src/jumpserver/JumpServerClient.ts` with:

```ts
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ListPage {
  results?: unknown[];
  items?: unknown[];
  data?: unknown[];
  count?: number;
  total?: number;
}

export class JumpServerClient {
  private authToken = '';
  private readonly cookies = new Map<string, string>();
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly settings: JumpServerSettingsWithPassword,
    fetchImpl?: FetchLike
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async ensureAuthToken(): Promise<string> {
    if (this.authToken) {
      return this.authToken;
    }
    const response = await this.request('/api/v1/authentication/auth/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: this.settings.username, password: this.settings.password })
    }, false);
    const body = await response.json() as { token?: unknown };
    if (!body.token) {
      throw new Error('JumpServer auth response did not include token.');
    }
    this.authToken = String(body.token);
    return this.authToken;
  }

  async listAssets(input: { limit: number; offset: number }): Promise<CachedJumpServerAsset[]> {
    await this.ensureAuthToken();
    const response = await this.request(`/api/v1/perms/users/self/assets/?limit=${input.limit}&offset=${input.offset}`, {
      headers: this.restHeaders()
    });
    const body = await response.json() as ListPage | unknown[];
    const items = Array.isArray(body)
      ? body
      : Array.isArray(body.results)
        ? body.results
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.data)
            ? body.data
            : [];
    return items
      .filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'))
      .map((item) => normalizeJumpServerAsset(item));
  }

  async getAssetDetail(assetId: string): Promise<Record<string, any>> {
    await this.ensureAuthToken();
    const response = await this.request(`/api/v1/perms/users/self/assets/${encodeURIComponent(assetId)}/`, {
      headers: this.restHeaders()
    });
    return await response.json() as Record<string, any>;
  }

  async createConnectionToken(input: { assetId: string; account: JumpServerAccountRef; protocol: 'ssh' }): Promise<{ id: string }> {
    await this.ensureAuthToken();
    const response = await this.request('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { ...this.restHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(buildConnectionTokenPayload(input))
    });
    const body = await response.json() as { id?: unknown };
    if (!body.id) {
      throw new Error('JumpServer connection-token response did not include id.');
    }
    return { id: String(body.id) };
  }

  async getSmartEndpoint(tokenId: string): Promise<JumpServerEndpoint> {
    await this.ensureAuthToken();
    const response = await this.request(`/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`, {
      headers: this.restHeaders()
    });
    return await response.json() as JumpServerEndpoint;
  }

  async warmupKokoConnectPage(tokenId: string, timestamp = Date.now()): Promise<void> {
    const loginPath = '/core/auth/login/?next=/koko/connect/';
    const loginPage = await this.request(loginPath, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    }, false);
    const csrfToken = parseCsrfMiddlewareToken(await loginPage.text());

    const body = new URLSearchParams({
      csrfmiddlewaretoken: csrfToken,
      username: this.settings.username,
      password: this.settings.password,
      auto_login: 'on'
    });

    const loginSubmit = await this.request(loginPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Referer: `${buildOrigin(this.settings.baseUrl)}${loginPath}`,
        Origin: buildOrigin(this.settings.baseUrl),
        Cookie: this.cookieHeader()
      },
      body: body.toString(),
      redirect: 'manual'
    }, false);

    let location = loginSubmit.headers.get('location');
    for (let index = 0; index < 5 && location; index += 1) {
      const redirectResponse = await this.request(location, { redirect: 'manual' }, false);
      if (![301, 302, 303, 307, 308].includes(redirectResponse.status)) {
        break;
      }
      location = redirectResponse.headers.get('location');
    }

    await this.request('/api/v1/users/profile/', { headers: { Accept: 'application/json' } }, false);
    const connectResponse = await this.request(buildKokoConnectUrl(this.settings.baseUrl, tokenId, timestamp), {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: this.cookieHeader()
      },
      redirect: 'manual'
    }, false);
    if ([301, 302, 303, 307, 308].includes(connectResponse.status)) {
      throw new Error('KoKo web session is not authenticated.');
    }
    if (!connectResponse.ok) {
      throw new Error(`KoKo connect warmup failed with HTTP ${connectResponse.status}.`);
    }
  }

  cookieHeader(): string {
    return Array.from(this.cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
  }

  restHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: 'application/json'
    };
    if (this.settings.orgId) {
      headers['X-JMS-ORG'] = this.settings.orgId;
    }
    return headers;
  }

  private async request(pathOrUrl: string, init: RequestInit = {}, requireOk = true): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${buildOrigin(this.settings.baseUrl)}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieHeader();
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader);
    }
    const response = await this.fetchImpl(url, { ...init, headers });
    this.captureCookies(response);
    if (requireOk && !response.ok) {
      throw new Error(`JumpServer request failed with HTTP ${response.status}.`);
    }
    return response;
  }

  private captureCookies(response: Response): void {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
      return;
    }
    for (const rawCookie of splitSetCookieHeader(setCookie)) {
      const [nameValue] = rawCookie.split(';');
      const separator = nameValue.indexOf('=');
      if (separator > 0) {
        this.cookies.set(nameValue.slice(0, separator).trim(), nameValue.slice(separator + 1).trim());
      }
    }
  }
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}
```

- [ ] **Step 4: Run client tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver/JumpServerClient.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm run typecheck
```

Expected: PASS. If copied unsupported SSH/SFTP/MCP imports remain, remove the stale files or imports and rerun until this command passes.

- [ ] **Step 6: Commit REST client slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\jumpserver\JumpServerClient.ts test\jumpserver\JumpServerClient.test.ts
git commit -m "feat: add JumpServer REST client"
```

Expected: commit created.

---

### Task 5: Implement KoKo Terminal Session

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\JumpServerSession.ts`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\jumpserver\JumpServerClient.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\jumpserver\JumpServerSession.test.ts`

- [ ] **Step 1: Add WebSocket factory support to client**

Add this import at the top of `src/jumpserver/JumpServerClient.ts`:

```ts
import WebSocket from 'ws';
```

Then export these types and factory functions near the other exported helpers:

```ts
export type KokoWebSocket = Pick<WebSocket, 'send' | 'close' | 'on'>;
export type WebSocketFactory = (url: string, options: WebSocket.ClientOptions) => Promise<KokoWebSocket>;

export async function defaultWebSocketFactory(url: string, options: WebSocket.ClientOptions): Promise<KokoWebSocket> {
  const socket = new WebSocket(url, ['JMS-KOKO'], options);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}
```

Add this method to `JumpServerClient`:

```ts
async openKokoWebSocket(input: {
  endpoint: JumpServerEndpoint;
  tokenId: string;
  cols: number;
  rows: number;
  webSocketFactory?: WebSocketFactory;
}): Promise<KokoWebSocket> {
  await this.warmupKokoConnectPage(input.tokenId);
  const url = buildKokoWsUrl(this.settings.baseUrl, input.endpoint, input.tokenId);
  const factory = input.webSocketFactory ?? defaultWebSocketFactory;
  return factory(url, {
    origin: buildOrigin(this.settings.baseUrl),
    headers: {
      Cookie: this.cookieHeader(),
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': 'AT JumpServer Terminal'
    },
    rejectUnauthorized: this.settings.verifyTls
  });
}
```

- [ ] **Step 2: Write failing session tests**

Create `test/jumpserver/JumpServerSession.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JumpServerSession } from '../../src/jumpserver/JumpServerSession';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function client(socket: FakeSocket) {
  return {
    getAssetDetail: vi.fn().mockResolvedValue({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root' }],
      permed_protocols: [{ name: 'ssh' }]
    }),
    createConnectionToken: vi.fn().mockResolvedValue({ id: 'token-1' }),
    getSmartEndpoint: vi.fn().mockResolvedValue({ host: 'koko.example.com', https_port: 443 }),
    openKokoWebSocket: vi.fn().mockResolvedValue(socket)
  };
}

describe('JumpServerSession', () => {
  let socket: FakeSocket;
  let events: { output: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    socket = new FakeSocket();
    events = { output: vi.fn(), status: vi.fn(), error: vi.fn() };
  });

  it('creates token, opens KoKo socket, and initializes terminal after CONNECT', async () => {
    const fakeClient = client(socket);
    const session = new JumpServerSession({
      asset: { id: 'asset-1', name: 'web-1' },
      client: fakeClient,
      events
    });

    await session.connect();
    socket.emit('message', JSON.stringify({ id: 'connect-1', type: 'CONNECT', data: '{}' }));

    expect(fakeClient.createConnectionToken).toHaveBeenCalledWith({
      assetId: 'asset-1',
      account: { id: 'account-1', username: 'root' },
      protocol: 'ssh'
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({
      id: 'connect-1',
      type: 'TERMINAL_INIT',
      data: JSON.stringify({ cols: 80, rows: 24, code: '' })
    }));
    expect(events.status).toHaveBeenCalledWith('Connected');
  });

  it('maps webview input and resize to KoKo terminal messages', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket), events });
    await session.connect();

    session.write('ls\r');
    session.resize(40, 120);

    expect(socket.sent).toContain(JSON.stringify({ id: '', type: 'TERMINAL_DATA', data: 'ls\r' }));
    expect(socket.sent).toContain(JSON.stringify({
      id: '',
      type: 'TERMINAL_RESIZE',
      data: JSON.stringify({ cols: 120, rows: 40 })
    }));
  });

  it('forwards upstream bytes and closes cleanly', async () => {
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, client: client(socket), events });
    await session.connect();

    socket.emit('message', Buffer.from('hello', 'utf8'));
    session.dispose();

    expect(events.output).toHaveBeenCalledWith(Buffer.from('hello', 'utf8'));
    expect(socket.closed).toBe(true);
  });

  it('rejects non-SSH assets', async () => {
    const fakeClient = client(socket);
    fakeClient.getAssetDetail.mockResolvedValueOnce({
      id: 'asset-1',
      permed_accounts: [{ id: 'account-1', username: 'root' }],
      permed_protocols: [{ name: 'rdp' }]
    });
    const session = new JumpServerSession({ asset: { id: 'asset-1', name: 'web-1' }, client: fakeClient, events });

    await expect(session.connect()).rejects.toThrow('Selected asset does not expose SSH protocol.');
  });
});
```

- [ ] **Step 3: Run session tests and verify they fail**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver/JumpServerSession.test.ts
```

Expected: FAIL because `JumpServerSession` does not exist.

- [ ] **Step 4: Implement JumpServerSession**

Create `src/jumpserver/JumpServerSession.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { buildConnectionTokenPayload, extractProtocolNames, resolveFirstUsableAccount, type KokoWebSocket } from './JumpServerClient';
import type { TerminalEvents } from './types';

export interface JumpServerSessionAsset {
  id: string;
  name: string;
}

export interface JumpServerSessionClient {
  getAssetDetail(assetId: string): Promise<Record<string, any>>;
  createConnectionToken(input: {
    assetId: string;
    account: { id: string; username: string };
    protocol: 'ssh';
  }): Promise<{ id: string }>;
  getSmartEndpoint(tokenId: string): Promise<Record<string, any>>;
  openKokoWebSocket(input: {
    endpoint: Record<string, any>;
    tokenId: string;
    cols: number;
    rows: number;
  }): Promise<KokoWebSocket>;
}

export class JumpServerSession {
  private socket: KokoWebSocket | undefined;
  private rows = 24;
  private cols = 80;
  private connected = false;

  constructor(private readonly input: {
    asset: JumpServerSessionAsset;
    client: JumpServerSessionClient;
    events: TerminalEvents;
  }) {}

  async connect(): Promise<void> {
    this.input.events.status('Loading asset');
    const detail = await this.input.client.getAssetDetail(this.input.asset.id);
    const protocolNames = extractProtocolNames(detail);
    if (!protocolNames.includes('ssh')) {
      throw new Error('Selected asset does not expose SSH protocol.');
    }
    const account = resolveFirstUsableAccount(detail);

    this.input.events.status('Creating connection token');
    const token = await this.input.client.createConnectionToken({
      assetId: this.input.asset.id,
      account,
      protocol: 'ssh'
    });
    const endpoint = await this.input.client.getSmartEndpoint(token.id);

    this.input.events.status('Opening KoKo terminal');
    this.socket = await this.input.client.openKokoWebSocket({
      endpoint,
      tokenId: token.id,
      cols: this.cols,
      rows: this.rows
    });
    this.bindSocket(this.socket);
  }

  write(data: string): void {
    this.socket?.send(JSON.stringify({ id: '', type: 'TERMINAL_DATA', data }));
  }

  resize(rows: number, cols: number): void {
    if (rows <= 0 || cols <= 0) {
      return;
    }
    this.rows = rows;
    this.cols = cols;
    this.socket?.send(JSON.stringify({
      id: '',
      type: 'TERMINAL_RESIZE',
      data: JSON.stringify({ cols, rows })
    }));
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
  }

  private bindSocket(socket: KokoWebSocket): void {
    socket.on('message', (message: Buffer | string) => {
      if (Buffer.isBuffer(message)) {
        this.input.events.output(message);
        return;
      }
      this.handleControlMessage(String(message));
    });
    socket.on('close', () => {
      this.connected = false;
      this.input.events.status('Disconnected');
    });
    socket.on('error', (error) => this.input.events.error(error));
  }

  private handleControlMessage(message: string): void {
    const payload = JSON.parse(message) as { id?: string; type?: string; data?: unknown };
    if (payload.type === 'CONNECT') {
      const init = {
        id: payload.id || randomUUID(),
        type: 'TERMINAL_INIT',
        data: JSON.stringify({ cols: this.cols, rows: this.rows, code: '' })
      };
      this.socket?.send(JSON.stringify(init));
      this.connected = true;
      this.input.events.status('Connected');
      return;
    }
    if (typeof payload.data === 'string' && payload.type === 'TERMINAL_DATA') {
      this.input.events.output(Buffer.from(payload.data, 'utf8'));
    }
  }
}
```

- [ ] **Step 5: Run session tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver/JumpServerSession.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all JumpServer tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/jumpserver
```

Expected: PASS.

- [ ] **Step 7: Commit session slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\jumpserver test\jumpserver
git commit -m "feat: add KoKo terminal session"
```

Expected: commit created.

---

### Task 6: Add Asset Tree Provider

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\tree\TreeItems.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\tree\JumpServerTreeProvider.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\tree\JumpServerTreeProvider.test.ts`

- [ ] **Step 1: Write failing tree tests**

Create `test/tree/JumpServerTreeProvider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { JumpServerTreeProvider } from '../../src/tree/JumpServerTreeProvider';
import { AssetTreeItem, GroupTreeItem } from '../../src/tree/TreeItems';

const assets = [
  { id: 'asset-1', name: 'web-1', address: '10.0.0.10', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'Web'], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-2', name: 'db-1', address: '10.0.0.11', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'DB'], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-3', name: 'ops-1', address: '', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Ops', nodePath: [], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-4', name: 'misc-1', address: '', platform: '', category: 'host', type: 'server', zoneName: '', nodePath: [], protocolNames: ['ssh'], raw: {} }
];

describe('JumpServerTreeProvider', () => {
  it('groups root nodes by first nodePath segment, zoneName, and Default', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });

    const roots = await provider.getChildren();

    expect(roots.map((item) => item.label)).toEqual(['Default', 'Ops', 'Production']);
    expect(roots.every((item) => item instanceof GroupTreeItem)).toBe(true);
  });

  it('walks nested nodePath groups down to asset nodes', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });
    const production = (await provider.getChildren()).find((item) => item.label === 'Production') as GroupTreeItem;
    const productionChildren = await provider.getChildren(production);
    const web = productionChildren.find((item) => item.label === 'Web') as GroupTreeItem;
    const webChildren = await provider.getChildren(web);

    expect(productionChildren.map((item) => item.label)).toEqual(['DB', 'Web']);
    expect(webChildren).toHaveLength(1);
    expect(webChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((webChildren[0] as AssetTreeItem).asset.id).toBe('asset-1');
  });

  it('uses address or platform as asset description', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });
    const ops = (await provider.getChildren()).find((item) => item.label === 'Ops') as GroupTreeItem;
    const [asset] = await provider.getChildren(ops);

    expect(asset).toBeInstanceOf(AssetTreeItem);
    expect((asset as AssetTreeItem).description).toBe('Linux');
  });
});
```

- [ ] **Step 2: Run tree tests and verify they fail**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/tree/JumpServerTreeProvider.test.ts
```

Expected: FAIL because tree modules do not exist.

- [ ] **Step 3: Implement tree item classes**

Create `src/tree/TreeItems.ts`:

```ts
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';

export class GroupTreeItem extends vscode.TreeItem {
  readonly contextValue = 'jumpserverGroup';

  constructor(
    readonly path: string[],
    collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
  ) {
    super(path.at(-1) || 'Default', collapsibleState);
    this.label = path.at(-1) || 'Default';
  }
}

export class AssetTreeItem extends vscode.TreeItem {
  readonly contextValue = 'jumpserverAsset';

  constructor(readonly asset: CachedJumpServerAsset) {
    super(asset.name, vscode.TreeItemCollapsibleState.None);
    this.label = asset.name;
    this.description = asset.address || asset.platform;
    this.tooltip = `${asset.name}${asset.address ? ` (${asset.address})` : ''}`;
    this.command = {
      command: 'jumpserverManager.connect',
      title: 'Connect',
      arguments: [this]
    };
  }
}
```

- [ ] **Step 4: Implement tree provider**

Create `src/tree/JumpServerTreeProvider.ts`:

```ts
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { AssetTreeItem, GroupTreeItem } from './TreeItems';

export interface JumpServerAssetSource {
  listCachedAssets(): Promise<CachedJumpServerAsset[]>;
}

export class JumpServerTreeProvider implements vscode.TreeDataProvider<GroupTreeItem | AssetTreeItem> {
  private readonly changed = new vscode.EventEmitter<GroupTreeItem | AssetTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: JumpServerAssetSource) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: GroupTreeItem | AssetTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GroupTreeItem | AssetTreeItem): Promise<Array<GroupTreeItem | AssetTreeItem>> {
    if (element instanceof AssetTreeItem) {
      return [];
    }
    const assets = await this.source.listCachedAssets();
    const parentPath = element?.path ?? [];
    const childGroups = new Set<string>();
    const childAssets: CachedJumpServerAsset[] = [];

    for (const asset of assets) {
      const groupPath = this.groupPath(asset);
      if (!this.startsWith(groupPath, parentPath)) {
        continue;
      }
      if (groupPath.length > parentPath.length) {
        childGroups.add(groupPath[parentPath.length]);
      } else {
        childAssets.push(asset);
      }
    }

    return [
      ...Array.from(childGroups).sort((a, b) => a.localeCompare(b)).map((group) => new GroupTreeItem([...parentPath, group])),
      ...childAssets.sort((a, b) => a.name.localeCompare(b.name)).map((asset) => new AssetTreeItem(asset))
    ];
  }

  private groupPath(asset: CachedJumpServerAsset): string[] {
    if (asset.nodePath.length > 0) {
      return asset.nodePath;
    }
    if (asset.zoneName.trim()) {
      return [asset.zoneName.trim()];
    }
    return ['Default'];
  }

  private startsWith(path: string[], prefix: string[]): boolean {
    return prefix.every((value, index) => path[index] === value);
  }
}
```

- [ ] **Step 5: Run tree tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/tree/JumpServerTreeProvider.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit tree slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\tree test\tree
git commit -m "feat: add JumpServer asset tree"
```

Expected: commit created.

---

### Task 7: Wire TerminalPanel To JumpServerSession

**Files:**
- Copy/Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\webview\TerminalPanel.ts`
- Keep: `C:\Users\alan\Desktop\jumpserver-plugins\webview\terminal\index.ts`
- Keep: `C:\Users\alan\Desktop\jumpserver-plugins\webview\terminal\index.css`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\webview\TerminalPanel.test.ts`

- [ ] **Step 1: Write failing TerminalPanel test for JumpServer session factory**

Replace the SSH mock in `test/webview/TerminalPanel.test.ts` with a JumpServer mock:

```ts
vi.mock('../../src/jumpserver/JumpServerSession', () => ({
  JumpServerSession: vi.fn().mockImplementation((_input) => {
    return {
      connect,
      dispose: disposeSession,
      write,
      resize
    };
  })
}));
```

Update the fixture asset helper:

```ts
function asset(id = 'terminal-asset') {
  return {
    id,
    name: id,
    address: `${id}.example.com`,
    platform: 'Linux',
    category: 'host',
    type: 'server',
    zoneName: 'Production',
    nodePath: ['Production'],
    protocolNames: ['ssh'],
    raw: {}
  };
}
```

Update the opening test to call:

```ts
TerminalPanel.open(extensionContext(), asset(), jumpServerClient(), undefined, registry);
```

Add this assertion:

```ts
expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
  'jumpserverTerminal',
  'JumpServer: terminal-asset',
  vscode.ViewColumn.Active,
  expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
);
```

- [ ] **Step 2: Run TerminalPanel test and verify it fails**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/webview/TerminalPanel.test.ts
```

Expected: FAIL because `TerminalPanel` still imports `SshSession` and `ServerConfig`.

- [ ] **Step 3: Modify TerminalPanel constructor and session creation**

In `src/webview/TerminalPanel.ts`, replace SSH imports and fields with:

```ts
import type { CachedJumpServerAsset } from '../config/schema';
import { JumpServerSession } from '../jumpserver/JumpServerSession';
import type { JumpServerClient } from '../jumpserver/JumpServerClient';
```

Replace the `server` field and `configManager` field with:

```ts
private readonly asset: CachedJumpServerAsset,
private readonly jumpServerClient: JumpServerClient,
```

Use this static `open` signature:

```ts
static open(
  context: vscode.ExtensionContext,
  asset: CachedJumpServerAsset,
  jumpServerClient: JumpServerClient,
  terminalContext?: TerminalContextRegistry
): TerminalPanel
```

Create panels with:

```ts
const panel = vscode.window.createWebviewPanel(
  'jumpserverTerminal',
  `JumpServer: ${asset.name}`,
  createTerminalViewColumn(),
  {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri]
  }
);
```

Replace `createSession` body with:

```ts
private createSession(generation: number): JumpServerSession {
  return new JumpServerSession({
    asset: this.asset,
    client: this.jumpServerClient,
    events: {
      output: (data) => this.postWebviewMessage({ type: 'outputBytes', payload: [...data] }),
      status: (message) => this.handleSessionStatus(message, generation),
      error: (error) => this.postStatus(formatError(error))
    }
  });
}
```

Update `publishContext` to use the asset:

```ts
private publishContext(): void {
  this.terminalContext?.setActive({
    terminalId: this.terminalId,
    asset: this.asset,
    connected: this.connected,
    write: (data) => this.session.write(data)
  });
}
```

- [ ] **Step 4: Update terminal context type**

Modify `src/terminal/TerminalContext.ts` so active contexts reference assets:

```ts
import type { CachedJumpServerAsset } from '../config/schema';

export interface ActiveTerminalContext {
  terminalId: string;
  asset: CachedJumpServerAsset;
  connected: boolean;
  write(data: string): void;
}
```

Keep the existing registry methods from `ssh-plugins`: `setActive`, `getActive`, `clearIfActive`, `markConnected`, `markDisconnected`, and `onDidChangeActiveContext`.

- [ ] **Step 5: Run TerminalPanel tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test\webview\TerminalPanel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run terminal webview tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test\webview
```

Expected: PASS after removing tests that reference the old server form or updating them to the JumpServer config form in Task 8.

- [ ] **Step 7: Commit TerminalPanel slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\webview\TerminalPanel.ts src\terminal test\webview\TerminalPanel.test.ts
git commit -m "feat: connect terminal panel to JumpServer session"
```

Expected: commit created.

---

### Task 8: Add JumpServer Configuration Webview

**Files:**
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\src\webview\JumpServerConfigPanel.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\webview\jumpserver-config\index.ts`
- Create: `C:\Users\alan\Desktop\jumpserver-plugins\webview\jumpserver-config\index.css`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\webview\html.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\webview\JumpServerConfigPanel.test.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\webview\html.test.ts`

- [ ] **Step 1: Write failing config panel test**

Create `test/webview/JumpServerConfigPanel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { JumpServerConfigPanel, renderJumpServerConfigBody } from '../../src/webview/JumpServerConfigPanel';

describe('JumpServerConfigPanel', () => {
  it('renders configuration fields without including stored password', () => {
    const body = renderJumpServerConfigBody({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: true,
      connectTimeout: 30,
      updatedAt: 1
    });

    expect(body).toContain('name="baseUrl"');
    expect(body).toContain('value="https://jumpserver.example.com"');
    expect(body).toContain('name="password"');
    expect(body).not.toContain('super-secret');
  });

  it('opens a webview panel for configuration', () => {
    const panel = {
      webview: {
        html: '',
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn()
      },
      onDidDispose: vi.fn()
    } as unknown as vscode.WebviewPanel;
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panel);

    JumpServerConfigPanel.open({ extensionUri: vscode.Uri.file('extension-root') } as vscode.ExtensionContext, {
      getSettings: async () => undefined,
      saveSettings: async () => undefined
    });

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverConfig',
      'Configure JumpServer',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true })
    );
  });
});
```

- [ ] **Step 2: Run config panel test and verify it fails**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/webview/JumpServerConfigPanel.test.ts
```

Expected: FAIL because `JumpServerConfigPanel` does not exist.

- [ ] **Step 3: Implement JumpServerConfigPanel**

Create `src/webview/JumpServerConfigPanel.ts`:

```ts
import * as vscode from 'vscode';
import type { JumpServerSettings } from '../config/schema';
import { renderWebviewHtml, type WebviewAsset } from './html';

export interface JumpServerConfigPanelStore {
  getSettings(): Promise<JumpServerSettings | undefined>;
  saveSettings(settings: JumpServerSettings, password?: string): Promise<void>;
}

type ConfigMessage = {
  type: 'save';
  payload: {
    baseUrl: string;
    orgId: string;
    username: string;
    password: string;
    verifyTls: boolean;
    connectTimeout: number;
  };
};

export class JumpServerConfigPanel {
  static async open(context: vscode.ExtensionContext, store: JumpServerConfigPanelStore): Promise<void> {
    const panel = vscode.window.createWebviewPanel('jumpserverConfig', 'Configure JumpServer', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [context.extensionUri]
    });
    const settings = await store.getSettings();
    panel.webview.html = renderWebviewHtml(panel.webview, createConfigAssets(context.extensionUri), renderJumpServerConfigBody(settings));
    panel.webview.onDidReceiveMessage(async (message: ConfigMessage) => {
      if (message.type !== 'save') {
        return;
      }
      const now = Date.now();
      await store.saveSettings({
        baseUrl: message.payload.baseUrl,
        orgId: message.payload.orgId,
        username: message.payload.username,
        verifyTls: message.payload.verifyTls,
        connectTimeout: message.payload.connectTimeout,
        updatedAt: now
      }, message.payload.password || undefined);
      await vscode.window.showInformationMessage('JumpServer configuration saved.');
      panel.dispose();
    });
  }
}

export function createConfigAssets(extensionUri: vscode.Uri): WebviewAsset {
  return {
    script: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'jumpserver-config.js'),
    style: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'jumpserver-config.css')
  };
}

export function renderJumpServerConfigBody(settings?: JumpServerSettings): string {
  return `<main class="config-shell">
  <form id="configForm" class="config-form">
    <label>Base URL<input name="baseUrl" required value="${escapeAttr(settings?.baseUrl ?? '')}" /></label>
    <label>Org ID<input name="orgId" value="${escapeAttr(settings?.orgId ?? '')}" /></label>
    <label>Username<input name="username" required value="${escapeAttr(settings?.username ?? '')}" /></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" /></label>
    <label class="config-row"><input name="verifyTls" type="checkbox" ${settings?.verifyTls === false ? '' : 'checked'} /> Verify TLS</label>
    <label>Connect Timeout<input name="connectTimeout" type="number" min="1" max="120" value="${settings?.connectTimeout ?? 30}" /></label>
    <button type="submit">Save</button>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
```

- [ ] **Step 4: Implement config webview frontend**

Create `webview/jumpserver-config/index.ts`:

```ts
const vscode = acquireVsCodeApi();
const form = document.getElementById('configForm') as HTMLFormElement;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  vscode.postMessage({
    type: 'save',
    payload: {
      baseUrl: String(data.get('baseUrl') || ''),
      orgId: String(data.get('orgId') || ''),
      username: String(data.get('username') || ''),
      password: String(data.get('password') || ''),
      verifyTls: data.get('verifyTls') === 'on',
      connectTimeout: Number(data.get('connectTimeout') || 30)
    }
  });
});
```

Create `webview/jumpserver-config/index.css`:

```css
body {
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
}

.config-shell {
  padding: 20px;
  max-width: 560px;
}

.config-form {
  display: grid;
  gap: 12px;
}

label {
  display: grid;
  gap: 6px;
}

input {
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  padding: 6px 8px;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

button {
  width: fit-content;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: 0;
  padding: 7px 14px;
}
```

- [ ] **Step 5: Update esbuild to emit config CSS**

Add this context to `esbuild.config.mjs`:

```js
esbuild.context({
  ...common,
  entryPoints: ['webview/jumpserver-config/index.css'],
  outfile: 'dist/webview/jumpserver-config.css',
  bundle: true,
  loader: { '.css': 'css' }
})
```

- [ ] **Step 6: Run webview tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/webview/JumpServerConfigPanel.test.ts test/webview/html.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit config webview slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\webview webview\jumpserver-config esbuild.config.mjs test\webview
git commit -m "feat: add JumpServer configuration panel"
```

Expected: commit created.

---

### Task 9: Wire Extension Commands And Asset Refresh

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\src\extension.ts`
- Test: `C:\Users\alan\Desktop\jumpserver-plugins\test\extension\ExtensionCommands.test.ts`

- [ ] **Step 1: Write failing command wiring test**

Create `test/extension/ExtensionCommands.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';

beforeEach(() => {
  deactivate();
  vi.clearAllMocks();
});

describe('extension command wiring', () => {
  it('registers JumpServer-only commands and asset tree view', () => {
    const context = {
      globalState: { get: vi.fn((_key, fallback) => fallback), update: vi.fn() },
      secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
      subscriptions: [],
      extensionUri: vscode.Uri.file('extension-root')
    } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(vscode.window.createTreeView).toHaveBeenCalledWith('jumpserverManager.assets', expect.any(Object));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.configure', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.validate', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.connect', expect.any(Function));
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('sshManager.connect', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run command test and verify it fails**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/extension/ExtensionCommands.test.ts
```

Expected: FAIL because extension still has old SSH wiring or missing JumpServer wiring.

- [ ] **Step 3: Replace extension activation with JumpServer-only wiring**

Use this structure in `src/extension.ts`:

```ts
import * as vscode from 'vscode';
import { JumpServerConfigManager } from './config/JumpServerConfigManager';
import { JumpServerClient } from './jumpserver/JumpServerClient';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { JumpServerTreeProvider } from './tree/JumpServerTreeProvider';
import { AssetTreeItem } from './tree/TreeItems';
import { errorMessage } from './jumpserver/redaction';
import { JumpServerConfigPanel } from './webview/JumpServerConfigPanel';
import { TerminalPanel } from './webview/TerminalPanel';
import { showTimedNotification } from './utils/notifications';

let extensionCleanup: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new JumpServerConfigManager(context.globalState, context.secrets);
  const terminalContext = new TerminalContextRegistry();
  const treeProvider = new JumpServerTreeProvider(configManager);
  let disposed = false;

  const cleanup = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      TerminalPanel.disconnectAll();
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
    }
  };
  extensionCleanup = cleanup;

  context.subscriptions.push(
    vscode.window.createTreeView('jumpserverManager.assets', {
      treeDataProvider: treeProvider,
      showCollapseAll: true
    }),
    cleanup,
    vscode.commands.registerCommand('jumpserverManager.configure', () => {
      void JumpServerConfigPanel.open(context, configManager);
    }),
    vscode.commands.registerCommand('jumpserverManager.validate', async () => {
      await runCommand(async () => {
        const client = await createClient(configManager);
        await client.ensureAuthToken();
        await client.listAssets({ limit: 1, offset: 0 });
        await showTimedNotification('JumpServer account verified.');
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.refresh', async () => {
      await runCommand(async () => {
        const client = await createClient(configManager);
        const assets = await client.listAssets({ limit: 200, offset: 0 });
        await configManager.saveCachedAssets(assets);
        treeProvider.refresh();
        await showTimedNotification(`JumpServer assets refreshed: ${assets.length}`);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.connect', async (item?: AssetTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const client = await createClient(configManager);
        TerminalPanel.open(context, item.asset, client, terminalContext);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.disconnect', () => {
      TerminalPanel.getActive()?.disconnect();
    }),
    vscode.commands.registerCommand('jumpserverManager.reconnect', async () => {
      await TerminalPanel.getActive()?.reconnect();
    })
  );
}

export function deactivate(): void {
  extensionCleanup?.dispose();
  TerminalPanel.disconnectAll();
}

async function createClient(configManager: JumpServerConfigManager): Promise<JumpServerClient> {
  const settings = await configManager.requireSettings();
  const password = await configManager.requirePassword();
  return new JumpServerClient({ ...settings, password });
}

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    await showTimedNotification(errorMessage(error), 'error');
  }
}
```

- [ ] **Step 4: Run command wiring test**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test -- test/extension/ExtensionCommands.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all unit tests**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test
```

Expected: PASS. Remove stale tests for deleted SSH/SFTP/MCP modules from the copied test tree if they still run.

- [ ] **Step 6: Commit extension wiring**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add src\extension.ts test\extension
git commit -m "feat: wire JumpServer extension commands"
```

Expected: commit created.

---

### Task 10: Build, Package, README, And Manual Verification

**Files:**
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\README.md`
- Modify: `C:\Users\alan\Desktop\jumpserver-plugins\.vscodeignore`
- Verify: `C:\Users\alan\Desktop\jumpserver-plugins\dist\extension.js`

- [ ] **Step 1: Write README content**

Replace `README.md` with:

```md
# AT JumpServer Terminal

AT JumpServer Terminal is a VS Code extension for opening browser-style JumpServer SSH terminal sessions from the editor.

## Supported In This Version

- Username and password login to JumpServer
- Listing the current user's permitted assets
- SSH protocol assets
- xterm.js terminal UI
- JumpServer KoKo WebSocket terminal sessions

## Not Supported In This Version

- Ahell backend integration
- Direct SSH through ssh2
- SFTP or remote file editing
- MCP and Agent tools
- RDP, database, Kubernetes, or non-SSH JumpServer assets
- SSO, MFA, captcha, private token, or access key login

## Setup

1. Open the AT JumpServer activity bar.
2. Run `JumpServer: Configure`.
3. Enter JumpServer base URL, username, password, optional org ID, TLS verification, and timeout.
4. Run `JumpServer: Validate Account`.
5. Run `JumpServer: Refresh Assets`.
6. Click an asset to connect.

## Development

```powershell
npm install
npm test
npm run typecheck
npm run build
```

## Manual Verification

- Configure a real JumpServer account.
- Refresh assets and verify node or zone grouping.
- Connect to an SSH asset.
- Run `whoami`, `pwd`, and `ls`.
- Resize the terminal.
- Disconnect and reconnect.
- Verify bad password and non-SSH assets show clear errors.
```

- [ ] **Step 2: Update `.vscodeignore`**

Ensure `.vscodeignore` contains:

```gitignore
.git/**
.superpowers/**
.worktrees/**
node_modules/**
src/**
test/**
webview/**
*.vsix
*.log
```

Do not ignore `dist/**`, `media/**`, `README.md`, `package.json`, or `package-lock.json`.

- [ ] **Step 3: Run full verification**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm test
npm run typecheck
npm run build
```

Expected: all commands pass and `dist\extension.js`, `dist\webview\terminal.js`, `dist\webview\terminal.css`, `dist\webview\jumpserver-config.js`, and `dist\webview\jumpserver-config.css` exist.

- [ ] **Step 4: Package VSIX**

If `vsce` is not installed locally, run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
npm install --save-dev @vscode/vsce
npx vsce package
```

Expected: a `.vsix` file named like `at-jumpserver-terminal-0.1.0.vsix` is created.

- [ ] **Step 5: Manual verification in VS Code**

Run:

```powershell
code --install-extension C:\Users\alan\Desktop\jumpserver-plugins\at-jumpserver-terminal-0.1.0.vsix
```

Then verify:

- `AT JumpServer` appears in the activity bar.
- `JumpServer: Configure` opens the config form.
- Saving config does not display or persist the password in globalState.
- `JumpServer: Validate Account` succeeds against a real JumpServer.
- `JumpServer: Refresh Assets` populates the tree.
- Clicking an SSH asset opens the unchanged terminal UI.
- `whoami`, `pwd`, and `ls` work.
- Resize works.
- Disconnect and reconnect work.

- [ ] **Step 6: Commit release-prep slice**

Run:

```powershell
cd C:\Users\alan\Desktop\jumpserver-plugins
git add README.md .vscodeignore package.json package-lock.json dist
git commit -m "docs: add JumpServer plugin usage guide"
```

Expected: commit created with docs, packaging metadata, and built assets if this plugin commits `dist`.

---

## Final Verification Checklist

- [ ] `npm test` passes in `C:\Users\alan\Desktop\jumpserver-plugins`.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] Manifest contains no SSH/SFTP/MCP/Agent commands.
- [ ] User-facing commands use `jumpserverManager.*`.
- [ ] Password is stored only in SecretStorage.
- [ ] Bearer token, cookies, and connection token are memory-only.
- [ ] Asset tree groups by `nodePath`, then `zoneName`, then `Default`.
- [ ] Connection flow uses JumpServer REST auth, asset detail, connection-token, smart endpoint, KoKo warmup, and KoKo WebSocket.
- [ ] No target account selection UI exists.
- [ ] Non-SSH assets are blocked with a clear error.
- [ ] Terminal webview UI remains the copied AT Terminal xterm UI.

## Execution Notes

- Implement in `C:\Users\alan\Desktop\jumpserver-plugins`, not in the Ahell backend.
- Keep commits small and in the order above.
- When tests expose copied SSH/SFTP/MCP references, remove the unsupported copied code or tests instead of adapting unsupported features.
- Do not add SFTP, MCP, Agent, RDP, database, Kubernetes, SSO, MFA, private token, or access key support in this implementation pass.
