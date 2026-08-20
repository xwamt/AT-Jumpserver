import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
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
  constructor(readonly asset: CachedJumpServerAsset) {
    super(asset.name, vscode.TreeItemCollapsibleState.None);
    const kind = getAssetOpenKind(asset);
    this.id = `asset:${asset.bastionId}/${asset.id}`;
    this.label = asset.name;
    this.contextValue = contextValueForKind(kind);
    this.description = assetDescription(asset, kind);
    this.tooltip = `${asset.name}${asset.address ? ` (${asset.address})` : ''}${kind === 'mysql' ? ' - MySQL' : kind === 'redis' ? ' - Redis' : ''}`;
    this.command = {
      command: 'jumpserverManager.connect',
      title: t('Connect'),
      arguments: [this]
    };
  }
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