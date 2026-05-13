import * as vscode from 'vscode';
import type { CachedJumpServerAsset, CachedJumpServerNode } from '../config/schema';
import { AssetTreeItem, GroupTreeItem } from './TreeItems';

export interface JumpServerAssetSource {
  listCachedAssets(): Promise<CachedJumpServerAsset[]>;
  listCachedAssetNodes?(): Promise<CachedJumpServerNode[]>;
}

export class JumpServerTreeProvider implements vscode.TreeDataProvider<GroupTreeItem | AssetTreeItem> {
  private readonly changed = new vscode.EventEmitter<GroupTreeItem | AssetTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: JumpServerAssetSource) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: GroupTreeItem | AssetTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GroupTreeItem | AssetTreeItem): Promise<Array<GroupTreeItem | AssetTreeItem>> {
    if (element instanceof AssetTreeItem) {
      return [];
    }
    const nodes = await this.source.listCachedAssetNodes?.() ?? [];
    const assets = await this.source.listCachedAssets();
    if (nodes.length > 0) {
      return this.getNodeTreeChildren(nodes, assets, element);
    }
    const parentPath = element?.path ?? [];
    const childGroups = new Set<string>();
    const childAssets: CachedJumpServerAsset[] = [];

    for (const asset of assets) {
      const groupPath = this.groupPath(asset);
      if (!this.startsWith(groupPath, parentPath)) {
        continue;
      }
      if (groupPath.length > parentPath.length) {
        childGroups.add(groupPath[parentPath.length]);
      } else {
        childAssets.push(asset);
      }
    }

    return [
      ...Array.from(childGroups).sort((a, b) => a.localeCompare(b)).map((group) => new GroupTreeItem([...parentPath, group])),
      ...childAssets.sort((a, b) => a.name.localeCompare(b.name)).map((asset) => new AssetTreeItem(asset))
    ];
  }

  private groupPath(asset: CachedJumpServerAsset): string[] {
    if (asset.nodePath.length > 0) {
      return asset.nodePath;
    }
    if (asset.zoneName.trim()) {
      return [asset.zoneName.trim()];
    }
    return ['Default'];
  }

  private startsWith(path: string[], prefix: string[]): boolean {
    return prefix.every((value, index) => path[index] === value);
  }

  private getNodeTreeChildren(
    nodes: CachedJumpServerNode[],
    assets: CachedJumpServerAsset[],
    element?: GroupTreeItem
  ): Array<GroupTreeItem | AssetTreeItem> {
    const parentPath = element?.path ?? [];
    const childNodes = nodes
      .filter((node) => node.path.length === parentPath.length + 1 && this.startsWith(node.path, parentPath))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((node) => new GroupTreeItem(node.path));
    const assetIds = new Set(nodes.find((node) => samePath(node.path, parentPath))?.assetIds ?? []);
    const childAssets = assets
      .filter((asset) => assetIds.has(asset.id) || samePath(asset.nodePath, parentPath))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((asset) => new AssetTreeItem(asset));
    return [...childNodes, ...childAssets];
  }
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}
