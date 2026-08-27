import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const terminalPanelMock = vi.hoisted(() => ({
  open: vi.fn(),
  getActive: vi.fn(),
  disconnectAll: vi.fn(),
  disposeSessionsForBastion: vi.fn((): string[] => [])
}));

const configPanelMock = vi.hoisted(() => ({
  open: vi.fn()
}));

const notificationsMock = vi.hoisted(() => ({
  showTimedNotification: vi.fn()
}));

const jumpServerClientMock = vi.hoisted(() => ({
  calls: [] as string[],
  ensureAuthToken: vi.fn(),
  healthCheck: vi.fn(),
  getUserProfile: vi.fn(),
  listAccessibleOrgs: vi.fn(),
  getCurrentOrg: vi.fn(),
  setOrgId: vi.fn(),
  listAssetNodes: vi.fn(),
  listAssets: vi.fn(),
  listAllAssets: vi.fn(),
  getAssetDetail: vi.fn(),
  ensureWebSession: vi.fn(),
  openKokoSftpWebSocket: vi.fn(),
  JumpServerClient: vi.fn()
}));

const sftpManagerMock = vi.hoisted(() => ({
  JumpServerSftpManager: vi.fn(),
  openAsset: vi.fn(),
  listDirectory: vi.fn(),
  refreshDirectory: vi.fn(),
  getState: vi.fn(),
  changeToParentDirectory: vi.fn(),
  changeDirectory: vi.fn(),
  mkdir: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteEntry: vi.fn(),
  getActiveConnectionKey: vi.fn(),
  rename: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  selectTerminal: vi.fn(),
  removeTerminal: vi.fn(),
  dispose: vi.fn()
}));

const bridgeServerMock = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined)
}));

const mcpLifecycleMock = vi.hoisted(() => ({
  syncPackagedHub: vi.fn(async () => ({ updated: false, activeVersion: '0.1.0' })),
  ensureAtSeriesConfigForCurrentIde: vi.fn(async () => ({ updated: true })),
  uninstallAtSeriesConfigForCurrentIde: vi.fn(async () => ({ removed: true }))
}));

vi.mock('../../src/jumpserver/JumpServerClient', async (importOriginal) => ({
  // Keep the real pure helpers so the refresh command exercises the actual
  // node-tree-to-path derivation rather than a stub of it.
  ...await importOriginal<typeof import('../../src/jumpserver/JumpServerClient')>(),
  JumpServerClient: jumpServerClientMock.JumpServerClient
}));

vi.mock('../../src/sftp/JumpServerSftpManager', () => ({
  JumpServerSftpManager: sftpManagerMock.JumpServerSftpManager
}));

vi.mock('../../src/webview/TerminalPanel', () => ({
  TerminalPanel: terminalPanelMock
}));

vi.mock('../../src/webview/JumpServerConfigPanel', () => ({
  JumpServerConfigPanel: configPanelMock
}));

vi.mock('../../src/utils/notifications', () => ({
  showTimedNotification: notificationsMock.showTimedNotification
}));

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: vi.fn().mockImplementation(() => ({
    start: bridgeServerMock.start,
    dispose: bridgeServerMock.dispose
  }))
}));

vi.mock('../../src/mcp/hubSync', () => ({
  syncPackagedHub: mcpLifecycleMock.syncPackagedHub
}));

vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureAtSeriesConfigForCurrentIde: mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde: mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde
}));

import { activate, deactivate } from '../../src/extension';
import { JumpServerConfigManager } from '../../src/config/JumpServerConfigManager';
import type { CachedJumpServerAsset, JumpServerBastion } from '../../src/config/schema';
import { BastionTreeItem } from '../../src/tree/BastionTreeItem';
import { AssetTreeItem } from '../../src/tree/TreeItems';

const PROD_BASTION_ID = '11111111-1111-1111-1111-111111111111';
const TEST_BASTION_ID = '22222222-2222-2222-2222-222222222222';

function prodBastion(overrides: Partial<JumpServerBastion> = {}): JumpServerBastion {
  return {
    id: PROD_BASTION_ID,
    name: 'Prod JMS',
    baseUrl: 'https://prod.example.com',
    orgId: '',
    username: 'alan',
    verifyTls: true,
    updatedAt: 1,
    ...overrides
  };
}

function testBastion(overrides: Partial<JumpServerBastion> = {}): JumpServerBastion {
  return {
    id: TEST_BASTION_ID,
    name: 'Test JMS',
    baseUrl: 'https://test.example.com',
    orgId: '',
    username: 'alan',
    verifyTls: true,
    updatedAt: 1,
    ...overrides
  };
}

