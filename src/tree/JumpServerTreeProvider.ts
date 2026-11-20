import * as vscode from 'vscode';
import { assetTrustKey, type CachedJumpServerAsset, type CachedJumpServerNode, type JumpServerBastion } from '../config/schema';
import { BastionTreeItem, EmptyBastionTreeItem } from './BastionTreeItem';
import { AssetTreeItem, GroupTreeItem } from './TreeItems';
import { t } from '../i18n/t';

export type JumpServerTreeElement = BastionTreeItem | EmptyBastionTreeItem | GroupTreeItem | AssetTreeItem;

export interface JumpServerAssetSource {
  listBastions(): Promise<JumpServerBastion[]>;
  listCachedAssets(): Promise<CachedJumpServerAsset[]>;
  listCachedAssetNodes?(): Promise<CachedJumpServerNode[]>;
  listAssetTrustOverrides?(): Promise<Record<string, 'policy' | 'full'>>;
}

interface BastionTreeIndex {
  childGroupPathsByParentKey: Map<string, string[][]>;
  assetsByParentKey: Map<string, CachedJumpServerAsset[]>;
}

interface TreeSnapshot {
  trustOverlay: Record<string, 'policy' | 'full'>;
  bastionIndices: Map<string, BastionTreeIndex>;
}

export class JumpServerTreeProvider implements vscode.TreeDataProvider<JumpServerTreeElement> {
  private readonly changed = new vscode.EventEmitter<JumpServerTreeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private snapshotPromise: Promise<TreeSnapshot> | undefined;

  constructor(private readonly source: JumpServerAssetSource) {}

  refresh(): void {
    this.snapshotPromise = undefined;
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
    const snapshot = await this.getSnapshot();
    const index = snapshot.bastionIndices.get(bastionId);
    if (!index) {
      return [];
    }
    const parentKey = pathKey(element instanceof GroupTreeItem ? element.path : []);
    const childGroups = (index.childGroupPathsByParentKey.get(parentKey) ?? [])
      .map((path) => new GroupTreeItem(path, bastionId));
    const childAssets = (index.assetsByParentKey.get(parentKey) ?? [])
      .map((asset) => this.assetItem(asset, snapshot.trustOverlay));
    return [...childGroups, ...childAssets];
  }

  private getSnapshot(): Promise<TreeSnapshot> {
    if (!this.snapshotPromise) {
      this.snapshotPromise = this.buildSnapshot().catch((error) => {
        this.snapshotPromise = undefined;
        throw error;
      });
    }
    return this.snapshotPromise;
  }

  private async buildSnapshot(): Promise<TreeSnapshot> {
    const [nodes, assets, trustOverlay] = await Promise.all([
      this.source.listCachedAssetNodes?.() ?? Promise.resolve([]),
      this.source.listCachedAssets(),
      this.source.listAssetTrustOverrides?.() ?? Promise.resolve({})
    ]);

    const nodesByBastion = new Map<string, CachedJumpServerNode[]>();
    for (const node of nodes) {
      let bucket = nodesByBastion.get(node.bastionId);
      if (!bucket) {
        bucket = [];
        nodesByBastion.set(node.bastionId, bucket);
      }
      bucket.push(node);
    }

    const assetsByBastion = new Map<string, CachedJumpServerAsset[]>();
    for (const asset of assets) {
      let bucket = assetsByBastion.get(asset.bastionId);
      if (!bucket) {
        bucket = [];
        assetsByBastion.set(asset.bastionId, bucket);
      }
      bucket.push(asset);
    }

    const bastionIds = new Set<string>([...nodesByBastion.keys(), ...assetsByBastion.keys()]);
    const bastionIndices = new Map<string, BastionTreeIndex>();
    for (const bastionId of bastionIds) {
      const bastionNodes = nodesByBastion.get(bastionId) ?? [];
      const bastionAssets = assetsByBastion.get(bastionId) ?? [];
      bastionIndices.set(
        bastionId,
        bastionNodes.length > 0
          ? this.buildNodeIndex(bastionNodes, bastionAssets)
          : this.buildGroupIndex(bastionAssets)
      );
    }

    return { trustOverlay, bastionIndices };
  }

