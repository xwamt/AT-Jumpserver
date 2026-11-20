import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { JumpServerAgentToolService } from './agent/JumpServerAgentToolService';
import { registerAssetCommands } from './commands/assetCommands';
import { registerBastionCommands } from './commands/bastionCommands';
import { registerMcpCommands } from './commands/mcpCommands';
import { registerSftpCommands } from './commands/sftpCommands';
import { JumpServerConfigManager } from './config/JumpServerConfigManager';
import type { CachedJumpServerAsset } from './config/schema';
import { JumpServerClient } from './jumpserver/JumpServerClient';
import { JumpServerClientPool } from './jumpserver/JumpServerClientPool';
import { createWebSessionSecretStore } from './jumpserver/webSessionStore';
import { detectKokoCapabilities, isKokoCookieLess } from './jumpserver/kokoCapability';
import { confirmWithTimeout } from './mcp/confirmTimeout';
import type { McpRuntimeHandle } from './mcp/mcpRuntime';
import { createVscodeSftpEditUi, SftpEditSessionManager } from './sftp/SftpEditSessionManager';
import { JumpServerSftpManager } from './sftp/JumpServerSftpManager';
import { JumpServerSftpSession } from './sftp/JumpServerSftpSession';
import { JUMPSERVER_SFTP_PREVIEW_SCHEME, SftpPreviewDocumentStore } from './sftp/SftpPreview';
import { VscodeTransferReporter } from './sftp/VscodeTransferReporter';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { JumpServerTreeProvider } from './tree/JumpServerTreeProvider';
import { SftpTreeProvider } from './tree/SftpTreeProvider';
import { AssetTreeItem } from './tree/TreeItems';
import { log, setLogSink } from './utils/logger';
import { showTimedNotification } from './utils/notifications';
import { errorMessage } from './utils/redaction';
import { resolveTerminalSettings, TerminalPanel } from './webview/TerminalPanel';
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
  TerminalPanel.setAccountPreferenceStore(configManager);
  const terminalContext = new TerminalContextRegistry();
  const treeProvider = new JumpServerTreeProvider(configManager);
  const sftpManager = new JumpServerSftpManager({
    createSession: async (asset, connectionKey) => new JumpServerSftpSession({
      asset,
      client: await createClient(configManager, asset.bastionId, context.secrets),
      getReusableTokenId: () => TerminalPanel.getReusableToken(connectionKey, asset)
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
    // Trust is resolved at invoke time, never snapshotted at connect time:
    // only the stable bastionId/assetId pair is taken from the asset, so a
    // level changed mid-session applies to the very next MCP call.
    resolveAssetTrust: (asset) => configManager.resolveAssetTrust(asset.bastionId, asset.id),
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

  const createBastionClient = (bastionId: string) => createClient(configManager, bastionId, context.secrets);

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
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jumpserverManager')) {
        TerminalPanel.syncConfiguration(
          resolveTerminalSettings(vscode.workspace.getConfiguration('jumpserverManager'))
        );
      }
    }),
    cleanup,
    ...registerBastionCommands({
      context,
      configManager,
      treeProvider,
      sftpManager,
      createClient: createBastionClient,
      dropClient: (bastionId) => clientPool?.drop(bastionId),
      ensureMcpRuntime,
      runCommand
    }),
    ...registerAssetCommands({
      context,
      configManager,
      treeProvider,
      terminalContext,
      sftpManager,
      sftpTreeProvider,
      createClient: createBastionClient,
      runCommand
    }),
    ...registerSftpCommands({
      context,
      sftpManager,
      sftpTreeProvider,
      sftpPreviewStore,
      sftpEditManager,
      terminalContext,
      runCommand
    }),
    ...registerMcpCommands({
      context,
      loadMcpRuntimeModule: () => loadMcpRuntimeModule(context),
      hostEnv,
      currentWorkspaceFolder,
      runCommand
    })
  );
}

export function deactivate(): void {
  extensionCleanup?.dispose();
  TerminalPanel.disconnectAll();
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
      const cached = isKokoCookieLess(asset.bastionId);
      if (cached === true) {
        // Detected as 5.0 cookie-less: skip ensureWebSession
      } else if (cached === false || typeof (client as any).getClientVersions !== 'function') {
        warmups.push(client.ensureWebSession());
      } else {
        warmups.push(
          detectKokoCapabilities(client, asset.bastionId).then((caps) => {
            if (!caps.cookieLess) {
              return client.ensureWebSession?.();
            }
          })
        );
      }
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
  const kokoBearerHandshake = vscode.workspace
    .getConfiguration('jumpserverManager')
    .get<boolean>('kokoBearerHandshake', false);
  return pool.acquire(
    bastionId,
    {
      baseUrl: bastion.baseUrl,
      orgId: bastion.orgId,
      username: bastion.username,
      password,
      verifyTls: bastion.verifyTls
    },
    {
      ...(secrets ? { webSessionStore: createWebSessionSecretStore(secrets, bastionId) } : {}),
      bastionId,
      kokoBearerHandshake
    }
  );
}

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    log.error(`command failed: ${errorMessage(error)}`);
    showTimedNotification(errorMessage(error), 'error');
  }
}