function contextWithBastions(
  bastions: JumpServerBastion[],
  passwords: Record<string, string> = Object.fromEntries(bastions.map((bastion) => [bastion.id, 'secret']))
): vscode.ExtensionContext {
  const data = new Map<string, unknown>([
    ['jumpserverManager.bastions', bastions]
  ]);
  return {
    globalState: {
      get: vi.fn((key, fallback) => data.has(key) ? data.get(key) : fallback),
      update: vi.fn(async (key, value) => {
        data.set(key, value);
      })
    },
    secrets: {
      get: vi.fn(async (key: string) => {
        const prefix = 'jumpserverManager.password.';
        if (key.startsWith(prefix)) {
          return passwords[key.slice(prefix.length)];
        }
        return undefined;
      }),
      store: vi.fn(),
      delete: vi.fn()
    },
    subscriptions: [],
    extensionUri: vscode.Uri.file('extension-root')
  } as unknown as vscode.ExtensionContext;
}

function emptyContext(): vscode.ExtensionContext {
  return contextWithBastions([]);
}

function sshAsset(overrides: Partial<CachedJumpServerAsset> = {}): CachedJumpServerAsset {
  return {
    id: 'server-1',
    name: 'uat-service',
    address: '10.0.0.11',
    platform: 'Linux',
    category: 'host',
    type: 'server',
    zoneName: '',
    nodePath: [],
    protocolNames: ['ssh'],
    bastionId: PROD_BASTION_ID,
    raw: {},
    ...overrides
  };
}

function contextWithSettings(orgId = ''): vscode.ExtensionContext {
  const data = new Map<string, unknown>([
    ['jumpserverManager.settings', {
      baseUrl: 'https://jumpserver.example.com',
      orgId,
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    }]
  ]);
  return {
    globalState: {
      get: vi.fn((key, fallback) => data.has(key) ? data.get(key) : fallback),
      update: vi.fn(async (key, value) => {
        data.set(key, value);
      })
    },
    secrets: { get: vi.fn(async () => 'secret'), store: vi.fn(), delete: vi.fn() },
    subscriptions: [],
    extensionUri: vscode.Uri.file('extension-root')
  } as unknown as vscode.ExtensionContext;
}

function registeredCommand(commandId: string): (...args: any[]) => Promise<void> {
  return vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === commandId)?.[1] as (...args: any[]) => Promise<void>;
}

