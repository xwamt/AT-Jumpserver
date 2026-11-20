import type { CachedJumpServerAsset, CachedJumpServerNode } from '../config/schema';
import type {
  JumpServerAccountRef,
  JumpServerAliasAccount,
  JumpServerManagedAccountRef
} from './types';

export type AssetPathMap = Map<string, string[]>;

export function normalizeJumpServerAsset(item: Record<string, any>): CachedJumpServerAsset {
  const platform = item.platform;
  const category = item.category;
  const type = item.type;
  const zone = item.zone;
  const nodePath = extractNodePath(item);
  const zoneName = typeof zone === 'object' && zone ? String(zone.name || '') : String(zone || '');

  return {
    id: String(item.id || ''),
    name: String(item.name || item.address || item.id || ''),
    bastionId: '',
    address: String(item.address || ''),
    platform: typeof platform === 'object' && platform ? String(platform.name || '') : String(platform || ''),
    category: typeof category === 'object' && category ? String(category.value || '') : String(category || ''),
    type: typeof type === 'object' && type ? String(type.value || '') : String(type || ''),
    zoneName: zoneName || nodePath.at(-1) || '',
    nodePath,
    protocolNames: extractProtocolNames(item),
    raw: item
  };
}

export function extractNodePath(item: Record<string, any>): string[] {
  const candidates: string[][] = [];
  for (const field of ['node_path', 'nodePath', 'nodes_display', 'nodesDisplay']) {
    candidates.push(parseNodePathValue(item[field]));
  }
  const nodes = Array.isArray(item.nodes) ? item.nodes : [];
  candidates.push(nodes.flatMap((node) => parseNodeName(node)));
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }
    for (const field of ['full_value', 'fullValue', 'full_name', 'fullName', 'path', 'value', 'name']) {
      candidates.push(parseNodePathValue((node as Record<string, unknown>)[field]));
    }
  }
  return candidates.reduce<string[]>((best, candidate) => candidate.length > best.length ? candidate : best, []);
}

function parseNodeName(node: unknown): string[] {
  if (!node || typeof node !== 'object') {
    return [];
  }
  const name = (node as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? [name.trim()] : [];
}

function parseNodePathValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseNodePathValue(entry));
  }
  if (!value) {
    return [];
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['full_value', 'fullValue', 'full_name', 'fullName', 'path', 'value', 'name']) {
      const parsed = parseNodePathValue(record[field]);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return [];
  }
  return String(value)
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function extractProtocolNames(item: Record<string, any>): string[] {
  const rawProtocols = Array.isArray(item.permed_protocols)
    ? item.permed_protocols
    : Array.isArray(item.protocols)
      ? item.protocols
      : [];
  return rawProtocols
    .map((protocol: any) => String(protocol?.name || ''))
    .filter((name: string) => name.length > 0);
}

function toManagedAccountRef(account: Record<string, any>): JumpServerManagedAccountRef {
  const res: JumpServerManagedAccountRef = {
    kind: 'managed',
    id: String(account.id),
    username: String(account.username || account.name || account.alias || ''),
    hasSecret: typeof account.has_secret === 'boolean' ? account.has_secret : undefined
  };
  if (account.alias) {
    res.alias = String(account.alias);
  }
  return res;
}

export function resolveUsableAccounts(detail: Record<string, any>): JumpServerAccountRef[] {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];

  const result: JumpServerAccountRef[] = [];
  const seenManagedIds = new Set<string>();
  const seenAliases = new Set<string>();

  for (const account of accounts) {
    if (account?.has_secret === true && !String(account?.alias ?? '').startsWith('@') && account?.id) {
      const id = String(account.id);
      if (!seenManagedIds.has(id)) {
        seenManagedIds.add(id);
        result.push(toManagedAccountRef(account));
      }
    }
  }

  for (const account of accounts) {
    if (!String(account?.alias ?? '').startsWith('@') && account?.id) {
      const id = String(account.id);
      if (!seenManagedIds.has(id)) {
        seenManagedIds.add(id);
        result.push(toManagedAccountRef(account));
      }
    }
  }

  for (const account of accounts) {
    if (String(account?.alias ?? '').startsWith('@') && account?.alias) {
      const alias = String(account.alias).toUpperCase() as JumpServerAliasAccount;
      if (!seenAliases.has(alias)) {
        seenAliases.add(alias);
        result.push({
          kind: 'alias',
          alias,
          id: account.id ? String(account.id) : undefined,
          username: account.username ? String(account.username) : undefined,
          hasSecret: typeof account.has_secret === 'boolean' ? account.has_secret : undefined
        });
      }
    }
  }

  return result;
}

export function resolveFirstUsableAccount(detail: Record<string, any>): JumpServerAccountRef {
  const [first] = resolveUsableAccounts(detail);
  if (!first) {
    throw new Error('No usable JumpServer account was returned for this asset.');
  }
  return first;
}

export function extractAssetTreePaths(payload: unknown): AssetPathMap {
  return nodesToAssetPathMap(extractAssetTreeNodes(payload));
}

export function extractAssetTreeNodes(payload: unknown): CachedJumpServerNode[] {
  const items = treeItems(payload);
  if (isFlatAssetTree(items)) {
    return flatAssetTreeNodes(items);
  }
  const nodes: CachedJumpServerNode[] = [];
  for (const item of items) {
    walkAssetTreeNode(item, [], nodes);
  }
  return nodes;
}

