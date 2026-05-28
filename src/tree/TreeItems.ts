import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind, isDatabaseAsset, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';

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
  constructor(readonly asset: CachedJumpServerAsset) {
    super(asset.name, vscode.TreeItemCollapsibleState.None);
    const kind = getAssetOpenKind(asset);
    this.label = asset.name;
    this.contextValue = contextValueForKind(kind);
    this.description = assetDescription(asset, kind);
    this.tooltip = `${asset.name}${asset.address ? ` (${asset.address})` : ''}${kind === 'mysql' ? ' - MySQL' : ''}`;
    this.command = {
      command: 'jumpserverManager.connect',
      title: 'Connect',
      arguments: [this]
    };
  }
}

export const getAssetOpenKind = getAssetConnectionKind;

function contextValueForKind(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'jumpserverMysqlAsset';
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
  return base;
}