beforeEach(() => {
  deactivate();
  vi.clearAllMocks();
  jumpServerClientMock.calls.length = 0;
  jumpServerClientMock.ensureAuthToken.mockResolvedValue('token-1');
  jumpServerClientMock.ensureWebSession.mockResolvedValue(undefined);
  jumpServerClientMock.healthCheck.mockResolvedValue({ skipped: true });
  jumpServerClientMock.getUserProfile.mockResolvedValue({ id: 'user-1', username: 'alan' });
  jumpServerClientMock.listAccessibleOrgs.mockResolvedValue([
    { id: '00000000-0000-0000-0000-000000000002', name: 'Default' }
  ]);
  jumpServerClientMock.getCurrentOrg.mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000002',
    name: 'Default'
  });
  jumpServerClientMock.listAssetNodes.mockImplementation(async () => {
    jumpServerClientMock.calls.push('nodes');
    return [{ id: 'node-default', name: 'DEFAULT', path: ['DEFAULT'], assetIds: ['asset-1'], bastionId: 'b1', raw: {} }];
  });
  jumpServerClientMock.listAssets.mockImplementation(async () => {
    jumpServerClientMock.calls.push('assets');
    return [{ id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'DEFAULT', nodePath: ['DEFAULT'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} }];
  });
  jumpServerClientMock.listAllAssets.mockImplementation(async () => {
    jumpServerClientMock.calls.push('assets');
    return {
      assets: [{ id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'DEFAULT', nodePath: ['DEFAULT'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} }],
      total: 1,
      truncated: false
    };
  });
  terminalPanelMock.open.mockClear();
  terminalPanelMock.open.mockReturnValue({ getTerminalId: () => 'terminal-opened-1' });
  terminalPanelMock.getActive.mockReturnValue(undefined);
  terminalPanelMock.disconnectAll.mockClear();
  terminalPanelMock.disposeSessionsForBastion.mockReset();
  terminalPanelMock.disposeSessionsForBastion.mockReturnValue([]);
  configPanelMock.open.mockReset();
  notificationsMock.showTimedNotification.mockResolvedValue(undefined);
  sftpManagerMock.openAsset.mockImplementation(async (asset) => {
    sftpManagerMock.getState.mockReturnValue({ kind: 'active', asset, rootPath: '/' });
  });
  sftpManagerMock.listDirectory.mockResolvedValue([]);
  sftpManagerMock.refreshDirectory.mockResolvedValue([]);
  sftpManagerMock.getState.mockReturnValue({ kind: 'none' });
  sftpManagerMock.changeToParentDirectory.mockResolvedValue('/');
  sftpManagerMock.changeDirectory.mockResolvedValue('/');
  sftpManagerMock.mkdir.mockResolvedValue(undefined);
  sftpManagerMock.uploadFile.mockResolvedValue(undefined);
  sftpManagerMock.downloadFile.mockResolvedValue(undefined);
  sftpManagerMock.deleteEntry.mockResolvedValue(undefined);
  sftpManagerMock.getActiveConnectionKey.mockReturnValue('terminal-1');
  sftpManagerMock.rename.mockResolvedValue(undefined);
  sftpManagerMock.readFile.mockResolvedValue(Buffer.from('hello'));
  sftpManagerMock.stat.mockResolvedValue({ size: 5, modifiedAt: 1 });
  sftpManagerMock.JumpServerSftpManager.mockImplementation(() => ({
    openAsset: sftpManagerMock.openAsset,
    listDirectory: sftpManagerMock.listDirectory,
    refreshDirectory: sftpManagerMock.refreshDirectory,
    getState: sftpManagerMock.getState,
    changeToParentDirectory: sftpManagerMock.changeToParentDirectory,
    changeDirectory: sftpManagerMock.changeDirectory,
    mkdir: sftpManagerMock.mkdir,
    uploadFile: sftpManagerMock.uploadFile,
    downloadFile: sftpManagerMock.downloadFile,
    deleteEntry: sftpManagerMock.deleteEntry,
    getActiveConnectionKey: sftpManagerMock.getActiveConnectionKey,
    rename: sftpManagerMock.rename,
    readFile: sftpManagerMock.readFile,
    stat: sftpManagerMock.stat,
    selectTerminal: sftpManagerMock.selectTerminal,
    removeTerminal: sftpManagerMock.removeTerminal,
    dispose: sftpManagerMock.dispose
  }));
  jumpServerClientMock.JumpServerClient.mockImplementation(() => ({
    ensureAuthToken: jumpServerClientMock.ensureAuthToken,
    healthCheck: jumpServerClientMock.healthCheck,
    getUserProfile: jumpServerClientMock.getUserProfile,
    listAccessibleOrgs: jumpServerClientMock.listAccessibleOrgs,
    getCurrentOrg: jumpServerClientMock.getCurrentOrg,
    setOrgId: jumpServerClientMock.setOrgId,
    listAssetNodes: jumpServerClientMock.listAssetNodes,
    listAssets: jumpServerClientMock.listAssets,
    listAllAssets: jumpServerClientMock.listAllAssets,
    getAssetDetail: jumpServerClientMock.getAssetDetail,
    ensureWebSession: jumpServerClientMock.ensureWebSession,
    openKokoSftpWebSocket: jumpServerClientMock.openKokoSftpWebSocket
  }));
  mcpLifecycleMock.syncPackagedHub.mockClear();
  mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde.mockClear();
  mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde.mockClear();
  bridgeServerMock.start.mockClear();
  bridgeServerMock.dispose.mockClear();
  delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;

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
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('jumpserverManager.sftpFiles', expect.any(Object));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.configure', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.addBastion', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.removeBastion', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.refreshBastion', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.editBastion', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.validate', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.connect', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.copyHostIp', expect.any(Function));
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('sshManager.connect', expect.any(Function));
  });

  it('copies the selected asset host IP', async () => {
    activate(contextWithSettings());
    const copyHostIp = registeredCommand('jumpserverManager.copyHostIp');

    await copyHostIp({ asset: { address: '10.0.0.11' } });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('10.0.0.11');
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('warns without changing the clipboard when the asset host IP is empty', async () => {
    activate(contextWithSettings());
    const copyHostIp = registeredCommand('jumpserverManager.copyHostIp');

    await copyHostIp({ asset: { address: '' } });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Host IP is not available.');
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('warns without changing the clipboard when the command argument is invalid', async () => {
    activate(contextWithSettings());
    const copyHostIp = registeredCommand('jumpserverManager.copyHostIp');

    await copyHostIp(undefined);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Host IP is not available.');
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('registers JumpServer SFTP file commands', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('jumpserverManager.sftp.open', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.upload', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.download', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.preview', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.edit', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.delete', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.rename', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.newFolder', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.copyPath', expect.any(Function));
  });

  it('registers JumpServer MCP install and uninstall commands', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.installMcpConfig', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.uninstallAtSeriesMcpConfig', expect.any(Function));
  });

  it('syncs packaged hub and ensures AT Series MCP config on activation', async () => {
    const context = contextWithSettings();
    activate(context);

    await vi.waitFor(() => {
      expect(mcpLifecycleMock.syncPackagedHub).toHaveBeenCalledOnce();
      expect(bridgeServerMock.start).toHaveBeenCalledOnce();
      expect(mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
        appName: vscode.env.appName,
        appRoot: vscode.env.appRoot,
        uriScheme: vscode.env.uriScheme,
        extensionPath: 'extension-root',
        workspaceFolder: undefined
      });
    });
  });

  it('does not sync the hub, start the bridge, or write MCP config without bastions', async () => {
    activate(emptyContext());

    // Flush the fire-and-forget activation gate (microtasks only).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mcpLifecycleMock.syncPackagedHub).not.toHaveBeenCalled();
    expect(bridgeServerMock.start).not.toHaveBeenCalled();
    expect(mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde).not.toHaveBeenCalled();
  });

  it('starts the MCP runtime once after the first successful bastion refresh', async () => {
    const context = contextWithBastions([prodBastion()]);
    // The activation gate sees no bastions; the user "adds" one afterwards.
    const listSpy = vi
      .spyOn(JumpServerConfigManager.prototype, 'listBastions')
      .mockResolvedValueOnce([]);
    try {
      activate(context);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(bridgeServerMock.start).not.toHaveBeenCalled();
      expect(mcpLifecycleMock.syncPackagedHub).not.toHaveBeenCalled();

      await registeredCommand('jumpserverManager.refreshBastion')(new BastionTreeItem(prodBastion()));

      await vi.waitFor(() => {
        expect(bridgeServerMock.start).toHaveBeenCalledTimes(1);
        expect(mcpLifecycleMock.syncPackagedHub).toHaveBeenCalledTimes(1);
      });

      // Idempotent: a second refresh must not start a second runtime.
      await registeredCommand('jumpserverManager.refreshBastion')(new BastionTreeItem(prodBastion()));
      await new Promise((resolve) => setImmediate(resolve));
      expect(bridgeServerMock.start).toHaveBeenCalledTimes(1);
      expect(mcpLifecycleMock.syncPackagedHub).toHaveBeenCalledTimes(1);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('forces a full hub sync when the user repairs the MCP config', async () => {
    activate(contextWithSettings());

    await registeredCommand('jumpserverManager.installMcpConfig')();

    expect(mcpLifecycleMock.syncPackagedHub).toHaveBeenCalledWith(
      expect.anything(),
      { force: true }
    );
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'AT Series MCP config installed/repaired.'
    );
  });

  it('dispose unpublishes bridge without uninstalling MCP config', async () => {
    const context = contextWithSettings();
    activate(context);
    await vi.waitFor(() => {
      expect(bridgeServerMock.start).toHaveBeenCalled();
    });

    mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde.mockClear();
    bridgeServerMock.dispose.mockClear();
    deactivate();

    expect(bridgeServerMock.dispose).toHaveBeenCalled();
    expect(mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde).not.toHaveBeenCalled();
  });

  it('does not register a standalone SFTP open command from the asset list', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('jumpserverManager.sftp.open', expect.any(Function));
  });

  it('automatically opens the SFTP file tree when connecting an SSH asset', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = { asset: sshAsset() };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(sftpManagerMock.openAsset).toHaveBeenCalledWith(item.asset, expect.any(String));
  });

  it('prefetches asset detail and warms the web session once the bastion has a live client', async () => {
    vi.useFakeTimers();
    try {
      jumpServerClientMock.getAssetDetail.mockResolvedValue({ id: 'server-1' });
      activate(contextWithBastions([prodBastion()]));
      // Prefetch never builds a client of its own; give the pool one first.
      await registeredCommand('jumpserverManager.connect')({ asset: sshAsset() });
      const assetsView = vi.mocked(vscode.window.createTreeView).mock.results[0]?.value as {
        onDidChangeSelection: ReturnType<typeof vi.fn>;
      };
      const handler = assetsView.onDidChangeSelection.mock.calls[0]?.[0] as
        | ((event: { selection: unknown[] }) => void)
        | undefined;
      expect(handler).toEqual(expect.any(Function));

      handler?.({ selection: [new AssetTreeItem(sshAsset())] });
      expect(jumpServerClientMock.getAssetDetail).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(jumpServerClientMock.getAssetDetail).toHaveBeenCalledWith('server-1');
      expect(jumpServerClientMock.ensureWebSession).toHaveBeenCalledTimes(1);
      expect(notificationsMock.showTimedNotification).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the prefetch entirely when the bastion has no live client yet', async () => {
    vi.useFakeTimers();
    try {
      activate(contextWithBastions([prodBastion()]));
      const assetsView = vi.mocked(vscode.window.createTreeView).mock.results[0]?.value as {
        onDidChangeSelection: ReturnType<typeof vi.fn>;
      };
      const handler = assetsView.onDidChangeSelection.mock.calls[0]?.[0] as
        | ((event: { selection: unknown[] }) => void)
        | undefined;

      handler?.({ selection: [new AssetTreeItem(sshAsset())] });
      await vi.runAllTimersAsync();

      // Browsing the tree must not pay a REST login just to warm a cache.
      expect(jumpServerClientMock.JumpServerClient).not.toHaveBeenCalled();
      expect(jumpServerClientMock.getAssetDetail).not.toHaveBeenCalled();
      expect(jumpServerClientMock.ensureWebSession).not.toHaveBeenCalled();
      expect(notificationsMock.showTimedNotification).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses rapid selection changes into one prefetch for the last asset', async () => {
    vi.useFakeTimers();
    try {
      jumpServerClientMock.getAssetDetail.mockResolvedValue({ id: 'server-2' });
      activate(contextWithBastions([prodBastion()]));
      await registeredCommand('jumpserverManager.connect')({ asset: sshAsset() });
      const assetsView = vi.mocked(vscode.window.createTreeView).mock.results[0]?.value as {
        onDidChangeSelection: ReturnType<typeof vi.fn>;
      };
      const handler = assetsView.onDidChangeSelection.mock.calls[0]?.[0] as
        | ((event: { selection: unknown[] }) => void)
        | undefined;

      handler?.({ selection: [new AssetTreeItem(sshAsset({ id: 'server-1' }))] });
      handler?.({ selection: [new AssetTreeItem(sshAsset({ id: 'server-2' }))] });
      await vi.runAllTimersAsync();

      expect(jumpServerClientMock.getAssetDetail).toHaveBeenCalledTimes(1);
      expect(jumpServerClientMock.getAssetDetail).toHaveBeenCalledWith('server-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not toast when asset detail prefetch fails', async () => {
    vi.useFakeTimers();
    try {
      jumpServerClientMock.getAssetDetail.mockRejectedValue(new Error('offline'));
      activate(contextWithBastions([prodBastion()]));
      await registeredCommand('jumpserverManager.connect')({ asset: sshAsset() });
      const assetsView = vi.mocked(vscode.window.createTreeView).mock.results[0]?.value as {
        onDidChangeSelection: ReturnType<typeof vi.fn>;
      };
      const handler = assetsView.onDidChangeSelection.mock.calls[0]?.[0] as
        | ((event: { selection: unknown[] }) => void)
        | undefined;

      handler?.({ selection: [new AssetTreeItem(sshAsset())] });
      await vi.runAllTimersAsync();
      expect(jumpServerClientMock.getAssetDetail).toHaveBeenCalledWith('server-1');
      expect(notificationsMock.showTimedNotification).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches the SFTP file tree when the active terminal changes', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    await connectCommand({
      asset: sshAsset({ id: 'asset-1', name: 'asset-1', address: '' })
    });
    const registry = terminalPanelMock.open.mock.calls[0]?.[3];

    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });
    registry.setActive({ terminalId: 'terminal-2', asset: { id: 'asset-2' }, connected: true, write: vi.fn() });
    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });
    // Re-activating the already-active terminal must not refresh the tree again.
    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });

    expect(sftpManagerMock.selectTerminal).toHaveBeenCalledTimes(3);
    expect(sftpManagerMock.selectTerminal).toHaveBeenNthCalledWith(1, 'terminal-1');
    expect(sftpManagerMock.selectTerminal).toHaveBeenNthCalledWith(2, 'terminal-2');
    expect(sftpManagerMock.selectTerminal).toHaveBeenNthCalledWith(3, 'terminal-1');
  });

  it('removes only the closed terminal SFTP connection', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    await connectCommand({
      asset: sshAsset({ id: 'asset-1', name: 'asset-1', address: '' })
    });
    const registry = terminalPanelMock.open.mock.calls[0]?.[3];

    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });
    registry.setActive({ terminalId: 'terminal-2', asset: { id: 'asset-2' }, connected: true, write: vi.fn() });
    registry.clearIfActive('terminal-2');

    expect(sftpManagerMock.removeTerminal).toHaveBeenCalledWith('terminal-2');
  });

  it('shows a clear prompt instead of an internal state error before an SFTP asset is open', async () => {
    const context = contextWithSettings();
    activate(context);
    const refreshFiles = registeredCommand('jumpserverManager.sftp.refresh');

    await refreshFiles();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Open files from a JumpServer asset first.', 'warning');
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith('No active JumpServer SFTP asset.', 'error');
  });

  it('refreshes JumpServer nodes before syncing assets', async () => {
    const data = new Map<string, unknown>([
      ['jumpserverManager.settings', {
        baseUrl: 'https://jumpserver.example.com',
        orgId: '',
        username: 'alan',
        verifyTls: true,
        updatedAt: 1
      }]
    ]);
    const context = {
      globalState: {
        get: vi.fn((key, fallback) => data.has(key) ? data.get(key) : fallback),
        update: vi.fn(async (key, value) => {
          data.set(key, value);
        })
      },
      secrets: { get: vi.fn(async () => 'secret'), store: vi.fn(), delete: vi.fn() },
      subscriptions: [],
      extensionUri: vscode.Uri.file('extension-root')
    } as unknown as vscode.ExtensionContext;

    activate(context);
    const refresh = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === 'jumpserverManager.refresh')?.[1] as () => Promise<void>;
    await refresh();

    expect(jumpServerClientMock.calls).toEqual(['nodes', 'assets']);
    expect(context.globalState.update).toHaveBeenCalledWith('jumpserverManager.cachedAssetNodes', expect.any(Array));
    expect(context.globalState.update).toHaveBeenCalledWith('jumpserverManager.cachedAssets', expect.any(Array));
  });

  it('hands the already-fetched node tree to the asset sync instead of refetching it', async () => {
    activate(contextWithSettings());
    const refresh = registeredCommand('jumpserverManager.refresh');

    await refresh();

    expect(jumpServerClientMock.listAssetNodes).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAllAssets).toHaveBeenCalledWith(
      expect.objectContaining({ treePaths: new Map([['asset-1', ['DEFAULT']]]) })
    );
  });

  it('caches every asset the bastion has instead of the first page', async () => {
    jumpServerClientMock.listAllAssets.mockResolvedValueOnce({
      assets: Array.from({ length: 640 }, (_unused, index) => ({
        id: `asset-${index}`,
        name: `host-${index}`,
        address: '10.0.0.1',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: 'DEFAULT',
        nodePath: ['DEFAULT'],
        protocolNames: ['ssh'],
        bastionId: 'b1', raw: {}
      })),
      total: 640,
      truncated: false
    });
    activate(contextWithSettings());

    await registeredCommand('jumpserverManager.refresh')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('JumpServer assets refreshed: 1 succeeded.');
  });

  it('says so out loud when the safety cap stopped the sync short', async () => {
    jumpServerClientMock.listAllAssets.mockResolvedValueOnce({ assets: [], total: 24_000, truncated: true });
    activate(contextWithSettings());

    await registeredCommand('jumpserverManager.refresh')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'JumpServer assets refreshed: 1 succeeded. JumpServer assets refreshed: 0 of 24000 (cache cap reached).',
      'warning'
    );
  });

  it('verifies the account against the user profile without pulling the whole node tree', async () => {
    const context = contextWithSettings();
    activate(context);
    const validate = registeredCommand('jumpserverManager.validate');

    await validate();

    expect(jumpServerClientMock.healthCheck).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.getUserProfile).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAccessibleOrgs).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
    expect(jumpServerClientMock.listAssets).not.toHaveBeenCalled();
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'JumpServer account verified. Organization: Default.'
    );
    expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000002');
    expect(context.globalState.update).toHaveBeenCalledWith(
      'jumpserverManager.bastions',
      [expect.objectContaining({ orgId: '00000000-0000-0000-0000-000000000002' })]
    );
  });

  it('asks the user to pick an organization when several are visible and none is saved', async () => {
    const context = contextWithSettings();
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'Prod',
      description: '11111111-1111-1111-1111-111111111111',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Prod'
    } as never);

    activate(context);
    await registeredCommand('jumpserverManager.validate')();

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(context.globalState.update).toHaveBeenCalledWith(
      'jumpserverManager.bastions',
      [expect.objectContaining({ orgId: '11111111-1111-1111-1111-111111111111' })]
    );
    expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it('stops validate when organization selection is cancelled', async () => {
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    activate(contextWithSettings());
    await registeredCommand('jumpserverManager.validate')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'Organization selection was cancelled.',
      'error'
    );
    expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
  });

  it('does not list assets when organization selection is cancelled on refresh', async () => {
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    activate(contextWithSettings());
    await registeredCommand('jumpserverManager.refresh')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'Organization selection was cancelled.',
      'error'
    );
    expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
    expect(jumpServerClientMock.listAllAssets).not.toHaveBeenCalled();
  });

  it('trusts the saved organization on validate without listing orgs', async () => {
    const context = contextWithSettings('33333333-3333-3333-3333-333333333333');

    activate(context);
    await registeredCommand('jumpserverManager.validate')();

    expect(jumpServerClientMock.listAccessibleOrgs).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
  });

  it('skips the org listing on refresh when the bastion already has a saved org', async () => {
    const savedOrgId = '44444444-4444-4444-4444-444444444444';
    activate(contextWithBastions([prodBastion({ orgId: savedOrgId })]));

    await registeredCommand('jumpserverManager.refresh')();

    expect(jumpServerClientMock.listAccessibleOrgs).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith(savedOrgId);
    expect(jumpServerClientMock.listAssetNodes).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAllAssets).toHaveBeenCalledTimes(1);
  });

  it('opens the unified terminal panel for MySQL assets', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: sshAsset({
        id: 'mysql-1',
        name: 'mysql-1',
        address: 'db.example.com',
        platform: 'MySQL',
        category: 'database',
        type: 'mysql',
        protocolNames: ['mysql']
      })
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith(expect.stringContaining('not supported'), 'error');
  });

  it('opens SSH server assets even when cached protocol names are missing', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = { asset: sshAsset({ protocolNames: [] }) };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith(expect.stringContaining('not supported'), 'error');
  });

  it('opens the unified terminal panel for Redis assets', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: sshAsset({
        id: 'redis-1',
        name: 'redis-1',
        address: 'redis.example.com',
        platform: 'Redis6+',
        category: 'database',
        type: 'redis',
        protocolNames: ['redis']
      })
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith(expect.stringContaining('not supported'), 'error');
  });

  it('keeps unsupported assets visible but shows an unsupported message instead of opening a terminal', async () => {
    const context = contextWithBastions([prodBastion()]);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: sshAsset({
        id: 'pg-1',
        name: 'pg-1',
        address: 'pg.example.com',
        platform: 'PostgreSQL',
        category: 'database',
        type: 'postgresql',
        protocolNames: []
      })
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).not.toHaveBeenCalled();
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Asset type is not supported yet: pg-1', 'error');
  });

  it('opens the add bastion panel when none are configured', async () => {
    activate(emptyContext());

    await registeredCommand('jumpserverManager.configure')();

    expect(configPanelMock.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { mode: 'add' }
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('refreshes every configured bastion independently', async () => {
    activate(contextWithBastions([prodBastion(), testBastion()]));

    await registeredCommand('jumpserverManager.refresh')();

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(2);
    expect(jumpServerClientMock.JumpServerClient.mock.calls.map(([settings]) => settings.baseUrl)).toEqual([
      'https://prod.example.com',
      'https://test.example.com'
    ]);
    expect(jumpServerClientMock.listAllAssets).toHaveBeenCalledTimes(2);
  });

  it('refreshes only the bastion from the tree item argument', async () => {
    activate(contextWithBastions([prodBastion(), testBastion()]));

    await registeredCommand('jumpserverManager.refreshBastion')(new BastionTreeItem(prodBastion()));

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.JumpServerClient.mock.calls[0][0].baseUrl).toBe('https://prod.example.com');
    expect(jumpServerClientMock.listAllAssets).toHaveBeenCalledTimes(1);
  });

  it('removes the picked bastion after confirm and disposes its sessions', async () => {
    const context = contextWithBastions([prodBastion(), testBastion()]);
    terminalPanelMock.disposeSessionsForBastion.mockReturnValue(['term-a', 'term-b']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'Test JMS',
      description: 'https://test.example.com',
      bastionId: TEST_BASTION_ID
    } as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Delete' as never);

    activate(context);
    await registeredCommand('jumpserverManager.removeBastion')();

    expect(context.globalState.get('jumpserverManager.bastions', [])).toHaveLength(1);
    expect(context.globalState.get<JumpServerBastion[]>('jumpserverManager.bastions', [])[0]?.id).toBe(PROD_BASTION_ID);
    expect(terminalPanelMock.disposeSessionsForBastion).toHaveBeenCalledWith(TEST_BASTION_ID);
    expect(sftpManagerMock.removeTerminal).toHaveBeenCalledWith('term-a');
    expect(sftpManagerMock.removeTerminal).toHaveBeenCalledWith('term-b');
  });

  it('validates only the picked bastion when several are configured', async () => {
    const context = contextWithBastions([prodBastion(), testBastion()]);
    let healthChecksDuringPick = 0;
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async () => {
      healthChecksDuringPick = jumpServerClientMock.healthCheck.mock.calls.length;
      return {
        label: 'Test JMS',
        description: 'https://test.example.com',
        bastionId: TEST_BASTION_ID
      } as never;
    });

    activate(context);
    await registeredCommand('jumpserverManager.validate')();

    expect(healthChecksDuringPick).toBe(0);
    expect(jumpServerClientMock.healthCheck).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.JumpServerClient.mock.calls[0][0].baseUrl).toBe('https://test.example.com');
    const saved = context.globalState.get<JumpServerBastion[]>('jumpserverManager.bastions', []);
    expect(saved.find((bastion) => bastion.id === PROD_BASTION_ID)?.orgId).toBe('');
    expect(saved.find((bastion) => bastion.id === TEST_BASTION_ID)?.orgId).toBe(
      '00000000-0000-0000-0000-000000000002'
    );
  });

  it('connects using the client for the asset bastion', async () => {
    activate(contextWithBastions([prodBastion(), testBastion()]));
    const connectCommand = registeredCommand('jumpserverManager.connect');

    await connectCommand({ asset: sshAsset({ id: 'prod-host', name: 'prod-host' }) });
    await connectCommand({
      asset: sshAsset({ id: 'test-host', name: 'test-host', bastionId: TEST_BASTION_ID })
    });

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(2);
    expect(jumpServerClientMock.JumpServerClient.mock.calls[0][0].baseUrl).toBe('https://prod.example.com');
    expect(jumpServerClientMock.JumpServerClient.mock.calls[1][0].baseUrl).toBe('https://test.example.com');
  });

  it('reuses one JumpServer client across connections to the same bastion', async () => {
    activate(contextWithBastions([prodBastion()]));
    const connectCommand = registeredCommand('jumpserverManager.connect');

    await connectCommand({ asset: sshAsset({ id: 'host-a', name: 'host-a' }) });
    await connectCommand({ asset: sshAsset({ id: 'host-b', name: 'host-b' }) });

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client when the stored password changes', async () => {
    const passwords = { [PROD_BASTION_ID]: 'secret' };
    activate(contextWithBastions([prodBastion()], passwords));
    const connectCommand = registeredCommand('jumpserverManager.connect');

    await connectCommand({ asset: sshAsset({ id: 'host-a', name: 'host-a' }) });
    passwords[PROD_BASTION_ID] = 'rotated';
    await connectCommand({ asset: sshAsset({ id: 'host-b', name: 'host-b' }) });

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(2);
  });

  it('forgets the cached client when the bastion is deleted', async () => {
    const context = contextWithBastions([prodBastion()]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Delete' as never);
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');

    await connectCommand({ asset: sshAsset() });
    await registeredCommand('jumpserverManager.removeBastion')();
    await context.globalState.update('jumpserverManager.bastions', [prodBastion()]);
    await connectCommand({ asset: sshAsset() });

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(2);
  });

  it('shares the bastion client with the SFTP session factory', async () => {
    let createSession: ((asset: CachedJumpServerAsset) => Promise<unknown>) | undefined;
    sftpManagerMock.JumpServerSftpManager.mockImplementation((options: {
      createSession?: (asset: CachedJumpServerAsset) => Promise<unknown>;
    }) => {
      createSession = options.createSession;
      return {
        openAsset: sftpManagerMock.openAsset,
        listDirectory: sftpManagerMock.listDirectory,
        refreshDirectory: sftpManagerMock.refreshDirectory,
        getState: sftpManagerMock.getState,
        changeToParentDirectory: sftpManagerMock.changeToParentDirectory,
        changeDirectory: sftpManagerMock.changeDirectory,
        mkdir: sftpManagerMock.mkdir,
        uploadFile: sftpManagerMock.uploadFile,
        downloadFile: sftpManagerMock.downloadFile,
        deleteEntry: sftpManagerMock.deleteEntry,
        getActiveConnectionKey: sftpManagerMock.getActiveConnectionKey,
        rename: sftpManagerMock.rename,
        readFile: sftpManagerMock.readFile,
        stat: sftpManagerMock.stat,
        selectTerminal: sftpManagerMock.selectTerminal,
        removeTerminal: sftpManagerMock.removeTerminal,
        dispose: sftpManagerMock.dispose
      };
    });
    activate(contextWithBastions([prodBastion()]));

    await registeredCommand('jumpserverManager.connect')({ asset: sshAsset() });
    await createSession?.(sshAsset());

    expect(jumpServerClientMock.JumpServerClient).toHaveBeenCalledTimes(1);
  });
});
