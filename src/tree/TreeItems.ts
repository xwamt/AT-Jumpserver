import * as vscode from 'vscode';
import type { AssetCommandTrust, CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind, isDatabaseAsset, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';
import { t } from '../i18n/t';

export class GroupTreeItem extends vscode.TreeItem {
  readonly contextValue = 'jumpserverGroup';

  constructor(
    readonly path: string[],
    readonly bastionId: string,
    collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
  ) {
    super(path.at(-1) || t('Default'), collapsibleState);
    this.label = path.at(-1) || t('Default');
    this.id = `group:${bastionId}/${path.join('/')}`;
  }
}

export class AssetTreeItem extends vscode.TreeItem {
  constructor(readonly asset: CachedJumpServerAsset, readonly trust: AssetCommandTrust = 'none') {
    super(asset.name, vscode.TreeItemCollapsibleState.None);
    const kind = getAssetOpenKind(asset);
    this.id = `asset:${asset.bastionId}/${asset.id}`;
    this.label = asset.name;
    this.contextValue = contextValueForKind(kind);
    this.description = decorateDescription(assetDescription(asset, kind), trust);
    this.tooltip = `${asset.name}${asset.address ? ` (${asset.address})` : ''}${kind === 'mysql' ? ' - MySQL' : kind === 'redis' ? ' - Redis' : ''}\n${t('Agent command trust')}: ${trustLabel(trust)}`;
    this.command = {
      command: 'jumpserverManager.connect',
      title: t('Connect'),
      arguments: [this]
    };
  }
}

function trustLabel(trust: AssetCommandTrust): string {
  if (trust === 'policy') {
    return t('Limited trust');
  }
  if (trust === 'full') {
    return t('Full trust');
  }
  return t('Untrusted');
}

/** The default level stays undecorated so the tree gains no noise (design D10). */
function decorateDescription(base: string, trust: AssetCommandTrust): string {
  if (trust === 'none') {
    return base;
  }
  const label = trustLabel(trust);
  return base ? `${base} · ${label}` : label;
}


export const getAssetOpenKind = getAssetConnectionKind;

function contextValueForKind(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'jumpserverMysqlAsset';
  }
  if (kind === 'redis') {
    return 'jumpserverRedisAsset';
  }
  if (kind === 'ssh') {
    return 'jumpserverAsset';
  }
  return 'jumpserverUnsupportedAsset';
}

function assetDescription(asset: CachedJumpServerAsset, kind: JumpServerConnectionKind): string {
  const base = asset.address || asset.platform || (isDatabaseAsset(asset) ? asset.type : '');
  if (kind === 'mysql') {
    return base ? `${base} - MySQL` : 'MySQL';
  }
  if (kind === 'redis') {
    return base ? `${base} - Redis` : 'Redis';
  }
  return base;
}