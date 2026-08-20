import * as vscode from 'vscode';
import type { CachedJumpServerAsset, CachedJumpServerNode, JumpServerBastion } from '../config/schema';
import { BastionTreeItem, EmptyBastionTreeItem } from './BastionTreeItem';
import { AssetTreeItem, GroupTreeItem } from './TreeItems';
import { t } from '../i18n/t';

export type JumpServerTreeElement = BastionTreeItem | EmptyBastionTreeItem | GroupTreeItem | AssetTreeItem;

export interface JumpServerAssetSource {
  listBastions(): Promise<JumpServerBastion[]>;
  listCachedAssets(): Promise<CachedJumpServerAsset[]>;
  listCachedAssetNodes?(): Promise<CachedJumpServerNode[]>;
}

export class JumpServerTreeProvider implements vscode.TreeDataProvider<JumpServerTreeElement> {
  private readonly changed = new vscode.EventEmitter<JumpServerTreeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: JumpServerAssetSource) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: JumpServerTreeElement): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: JumpServerTreeElement): Promise<JumpServerTreeElement[]> {
    if (!element) {
      const bastions = await this.source.listBastions();
      if (bastions.length === 0) {
        return [new EmptyBastionTreeItem()];
      }
      return [...bastions]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((bastion) => new BastionTreeItem(bastion));
    }
    if (element instanceof AssetTreeItem || element instanceof EmptyBastionTreeItem) {
      return [];
    }
    const bastionId = element instanceof BastionTreeItem ? element.bastion.id : element.bastionId;
    const nodes = (await this.source.listCachedAssetNodes?.() ?? []).filter((node) => node.bastionId === bastionId);
    const assets = (await this.source.listCachedAssets()).filter((asset) => asset.bastionId === bastionId);
    const groupElement = element instanceof GroupTreeItem ? element : undefined;
    if (nodes.length > 0) {
      return this.getNodeTreeChildren(nodes, assets, bastionId, groupElement);
    }
    const parentPath = groupElement?.path ?? [];
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
      ...Array.from(childGroups).sort((a, b) => a.localeCompare(b)).map((group) => new GroupTreeItem([...parentPath, group], bastionId)),
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
    return [t('Default')];
  }


  private startsWith(path: string[], prefix: string[]): boolean {
    return prefix.every((value, index) => path[index] === value);
  }

  private getNodeTreeChildren(
    nodes: CachedJumpServerNode[],
    assets: CachedJumpServerAsset[],
    bastionId: string,
    element?: GroupTreeItem
  ): Array<GroupTreeItem | AssetTreeItem> {
    const parentPath = element?.path ?? [];
    const nodePaths = this.normalizedNodePaths(nodes, assets);
    const childNodePaths = Array.from(nodePaths.values())
      .filter((path) => path.length === parentPath.length + 1 && this.startsWith(path, parentPath))
      .sort((a, b) => (a.at(-1) || '').localeCompare(b.at(-1) || ''))
      .map((path) => new GroupTreeItem(path, bastionId));
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
