import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { JumpServerAgentToolService } from './agent/JumpServerAgentToolService';
import { JumpServerConfigManager } from './config/JumpServerConfigManager';
import type { CachedJumpServerAsset, JumpServerBastion } from './config/schema';
import { assetPathsFromNodes, JumpServerClient } from './jumpserver/JumpServerClient';
import { JumpServerClientPool } from './jumpserver/JumpServerClientPool';
import { createWebSessionSecretStore } from './jumpserver/webSessionStore';
import { resolveOrgContext } from './jumpserver/orgContext';
import { confirmWithTimeout } from './mcp/confirmTimeout';
import type { McpRuntimeHandle } from './mcp/mcpRuntime';
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
import { t } from './i18n/t';

let extensionCleanup: { dispose(): void } | undefined;
let clientPool: JumpServerClientPool | undefined;

/**
 * Arrow-keying through the asset tree fires a selection change per row; only
 * the row the user settles on is worth a detail round-trip.
 */
export const ASSET_DETAIL_PREFETCH_DEBOUNCE_MS = 300;

export { MCP_CONFIRM_TIMEOUT_MS } from './mcp/confirmTimeout';

type McpRuntimeModule = typeof import('./mcp/mcpRuntime');

let mcpRuntimeModulePromise: Promise<McpRuntimeModule> | undefined;

/**
 * The MCP runtime (hub sync + bridge + installer, dragging in the whole
 * `@at-series/mcp-hub` package) lives in its own `dist/mcpRuntime.js` bundle
 * so `dist/extension.js` stays free of it. The fallback import keeps the
 * vitest harness working, where no dist bundle exists next to the running
 * code; esbuild marks that specifier external so it never re-inlines the hub.
 */
function loadMcpRuntimeModule(context: vscode.ExtensionContext): Promise<McpRuntimeModule> {
  mcpRuntimeModulePromise ??= (async () => {
    try {
      const nodeRequire = createRequire(__filename);
      return nodeRequire(context.asAbsolutePath(join('dist', 'mcpRuntime.js'))) as McpRuntimeModule;
    } catch {
      return import('./mcp/mcpRuntime.js');
    }
  })();
  return mcpRuntimeModulePromise;
}

