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
