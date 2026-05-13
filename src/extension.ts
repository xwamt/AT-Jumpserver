import * as vscode from 'vscode';
import { JumpServerConfigManager } from './config/JumpServerConfigManager';
import { JumpServerClient } from './jumpserver/JumpServerClient';
import { errorMessage } from './jumpserver/redaction';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { JumpServerTreeProvider } from './tree/JumpServerTreeProvider';
import { AssetTreeItem } from './tree/TreeItems';
import { showTimedNotification } from './utils/notifications';
import { JumpServerConfigPanel } from './webview/JumpServerConfigPanel';
import { TerminalPanel } from './webview/TerminalPanel';

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
        const nodes = await client.listAssetNodes();
        await configManager.saveCachedAssetNodes(nodes);
        treeProvider.refresh();
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