export function activate(context: vscode.ExtensionContext): void {
  // A WebSocket terminal, a chunked SFTP transport, a local HTTP bridge and a
  // scoped cookie jar have no business failing into a toast that disappears
  // after five seconds. `log: true` gives the channel levels and timestamps,
  // and lets the user raise verbosity without a setting of ours.
  const logChannel = vscode.window.createOutputChannel('AT JumpServer Terminal', { log: true });
  setLogSink(logChannel);
  context.subscriptions.push(logChannel, { dispose: () => setLogSink(undefined) });

  clientPool?.dropAll();
  clientPool = new JumpServerClientPool();
  const configManager = new JumpServerConfigManager(context.globalState, context.secrets);
  const terminalContext = new TerminalContextRegistry();
  const treeProvider = new JumpServerTreeProvider(configManager);
  const sftpManager = new JumpServerSftpManager({
    createSession: async (asset) => new JumpServerSftpSession({
      asset,
      client: await createClient(configManager, asset.bastionId, context.secrets)
    }),
    reporter: new VscodeTransferReporter()
  });
  const sftpTreeProvider = new SftpTreeProvider({
    getState: () => sftpManager.getState(),
    // Manager's second argument is connectionKey; the tree never binds a
    // specific terminal here, so options must be passed in the third slot.
    listDirectory: (path, options) => sftpManager.listDirectory(path, undefined, options)
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
      const continueAction = t('Continue');
      // An unanswered modal must resolve before the hub's 120s invoke timeout
      // retries the call on another window's bridge (a second execution).
      // Dismissal by timeout is a cancel.
      const answer = await confirmWithTimeout(
        vscode.window.showWarningMessage(message, { modal: true }, continueAction)
      );
      return answer === continueAction;
    }
  });
  let disposed = false;
  let prefetchTimer: NodeJS.Timeout | undefined;
  let mcpRuntimeHandle: McpRuntimeHandle | undefined;
  let mcpRuntimeStart: Promise<void> | undefined;

  const startMcpRuntimeOnce = async (): Promise<void> => {
    const runtime = await loadMcpRuntimeModule(context);
    if (disposed) {
      return;
    }
    const handle = runtime.startMcpRuntime({
      context,
      service: agentService,
      hostEnv,
      workspaceFolder: currentWorkspaceFolder()
    });
    mcpRuntimeHandle = handle;
    void handle.hubReady
      .then((result) => {
        log.info(`hub sync ok (updated=${result.updated}, active=${result.activeVersion})`);
      })
      .catch((error) => {
        log.error(`hub sync failed: ${errorMessage(error)}`);
        void showTimedNotification(
          t('AT Series hub sync failed: {message}. MCP may not start until Repair succeeds.', {
            message: errorMessage(error)
          }),
          'warning'
        );
      });
    void handle.bridgeReady.catch((error) => {
      log.error(`MCP bridge failed to start: ${errorMessage(error)}`);
      void showTimedNotification(
        t('JumpServer MCP bridge failed to start: {message}', { message: errorMessage(error) }),
        'warning'
      );
    });
    void handle.ideConfigReady.catch((error) => {
      void showTimedNotification(
        t('AT Series MCP config could not be updated: {message}', { message: errorMessage(error) }),
        'warning'
      );
    });
  };

  /** Idempotent: the second and later calls return the first start. */
  const ensureMcpRuntime = (): Promise<void> => {
    mcpRuntimeStart ??= startMcpRuntimeOnce().catch((error) => {
      log.error(`MCP runtime failed to load: ${errorMessage(error)}`);
    });
    return mcpRuntimeStart;
  };

  // activate() must stay synchronous; MCP spins up in the background and only
  // for users who actually configured a bastion. Everyone else skips the hub
  // bundle read, the bridge HTTP server, and the IDE MCP config write until a
  // bastion is saved or refreshed (see ensureMcpRuntime call sites below).
  void (async () => {
    const bastions = await configManager.listBastions();
    if (bastions.length > 0 && !disposed) {
      await ensureMcpRuntime();
    }
  })().catch((error) => {
    log.error(`MCP activation gate failed: ${errorMessage(error)}`);
  });

  const cleanup = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (prefetchTimer) {
        clearTimeout(prefetchTimer);
        prefetchTimer = undefined;
      }
      sftpManager.dispose();
      sftpEditManager.dispose();
      void mcpRuntimeHandle?.dispose();
      mcpRuntimeHandle = undefined;
      TerminalPanel.disconnectAll();
      clientPool?.dropAll();
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
        clientPool = undefined;
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

  const assetsView = vscode.window.createTreeView('jumpserverManager.assets', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    assetsView,
    assetsView.onDidChangeSelection((event) => {
      const item = event.selection[0];
      if (!(item instanceof AssetTreeItem)) {
        return;
      }
      if (prefetchTimer) {
        clearTimeout(prefetchTimer);
      }
      prefetchTimer = setTimeout(() => {
        prefetchTimer = undefined;
        void prefetchAssetDetail(configManager, item.asset);
      }, ASSET_DETAIL_PREFETCH_DEBOUNCE_MS);
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
    vscode.commands.registerCommand('jumpserverManager.configure', async () => {
      await runCommand(async () => {
        const bastions = await configManager.listBastions();
        if (bastions.length === 0) {
          await JumpServerConfigPanel.open(context, configManager, { mode: 'add' });
          return;
        }
        const picked = await vscode.window.showQuickPick(
          [
            ...bastions.map((bastion) => ({
              label: bastion.name,
              description: bastion.baseUrl,
              bastionId: bastion.id
            })),
            { label: t('Add JumpServer'), description: '', bastionId: '' }
          ],
          { title: t('Select a JumpServer bastion'), ignoreFocusOut: true }
        );
        if (!picked) {
          return;
        }
        await JumpServerConfigPanel.open(
          context,
          configManager,
          picked.bastionId === '' ? { mode: 'add' } : { mode: 'edit', bastionId: picked.bastionId }
        );
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.addBastion', () => {
      void JumpServerConfigPanel.open(context, configManager, { mode: 'add' });
    }),
    vscode.commands.registerCommand('jumpserverManager.editBastion', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        await JumpServerConfigPanel.open(context, configManager, { mode: 'edit', bastionId: bastion.id });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.removeBastion', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        const deleteAction = t('Delete');
        const answer = await vscode.window.showWarningMessage(
          t('Delete JumpServer bastion {name}?', { name: bastion.name }),
          { modal: true },
          deleteAction
        );
        if (answer !== deleteAction) {
          return;
        }
        await configManager.deleteBastion(bastion.id);
        clientPool?.drop(bastion.id);
        for (const terminalId of TerminalPanel.disposeSessionsForBastion(bastion.id)) {
          sftpManager.removeTerminal(terminalId);
        }
        treeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.refreshBastion', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        const result = await refreshBastion(configManager, treeProvider, bastion.id, context.secrets);
        notifyRefreshSummary([bastion], [{ status: 'fulfilled', value: result }]);
        if (!result.cancelled) {
          // A working bastion now exists; late-start MCP for windows that
          // activated with none configured. No-op when already running.
          void ensureMcpRuntime();
        }
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.validate', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        const client = await createClient(configManager, bastion.id, context.secrets);
        await client.healthCheck();
        await client.ensureAuthToken();
        // Verifying an account should not drag the whole node tree along.
        await client.getUserProfile();
        const org = await ensureOrgContext(configManager, client, bastion);
        if (!org) {
          return;
        }
        client.setOrgId(org.id);
        showTimedNotification(t('JumpServer account verified. Organization: {org}.', { org: org.name }));
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.refresh', async () => {
      await runCommand(async () => {
        const bastions = await configManager.listBastions();
        if (bastions.length === 0) {
          throw new Error('JumpServer is not configured.');
        }
        const results = await Promise.allSettled(
          bastions.map((bastion) => refreshBastion(configManager, treeProvider, bastion.id, context.secrets))
        );
        notifyRefreshSummary(bastions, results);
        if (results.some((result) => result.status === 'fulfilled' && !result.value.cancelled)) {
          void ensureMcpRuntime();
        }
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.connect', async (item?: AssetTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const kind = getAssetOpenKind(item.asset);
        if (kind === 'unsupported') {
          showTimedNotification(
            t('Asset type is not supported yet: {name}', { name: item.asset.name }),
            'error'
          );
          return;
        }
        const client = await createClient(configManager, item.asset.bastionId, context.secrets);
        const terminal = TerminalPanel.open(context, item.asset, client, terminalContext);
        await tryOpenSftpFiles(sftpManager, sftpTreeProvider, item.asset, terminal.getTerminalId(), false);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.copyHostIp', async (item?: AssetTreeItem) => {
      const address = item?.asset?.address;
      if (!address) {
        await vscode.window.showWarningMessage(t('Host IP is not available.'));
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
        await sftpManager.refreshDirectory();
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
        const allowed = await ensurePreviewEditAllowed(sftpManager, item);
        await openRemotePreviewFile({
          storageUri: context.globalStorageUri ?? context.extensionUri,
          remotePath: item.entry.path,
          previewStore: sftpPreviewStore,
          initialContent: allowed.sample,
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
        const allowed = await ensurePreviewEditAllowed(sftpManager, item);
        await sftpEditManager.openRemoteFile(item.entry.path, { initialContent: allowed.sample });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.delete', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const deleteAction = t('Delete');
        const answer = await vscode.window.showWarningMessage(
          t('Delete {path}?', { path: item.entry.path }),
          { modal: true },
          deleteAction
        );
        if (answer !== deleteAction) {
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
        const nextName = await vscode.window.showInputBox({ prompt: t('New name'), value: item.entry.name });
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
        const name = await vscode.window.showInputBox({ prompt: t('Folder name') });
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
        showTimedNotification(t('Remote path copied.'));
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.installMcpConfig', async () => {
      await runCommand(async () => {
        const runtime = await loadMcpRuntimeModule(context);
        try {
          // Repair must not trust the metadata short-circuit: force the full
          // read+hash election so a tampered ~/.at-series install is rebuilt.
          await runtime.syncPackagedHub(context, { force: true });
        } catch (error) {
          showTimedNotification(t('AT Series hub sync failed: {message}', { message: errorMessage(error) }), 'error');
          return;
        }
        const result = await runtime.ensureAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        });
        if (result) {
          showTimedNotification(
            result.updated
              ? t('AT Series MCP config installed/repaired.')
              : t('AT Series MCP config is already up to date.')
          );
          return;
        }
        showTimedNotification(
          t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.'),
          'warning'
        );
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.uninstallAtSeriesMcpConfig', async () => {
      await runCommand(async () => {
        const runtime = await loadMcpRuntimeModule(context);
        const result = await runtime.uninstallAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        });
        if (result?.removed) {
          showTimedNotification(t('AT Series MCP config uninstalled.'));
          return;
        }
        if (result) {
          showTimedNotification(t('AT Series MCP config was not present.'));
          return;
        }
        showTimedNotification(
          t('No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.'),
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

type BastionCommandArg = string | { bastion?: { id?: string } };

type BastionRefreshResult =
  | { cancelled: true }
  | { cancelled: false; truncated: boolean; count: number; total: number };

async function pickBastion(
  configManager: JumpServerConfigManager,
  item?: BastionCommandArg
): Promise<JumpServerBastion | undefined> {
  const requestedId = bastionIdFromArg(item);
  if (requestedId) {
    return configManager.requireBastion(requestedId);
  }
  const bastions = await configManager.listBastions();
  if (bastions.length === 0) {
    throw new Error('JumpServer is not configured.');
  }
  if (bastions.length === 1) {
    return bastions[0];
  }
  const picked = await vscode.window.showQuickPick(
    bastions.map((bastion) => ({
      label: bastion.name,
      description: bastion.baseUrl,
      bastionId: bastion.id
    })),
    { title: t('Select a JumpServer bastion'), ignoreFocusOut: true }
  );
  if (!picked) {
    return undefined;
  }
  return configManager.requireBastion(picked.bastionId);
}

function bastionIdFromArg(item?: BastionCommandArg): string | undefined {
  if (typeof item === 'string' && item) {
    return item;
  }
  if (item && typeof item === 'object' && typeof item.bastion?.id === 'string' && item.bastion.id) {
    return item.bastion.id;
  }
  return undefined;
}

async function refreshBastion(
  configManager: JumpServerConfigManager,
  treeProvider: JumpServerTreeProvider,
  bastionId: string,
  secrets?: vscode.SecretStorage
): Promise<BastionRefreshResult> {
  const bastion = await configManager.requireBastion(bastionId);
  const client = await createClient(configManager, bastionId, secrets);
  const org = await ensureOrgContext(configManager, client, bastion);
  if (!org) {
    return { cancelled: true };
  }
  client.setOrgId(org.id);
  const nodes = await client.listAssetNodes();
  await configManager.saveCachedAssetNodes(bastionId, nodes);
  treeProvider.refresh();
  const inventory = await client.listAllAssets({ treePaths: assetPathsFromNodes(nodes) });
  await configManager.saveCachedAssets(bastionId, inventory.assets);
  treeProvider.refresh();
  return {
    cancelled: false,
    truncated: inventory.truncated,
    count: inventory.assets.length,
    total: inventory.total
  };
}

function notifyRefreshSummary(
  bastions: JumpServerBastion[],
  results: PromiseSettledResult<BastionRefreshResult>[]
): void {
  const failed = results
    .map((result, index) => ({ result, bastion: bastions[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; bastion: JumpServerBastion } =>
      entry.result.status === 'rejected'
    );
  const succeeded = results.filter(
    (result): result is PromiseFulfilledResult<Exclude<BastionRefreshResult, { cancelled: true }>> =>
      result.status === 'fulfilled' && !result.value.cancelled
  );
  if (succeeded.length === 0 && failed.length === 0) {
    return;
  }
  const truncated = succeeded.filter((result) => result.value.truncated);
  const warning = failed.length > 0 || truncated.length > 0;
  if (failed.length > 0) {
    showTimedNotification(
      t('JumpServer assets refreshed: {ok} succeeded, {fail} failed ({names}).', {
        ok: succeeded.length,
        fail: failed.length,
        names: failed.map((entry) => entry.bastion.name).join(', ')
      }),
      'warning'
    );
    return;
  }
  let message = t('JumpServer assets refreshed: {ok} succeeded.', { ok: succeeded.length });
  if (truncated.length > 0) {
    message = `${message} ${truncated.map((result) =>
      t('JumpServer assets refreshed: {count} of {total} (cache cap reached).', {
        count: result.value.count,
        total: result.value.total
      })
    ).join(' ')}`;
  }
  if (warning) {
    showTimedNotification(message, 'warning');
    return;
  }
  showTimedNotification(message);
}

async function ensureOrgContext(
  configManager: JumpServerConfigManager,
  client: JumpServerClient,
  bastion: JumpServerBastion
): Promise<{ id: string; name: string } | undefined> {
  // A saved org id is trusted as-is: listing orgs on every refresh/validate
  // costs a REST round-trip, and a stale org still surfaces through the
  // existing error toasts when the follow-up asset calls fail.
  const savedOrgId = bastion.orgId.trim();
  if (savedOrgId) {
    return { id: savedOrgId, name: bastion.name || savedOrgId };
  }
  const accessible = await client.listAccessibleOrgs();
  const context = resolveOrgContext({ savedOrgId: bastion.orgId, accessibleOrgs: accessible });
  if (context.effectiveOrg && context.effectiveOrg.source === 'reserved_auto_select') {
    await configManager.saveBastion({ ...bastion, orgId: context.effectiveOrg.id, updatedAt: Date.now() });
    return context.effectiveOrg;
  }
  if (context.effectiveOrg && !context.selectionRequired) {
    return context.effectiveOrg;
  }
  const picked = await vscode.window.showQuickPick(
    context.candidateOrgs.map((org) => ({
      label: org.name || org.id,
      description: org.id,
      orgId: org.id,
      name: org.name || org.id
    })),
    { title: t('Select the JumpServer organization to query.'), ignoreFocusOut: true }
  );
  if (!picked) {
    showTimedNotification(t('Organization selection was cancelled.'), 'error');
    return undefined;
  }
  await configManager.saveBastion({ ...bastion, orgId: picked.orgId, updatedAt: Date.now() });
  return { id: picked.orgId, name: picked.name };
}

async function prefetchAssetDetail(
  _configManager: JumpServerConfigManager,
  asset: CachedJumpServerAsset
): Promise<void> {
  try {
    // Browsing the tree must never pay a REST or form login. Only a bastion
    // somebody already connected to gets its detail and web session warmed.
    const client = clientPool?.peek(asset.bastionId);
    if (!client) {
      return;
    }
    const warmups: Array<Promise<unknown>> = [client.getAssetDetail(asset.id)];
    if (typeof client.ensureWebSession === 'function') {
      warmups.push(client.ensureWebSession());
    }
    await Promise.all(warmups);
  } catch (error) {
    log.debug(`asset detail prefetch failed: ${errorMessage(error)}`);
  }
}

async function createClient(
  configManager: JumpServerConfigManager,
  bastionId: string,
  secrets?: vscode.SecretStorage
): Promise<JumpServerClient> {
  const bastion = await configManager.requireBastion(bastionId);
  const password = await configManager.requirePassword(bastionId);
  // Terminal and SFTP both come through here; a shared pool is what lets them
  // skip a second REST + KoKo login on the same bastion.
  const pool = clientPool ?? new JumpServerClientPool();
  clientPool = pool;
  return pool.acquire(bastionId, {
    baseUrl: bastion.baseUrl,
    orgId: bastion.orgId,
    username: bastion.username,
    password,
    verifyTls: bastion.verifyTls
  }, secrets ? { webSessionStore: createWebSessionSecretStore(secrets, bastionId) } : undefined);
}

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    log.error(`command failed: ${errorMessage(error)}`);
    showTimedNotification(errorMessage(error), 'error');
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
    showTimedNotification(
      t('Files are not available for {name}: {message}', { name: asset.name, message: errorMessage(error) }),
      'warning'
    );
  }
}

async function ensureSftpAssetOpen(manager: JumpServerSftpManager): Promise<boolean> {
  if (manager.getState().kind !== 'none') {
    return true;
  }
  showTimedNotification(t('Open files from a JumpServer asset first.'), 'warning');
  return false;
}

async function ensurePreviewEditAllowed(
  manager: JumpServerSftpManager,
  item: SftpFileTreeItem
): Promise<{ size: number; sample: Buffer }> {
  if (!await ensureSftpAssetOpen(manager)) {
    throw new Error(t('Open files from a JumpServer asset first.'));
  }
  const stat = item.entry.size === undefined
    ? await manager.stat(item.entry.path)
    : { size: item.entry.size, modifiedAt: item.entry.modifiedAt ?? 0 };
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size });
  const sample = await manager.readFile(item.entry.path, Math.min(DEFAULT_SFTP_EDIT_MAX_BYTES, Math.max(stat.size, 1)));
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size, sample });
  return { size: stat.size, sample };
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
  throw new Error(t('No active JumpServer SFTP asset.'));
}

function localBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || remoteBasename(path);
}

