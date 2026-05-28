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
    const nodePaths = this.normalizedNodePaths(nodes, assets);
    const childNodePaths = Array.from(nodePaths.values())
      .filter((path) => path.length === parentPath.length + 1 && this.startsWith(path, parentPath))
      .sort((a, b) => (a.at(-1) || '').localeCompare(b.at(-1) || ''))
      .map((path) => new GroupTreeItem(path));
    const assetIds = new Set(nodes.find((node) => samePath(node.path, parentPath))?.assetIds ?? []);
    const childAssets = assets
      .filter((asset) => assetIds.has(asset.id) || samePath(asset.nodePath, parentPath))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((asset) => new AssetTreeItem(asset));
    return [...childNodePaths, ...childAssets];
  }

  private normalizedNodePaths(nodes: CachedJumpServerNode[], assets: CachedJumpServerAsset[]): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const hasNestedNodePaths = nodes.some((node) => node.path.length > 1);
    const assetNodePaths = assets.map((asset) => asset.nodePath).filter((path) => path.length > 0);
    const assetRootNames = new Set(assetNodePaths.map((path) => path[0]));
    for (const node of nodes) {
      if (hasNestedNodePaths || node.path.length > 1 || assetNodePaths.length === 0 || assetRootNames.has(node.path[0])) {
        paths.set(node.path.join('/'), node.path);
      }
    }
    if (hasNestedNodePaths) {
      return paths;
    }
    for (const asset of assets) {
      for (let index = 1; index <= asset.nodePath.length; index += 1) {
        const path = asset.nodePath.slice(0, index);
        paths.set(path.join('/'), path);
      }
    }
    return paths;
  }
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}
