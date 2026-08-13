import * as vscode from 'vscode';
import { JumpServerAgentToolService } from './agent/JumpServerAgentToolService';
import { JumpServerConfigManager } from './config/JumpServerConfigManager';
import type { CachedJumpServerAsset } from './config/schema';
import { assetPathsFromNodes, JumpServerClient } from './jumpserver/JumpServerClient';
import { BridgeServer } from './mcp/BridgeServer';
import { syncPackagedHub } from './mcp/hubSync';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from './mcp/McpConfigInstaller';
import { detectHostApp } from '@at-series/mcp-hub';
import { assertTextFileEditable, DEFAULT_SFTP_EDIT_MAX_BYTES } from './sftp/SftpFileGuards';
import { createVscodeSftpEditUi, SftpEditSessionManager } from './sftp/SftpEditSessionManager';
import { JumpServerSftpManager } from './sftp/JumpServerSftpManager';
import { JumpServerSftpSession } from './sftp/JumpServerSftpSession';
import { JUMPSERVER_SFTP_PREVIEW_SCHEME, openRemotePreviewFile, SftpPreviewDocumentStore } from './sftp/SftpPreview';
import { dirname, joinRemotePath, remoteBasename } from './sftp/RemotePath';
import { VscodeTransferReporter } from './sftp/VscodeTransferReporter';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { JumpServerTreeProvider } from './tree/JumpServerTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from './tree/SftpTreeItems';
import { SftpTreeProvider } from './tree/SftpTreeProvider';
import { AssetTreeItem, getAssetOpenKind } from './tree/TreeItems';
import { log, setLogSink } from './utils/logger';
import { showTimedNotification } from './utils/notifications';
import { errorMessage } from './utils/redaction';
import { JumpServerConfigPanel } from './webview/JumpServerConfigPanel';
import { TerminalPanel } from './webview/TerminalPanel';