  private assetItem(asset: CachedJumpServerAsset, trustOverlay: Record<string, 'policy' | 'full'>): AssetTreeItem {
    return new AssetTreeItem(asset, trustOverlay[assetTrustKey(asset.bastionId, asset.id)] ?? 'none');
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

  private buildGroupIndex(assets: CachedJumpServerAsset[]): BastionTreeIndex {
    const childGroupMapByParentKey = new Map<string, Map<string, string[]>>();
    const assetsByParentKey = new Map<string, CachedJumpServerAsset[]>();

    for (const asset of assets) {
      const groupPath = this.groupPath(asset);
      for (let index = 0; index < groupPath.length; index += 1) {
        const parent = pathKey(groupPath.slice(0, index));
        const child = groupPath.slice(0, index + 1);
        let childMap = childGroupMapByParentKey.get(parent);
        if (!childMap) {
          childMap = new Map();
          childGroupMapByParentKey.set(parent, childMap);
        }
        childMap.set(pathKey(child), child);
      }
      const key = pathKey(groupPath);
      let assetBucket = assetsByParentKey.get(key);
      if (!assetBucket) {
        assetBucket = [];
        assetsByParentKey.set(key, assetBucket);
      }
      assetBucket.push(asset);
    }

    const childGroupPathsByParentKey = new Map<string, string[][]>();
    for (const [parent, childMap] of childGroupMapByParentKey) {
      childGroupPathsByParentKey.set(
        parent,
        Array.from(childMap.values()).sort((a, b) => (a.at(-1) || '').localeCompare(b.at(-1) || ''))
      );
    }
    for (const bucket of assetsByParentKey.values()) {
      bucket.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { childGroupPathsByParentKey, assetsByParentKey };
  }

  private buildNodeIndex(nodes: CachedJumpServerNode[], assets: CachedJumpServerAsset[]): BastionTreeIndex {
    const nodePaths = this.normalizedNodePaths(nodes, assets);
    const childGroupPathsByParentKey = new Map<string, string[][]>();
    for (const path of nodePaths.values()) {
      const parent = pathKey(path.slice(0, -1));
      let bucket = childGroupPathsByParentKey.get(parent);
      if (!bucket) {
        bucket = [];
        childGroupPathsByParentKey.set(parent, bucket);
      }
      bucket.push(path);
    }
    for (const bucket of childGroupPathsByParentKey.values()) {
      bucket.sort((a, b) => (a.at(-1) || '').localeCompare(b.at(-1) || ''));
    }

    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const firstNodeAssetIdsByPathKey = new Map<string, string[]>();
    for (const node of nodes) {
      const key = pathKey(node.path);
      if (!firstNodeAssetIdsByPathKey.has(key)) {
        firstNodeAssetIdsByPathKey.set(key, node.assetIds);
      }
    }

    const assetSetsByParentKey = new Map<string, Set<CachedJumpServerAsset>>();
    const addAsset = (key: string, asset: CachedJumpServerAsset) => {
      let set = assetSetsByParentKey.get(key);
      if (!set) {
        set = new Set();
        assetSetsByParentKey.set(key, set);
      }
      set.add(asset);
    };

    for (const asset of assets) {
      addAsset(pathKey(asset.nodePath), asset);
    }
    for (const [key, assetIds] of firstNodeAssetIdsByPathKey) {
      for (const assetId of assetIds) {
        const asset = assetsById.get(assetId);
        if (asset) {
          addAsset(key, asset);
        }
      }
    }

    const assetsByParentKey = new Map<string, CachedJumpServerAsset[]>();
    for (const [key, set] of assetSetsByParentKey) {
      assetsByParentKey.set(
        key,
        Array.from(set).sort((a, b) => a.name.localeCompare(b.name))
      );
    }

    return { childGroupPathsByParentKey, assetsByParentKey };
  }

  private normalizedNodePaths(nodes: CachedJumpServerNode[], assets: CachedJumpServerAsset[]): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const hasNestedNodePaths = nodes.some((node) => node.path.length > 1);
    const assetNodePaths = assets.map((asset) => asset.nodePath).filter((path) => path.length > 0);
    const assetRootNames = new Set(assetNodePaths.map((path) => path[0]));
    for (const node of nodes) {
      if (hasNestedNodePaths || node.path.length > 1 || assetNodePaths.length === 0 || assetRootNames.has(node.path[0])) {
        paths.set(pathKey(node.path), node.path);
      }
    }
    if (hasNestedNodePaths) {
      return paths;
    }
    for (const asset of assets) {
      for (let index = 1; index <= asset.nodePath.length; index += 1) {
        const path = asset.nodePath.slice(0, index);
        paths.set(pathKey(path), path);
      }
    }
    return paths;
  }
}

function pathKey(path: string[]): string {
  return path.join('\0');
}