/** Lets a caller reuse a node tree it already paid for. */
export function assetPathsFromNodes(nodes: CachedJumpServerNode[]): AssetPathMap {
  return nodesToAssetPathMap(nodes);
}

function nodesToAssetPathMap(nodes: CachedJumpServerNode[]): AssetPathMap {
  const paths: AssetPathMap = new Map();
  for (const node of nodes) {
    for (const assetId of node.assetIds) {
      paths.set(assetId, node.path);
    }
  }
  return paths;
}

function treeItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  for (const field of ['results', 'items', 'data', 'children']) {
    if (Array.isArray(record[field])) {
      return record[field];
    }
  }
  return [payload];
}

function isFlatAssetTree(items: unknown[]): boolean {
  return items.some((item) => Boolean(item && typeof item === 'object' && parentKey(item as Record<string, unknown>)));
}

function flatAssetTreeNodes(items: unknown[]): CachedJumpServerNode[] {
  const records = items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  const nodeRecords = records.filter((record) => !isAssetTreeLeaf(record));
  const nodesByKey = new Map<string, Record<string, unknown>>();
  const assetsByParentKey = new Map<string, string[]>();

  for (const record of nodeRecords) {
    const key = treeItemKey(record);
    if (key) {
      nodesByKey.set(key, record);
    }
  }

  for (const record of records.filter(isAssetTreeLeaf)) {
    const parent = parentKey(record);
    const assetId = stringField(record, ['id', 'key', 'value']);
    if (!parent || !assetId) {
      continue;
    }
    const assetIds = assetsByParentKey.get(parent) ?? [];
    assetIds.push(assetId);
    assetsByParentKey.set(parent, assetIds);
  }

  const pathCache = new Map<string, string[]>();
  const buildPath = (record: Record<string, unknown>, seen = new Set<string>()): string[] => {
    const key = treeItemKey(record);
    if (key && pathCache.has(key)) {
      return pathCache.get(key) ?? [];
    }
    const label = treeNodeLabel(record);
    const parent = parentKey(record);
    const parentRecord = parent ? nodesByKey.get(parent) : undefined;
    const path = parentRecord && (!key || !seen.has(key))
      ? [...buildPath(parentRecord, key ? new Set([...seen, key]) : seen), label]
      : [label];
    const normalized = path.filter((part) => part.length > 0);
    if (key) {
      pathCache.set(key, normalized);
    }
    return normalized;
  };

  return nodeRecords
    .map((record) => {
      const key = treeItemKey(record);
      const path = buildPath(record);
      return {
        id: nestedStringField(record, ['meta.data.id']) || key || path.join('/'),
        name: path.at(-1) || treeNodeLabel(record),
        bastionId: '',
        path,
        assetIds: key ? assetsByParentKey.get(key) ?? [] : [],
        raw: record
      };
    })
    .filter((node) => node.path.length > 0);
}

function treeItemKey(record: Record<string, unknown>): string {
  return nestedStringField(record, ['key', 'id', 'value', 'meta.data.key']);
}

function parentKey(record: Record<string, unknown>): string {
  return nestedStringField(record, [
    'pId',
    'pid',
    'parent',
    'parent_key',
    'parentKey',
    'parent_id',
    'parentId',
    'meta.parent',
    'meta.parent_key',
    'meta.parentKey',
    'meta.data.parent',
    'meta.data.parent_key',
    'meta.data.parentKey'
  ]);
}

function treeNodeLabel(record: Record<string, unknown>): string {
  return nestedStringField(record, ['name', 'title', 'label', 'value', 'meta.data.value']);
}

function walkAssetTreeNode(node: unknown, parentPath: string[], nodes: CachedJumpServerNode[]): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  const record = node as Record<string, unknown>;
  if (isAssetTreeLeaf(record)) {
    return;
  }

  const label = stringField(record, ['name', 'title', 'label', 'value']);
  const currentPath = label ? [...parentPath, label] : parentPath;
  const children = treeItems(record.children);
  const assetIds = [
    ...assetIdsFromValue(record.assets),
    ...assetIdsFromValue(record.asset),
    ...children
      .filter((child) => child && typeof child === 'object' && isAssetTreeLeaf(child as Record<string, unknown>))
      .map((child) => stringField(child as Record<string, unknown>, ['id', 'key', 'value']))
      .filter((id) => id.length > 0)
  ];
  if (label && currentPath.length > 0) {
    nodes.push({
      id: stringField(record, ['id', 'key']) || currentPath.join('/'),
      name: label,
      bastionId: '',
      path: currentPath,
      assetIds,
      raw: record
    });
  }
  for (const child of children) {
    if (!child || typeof child !== 'object' || isAssetTreeLeaf(child as Record<string, unknown>)) {
      continue;
    }
    walkAssetTreeNode(child, currentPath, nodes);
  }
}

function assetIdsFromValue(value: unknown): string[] {
  const ids: string[] = [];
  for (const asset of treeItems(value)) {
    if (asset && typeof asset === 'object') {
      const id = stringField(asset as Record<string, unknown>, ['id', 'key', 'value']);
      if (id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function isAssetTreeLeaf(record: Record<string, unknown>): boolean {
  const meta = record.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : {};
  const type = String(record.type || record.kind || record.node_type || meta.type || '').toLowerCase();
  return record.is_asset === true || type === 'asset' || type === 'host';
}

function stringField(record: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return '';
}

function nestedStringField(record: Record<string, unknown>, paths: string[]): string {
  for (const path of paths) {
    let value: unknown = record;
    for (const segment of path.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return '';
}
