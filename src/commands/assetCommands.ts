import * as vscode from 'vscode';
import type { JumpServerConfigManager } from '../config/JumpServerConfigManager';
import type { AssetCommandTrust, CachedJumpServerAsset } from '../config/schema';
import { t } from '../i18n/t';
import { connectionKindLabel, getAssetConnectionKind } from '../jumpserver/connectionTypes';
import type { JumpServerClient } from '../jumpserver/JumpServerClient';
import type { JumpServerSftpManager } from '../sftp/JumpServerSftpManager';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import type { JumpServerTreeProvider } from '../tree/JumpServerTreeProvider';
import type { SftpTreeProvider } from '../tree/SftpTreeProvider';
import { type AssetTreeItem, getAssetOpenKind } from '../tree/TreeItems';
import { showTimedNotification } from '../utils/notifications';
import { errorMessage } from '../utils/redaction';
import { TerminalPanel } from '../webview/TerminalPanel';

export interface AssetCommandsDeps {
  context: vscode.ExtensionContext;
  configManager: JumpServerConfigManager;
  treeProvider: JumpServerTreeProvider;
  terminalContext: TerminalContextRegistry;
  sftpManager: JumpServerSftpManager;
  sftpTreeProvider: SftpTreeProvider;
  createClient: (bastionId: string) => Promise<JumpServerClient>;
  runCommand: (command: () => Promise<void>) => Promise<void>;
}

/**
 * Registers asset connection, trust policy, IP copy, and active-terminal session commands.
 */
export function registerAssetCommands(deps: AssetCommandsDeps): vscode.Disposable[] {
  const {
    context,
    configManager,
    treeProvider,
    terminalContext,
    sftpManager,
    sftpTreeProvider,
    createClient,
    runCommand
  } = deps;

  async function connectAsset(item: AssetTreeItem | undefined, forceAccountPick: boolean): Promise<void> {
    const asset = item?.asset ?? await pickAssetForConnect(configManager);
    if (!asset) {
      return;
    }
    const kind = getAssetOpenKind(asset);
    if (kind === 'unsupported') {
      showTimedNotification(
        t('Asset type is not supported yet: {name}', { name: asset.name }),
        'error'
      );
      return;
    }
    const client = await createClient(asset.bastionId);
    const terminal = forceAccountPick
      ? TerminalPanel.open(context, asset, client, terminalContext, { forceAccountPick: true })
      : TerminalPanel.open(context, asset, client, terminalContext);
    await tryOpenSftpFiles(sftpManager, sftpTreeProvider, asset, terminal.getTerminalId(), false);
  }

  return [
    vscode.commands.registerCommand('jumpserverManager.connect', async (item?: AssetTreeItem) => {
      await runCommand(async () => {
        await connectAsset(item, false);
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.connectWithAccount', async (item?: AssetTreeItem) => {
      await runCommand(async () => {
        await connectAsset(item, true);
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
    vscode.commands.registerCommand('jumpserverManager.setAssetTrust', async (item?: AssetTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const asset = item.asset;
        const current = configManager.resolveAssetTrust(asset.bastionId, asset.id);
        const picked = await vscode.window.showQuickPick(assetTrustQuickPickItems(current), {
          placeHolder: t('Select trust level for {asset}', { asset: asset.name }),
          ignoreFocusOut: true
        });
        if (!picked) {
          return;
        }
        await configManager.setAssetTrust(asset.bastionId, asset.id, picked.level);
        treeProvider.refresh();
        showTimedNotification(
          t('Trust level for {asset} is now {level}.', { asset: asset.name, level: picked.label })
        );
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.disconnect', () => {
      TerminalPanel.getActive()?.disconnect();
    }),
    vscode.commands.registerCommand('jumpserverManager.reconnect', async () => {
      await TerminalPanel.getActive()?.reconnect();
    })
  ];
}

async function pickAssetForConnect(
  configManager: JumpServerConfigManager
): Promise<CachedJumpServerAsset | undefined> {
  const [bastions, assets] = await Promise.all([
    configManager.listBastions(),
    configManager.listCachedAssets()
  ]);
  if (assets.length === 0) {
    showTimedNotification(t('No cached JumpServer assets found. Refresh assets first.'), 'warning');
    return undefined;
  }
  const bastionNames = new Map(bastions.map((bastion) => [bastion.id, bastion.name]));
  const picked = await vscode.window.showQuickPick(
    assets.map((asset) => {
      const kind = connectionKindLabel(getAssetConnectionKind(asset));
      const description = [asset.address, kind].filter(Boolean).join(' · ');
      const bastionName = bastionNames.get(asset.bastionId);
      const groupPath = asset.nodePath.join(' / ') || asset.zoneName;
      const detail = [bastionName, groupPath].filter(Boolean).join(' — ');
      return {
        label: asset.name,
        description,
        detail: detail || undefined,
        asset
      };
    }),
    {
      title: t('Connect to JumpServer asset'),
      placeHolder: t('Search by asset name, IP, bastion, or group'),
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    }
  );
  return picked?.asset;
}

/**
 * The picked entry carries its `level`; nothing maps a localized label back
 * to a trust value.
 */
function assetTrustQuickPickItems(
  current: AssetCommandTrust
): Array<vscode.QuickPickItem & { level: AssetCommandTrust }> {
  const levels: Array<{ level: AssetCommandTrust; label: string; detail: string }> = [
    {
      level: 'none',
      label: t('Untrusted'),
      detail: t('Every agent command asks for confirmation.')
    },
    {
      level: 'policy',
      label: t('Limited trust'),
      // The npm package name (at-series slash command-policy) must stay out
      // of this literal: the policy-bundle test greps dist/extension.js for
      // it to prove the policy runtime is not inlined into the extension.
      detail: t('Commands are reviewed by the command policy engine; only an allow verdict skips the prompt.')
    },
    {
      level: 'full',
      label: t('Full trust'),
      detail: t('Agent commands and SFTP writes run without prompts. Raw terminal input still asks.')
    }
  ];
  return levels.map(({ level, label, detail }) => ({
    label,
    detail,
    description: level === current ? t('Current') : undefined,
    level
  }));
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