let extensionCleanup: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // A WebSocket terminal, a chunked SFTP transport, a local HTTP bridge and a
  // scoped cookie jar have no business failing into a toast that disappears
  // after five seconds. `log: true` gives the channel levels and timestamps,
  // and lets the user raise verbosity without a setting of ours.
  const logChannel = vscode.window.createOutputChannel('AT JumpServer Terminal', { log: true });
  setLogSink(logChannel);
  context.subscriptions.push(logChannel, { dispose: () => setLogSink(undefined) });

  const configManager = new JumpServerConfigManager(context.globalState, context.secrets);
  const terminalContext = new TerminalContextRegistry();
  const treeProvider = new JumpServerTreeProvider(configManager);
  const sftpManager = new JumpServerSftpManager({
    createSession: async (asset) => new JumpServerSftpSession({ asset, client: await createClient(configManager) }),
    reporter: new VscodeTransferReporter()
  });
  const sftpTreeProvider = new SftpTreeProvider({
    getState: () => sftpManager.getState(),
    listDirectory: (path) => sftpManager.listDirectory(path)
  });
  const sftpPreviewStore = new SftpPreviewDocumentStore();
  const sftpEditStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const sftpEditManager = new SftpEditSessionManager({
    storageUri: context.globalStorageUri ?? context.extensionUri,
    sftp: sftpManager,
    ui: createVscodeSftpEditUi(sftpEditStatus)
  });
  const hostEnv = {
    appName: vscode.env.appName,
    appRoot: vscode.env.appRoot,
    uriScheme: vscode.env.uriScheme,
    extensionPath: context.extensionUri.fsPath
  };
  const currentWorkspaceFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const agentService = new JumpServerAgentToolService({
    configManager,
    terminalContext,
    sftp: sftpManager,
    confirm: async (message) => {
      const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Continue');
      return answer === 'Continue';
    }
  });
  const hubReady = syncPackagedHub(context)
    .then((result) => {
      log.info(`hub sync ok (updated=${result.updated}, active=${result.activeVersion})`);
      return result;
    })
    .catch((error) => {
      log.error(`hub sync failed: ${errorMessage(error)}`);
      void showTimedNotification(
        `AT Series hub sync failed: ${errorMessage(error)}. MCP may not start until Repair succeeds.`,
        'warning'
      );
      throw error;
    });
  const bridgeServer = new BridgeServer({
    service: agentService,
    hostApp: detectHostApp(hostEnv),
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string'
        ? context.extension.packageJSON.version
        : undefined
  });
  void bridgeServer.start().catch((error) => {
    log.error(`MCP bridge failed to start: ${errorMessage(error)}`);
    void showTimedNotification(`JumpServer MCP bridge failed to start: ${errorMessage(error)}`, 'warning');
  });
  void hubReady
    .then(() =>
      ensureAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      })
    )
    .catch((error) => {
      void showTimedNotification(`AT Series MCP config could not be updated: ${errorMessage(error)}`, 'warning');
    });
  let disposed = false;

  const cleanup = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      sftpManager.dispose();
      sftpEditManager.dispose();
      void bridgeServer.dispose();
      TerminalPanel.disconnectAll();
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
    }
  };
  extensionCleanup = cleanup;

  context.subscriptions.push(
    terminalContext.onDidChangeActiveContext((activeContext) => {
      sftpManager.selectTerminal(activeContext?.terminalId);
      sftpTreeProvider.refresh();
    }),
    terminalContext.onDidRemoveContext((terminalId) => {
      sftpManager.removeTerminal(terminalId);
      sftpTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView('jumpserverManager.assets', {
      treeDataProvider: treeProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView('jumpserverManager.sftpFiles', {
      treeDataProvider: sftpTreeProvider,
      showCollapseAll: true
    }),
    sftpEditStatus,
    sftpEditManager,
    vscode.workspace.registerTextDocumentContentProvider(JUMPSERVER_SFTP_PREVIEW_SCHEME, sftpPreviewStore),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      void sftpPreviewStore.deletePreviewFilesForClosedTabs(event.closed);
    }),
    cleanup,
    vscode.commands.registerCommand('jumpserverManager.configure', () => {
      void JumpServerConfigPanel.open(context, configManager);
    }),
    vscode.commands.registerCommand('jumpserverManager.validate', async () => {
      await runCommand(async () => {
        const client = await createClient(configManager);
        await client.ensureAuthToken();
        // Verifying an account should not drag the whole node tree along.
        await client.getUserProfile();
        await showTimedNotification('JumpServer account verified.');
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.refresh', async () => {
      await runCommand(async () => {
        const client = await createClient(configManager);
        const nodes = await client.listAssetNodes();
        await configManager.saveCachedAssetNodes(nodes);
        treeProvider.refresh();
        const inventory = await client.listAllAssets({ treePaths: assetPathsFromNodes(nodes) });
        await configManager.saveCachedAssets(inventory.assets);
        treeProvider.refresh();
        // A silently short list is the failure this replaces, so say it out loud.
        await (inventory.truncated
          ? showTimedNotification(
              `JumpServer assets refreshed: ${inventory.assets.length} of ${inventory.total} (cache cap reached).`,
              'warning'
            )
          : showTimedNotification(`JumpServer assets refreshed: ${inventory.assets.length}`));
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.connect', async (item?: AssetTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const kind = getAssetOpenKind(item.asset);
        if (kind === 'unsupported') {
          await showTimedNotification(`Asset type is not supported yet: ${item.asset.name}`, 'error');
          return;
        }
        const client = await createClient(configManager);
        const terminal = TerminalPanel.open(context, item.asset, client, terminalContext);
        await tryOpenSftpFiles(sftpManager, sftpTreeProvider, item.asset, terminal.getTerminalId(), false);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.copyHostIp', async (item?: AssetTreeItem) => {
      const address = item?.asset?.address;
      if (!address) {
        await vscode.window.showWarningMessage('Host IP is not available.');
        return;
      }
      await runCommand(async () => {
        await vscode.env.clipboard.writeText(address);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.refresh', async () => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        await sftpManager.listDirectory();
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.goUp', async () => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        await sftpManager.changeToParentDirectory();
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.upload', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        const sources = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
        if (!sources?.length) {
          return;
        }
        const targetDirectory = getSftpTargetDirectory(sftpManager, item);
        for (const source of sources) {
          await sftpManager.uploadFile(source.fsPath, joinRemotePath(targetDirectory, localBasename(source.fsPath)));
        }
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.download', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(item.entry.name) });
        if (!target) {
          return;
        }
        await sftpManager.downloadFile(item.entry.path, target.fsPath, item.entry.type === 'directory');
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.preview', async (item?: SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        await ensurePreviewEditAllowed(sftpManager, item);
        await openRemotePreviewFile({
          storageUri: context.globalStorageUri ?? context.extensionUri,
          remotePath: item.entry.path,
          previewStore: sftpPreviewStore,
          downloadFile: (remotePath, localPath) => sftpManager.downloadFile(remotePath, localPath, false),
          openUri: async (uri, options) => {
            await vscode.commands.executeCommand('vscode.open', uri, options);
          }
        });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        await ensurePreviewEditAllowed(sftpManager, item);
        await sftpEditManager.openRemoteFile(item.entry.path);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.delete', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const answer = await vscode.window.showWarningMessage(`Delete ${item.entry.path}?`, { modal: true }, 'Delete');
        if (answer !== 'Delete') {
          return;
        }
        await sftpManager.deleteEntry(item.entry);
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.rename', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const nextName = await vscode.window.showInputBox({ prompt: 'New name', value: item.entry.name });
        if (!nextName || nextName === item.entry.name) {
          return;
        }
        await sftpManager.rename(item.entry.path, joinRemotePath(dirname(item.entry.path), nextName));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.newFolder', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
        if (!name) {
          return;
        }
        await sftpManager.mkdir(joinRemotePath(getSftpTargetDirectory(sftpManager, item), name));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.copyPath', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        await vscode.env.clipboard.writeText(item.entry.path);
        await showTimedNotification('Remote path copied.');
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.installMcpConfig', async () => {
      await runCommand(async () => {
        try {
          await syncPackagedHub(context);
        } catch (error) {
          await showTimedNotification(`AT Series hub sync failed: ${errorMessage(error)}`, 'error');
          return;
        }
        const result = await ensureAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        });
        if (result) {
          await showTimedNotification(
            result.updated ? 'AT Series MCP config installed/repaired.' : 'AT Series MCP config is already up to date.'
          );
          return;
        }
        await showTimedNotification(
          'No supported IDE MCP config target was detected. Open a workspace to install Continue config.',
          'warning'
        );
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.uninstallAtSeriesMcpConfig', async () => {
      await runCommand(async () => {
        const result = await uninstallAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        });
        if (result?.removed) {
          await showTimedNotification('AT Series MCP config uninstalled.');
          return;
        }
        if (result) {
          await showTimedNotification('AT Series MCP config was not present.');
          return;
        }
        await showTimedNotification(
          'No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.',
          'warning'
        );
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
    log.error(`command failed: ${errorMessage(error)}`);
    await showTimedNotification(errorMessage(error), 'error');
  }
}

function assetMaySupportSftp(asset: CachedJumpServerAsset): boolean {
  const protocols = asset.protocolNames.map((name) => name.toLowerCase());
  if (protocols.includes('sftp')) {
    return true;
  }
  if (protocols.length === 0 || protocols.includes('ssh')) {
    return getAssetOpenKind(asset) === 'ssh';
  }
  return false;
}

async function tryOpenSftpFiles(
  manager: JumpServerSftpManager,
  treeProvider: SftpTreeProvider,
  asset: CachedJumpServerAsset,
  terminalId: string,
  notifyErrors: boolean
): Promise<void> {
  if (!assetMaySupportSftp(asset)) {
    return;
  }
  try {
    await manager.openAsset(asset, terminalId);
    treeProvider.refresh();
  } catch (error) {
    if (notifyErrors) {
      throw error;
    }
    await showTimedNotification(`Files are not available for ${asset.name}: ${errorMessage(error)}`, 'warning');
  }
}

async function ensureSftpAssetOpen(manager: JumpServerSftpManager): Promise<boolean> {
  if (manager.getState().kind !== 'none') {
    return true;
  }
  await showTimedNotification('Open files from a JumpServer asset first.', 'warning');
  return false;
}

async function ensurePreviewEditAllowed(
  manager: JumpServerSftpManager,
  item: SftpFileTreeItem
): Promise<void> {
  if (!await ensureSftpAssetOpen(manager)) {
    throw new Error('Open files from a JumpServer asset first.');
  }
  const stat = item.entry.size === undefined
    ? await manager.stat(item.entry.path)
    : { size: item.entry.size, modifiedAt: item.entry.modifiedAt ?? 0 };
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size });
  const sample = await manager.readFile(item.entry.path, Math.min(DEFAULT_SFTP_EDIT_MAX_BYTES, Math.max(stat.size, 1)));
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size, sample });
}

function getSftpTargetDirectory(
  manager: JumpServerSftpManager,
  item?: SftpDirectoryTreeItem | SftpFileTreeItem
): string {
  if (item instanceof SftpDirectoryTreeItem) {
    return item.entry.path;
  }
  if (item instanceof SftpFileTreeItem) {
    return dirname(item.entry.path);
  }
  const state = manager.getState();
  if (state.kind === 'active' || state.kind === 'disconnected') {
    return state.rootPath;
  }
  throw new Error('No active JumpServer SFTP asset.');
}

function localBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || remoteBasename(path);
}
