export type JumpServerConnectionKind = 'ssh' | 'mysql' | 'unsupported';
export type JumpServerConnectionProtocol = 'ssh' | 'mysql';

export interface AssetLikeForConnection {
  name?: string;
  category?: string;
  type?: string;
  platform?: string;
  protocolNames?: string[];
}

export function isDatabaseAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  return values.includes('database') || values.some((value) => [
    'mysql',
    'mariadb',
    'postgresql',
    'redis',
    'oracle',
    'sqlserver'
  ].includes(value));
}

export function isMysqlAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  if (hasMysqlMarker(values)) {
    return true;
  }
  return isDatabaseAsset(asset) && hasMysqlMarker([String(asset.name ?? '').toLowerCase()]);
}

export function getAssetConnectionKind(asset: AssetLikeForConnection): JumpServerConnectionKind {
  if (isMysqlAsset(asset)) {
    return 'mysql';
  }
  if (lowerProtocols(asset).includes('ssh') || isSshCandidateAsset(asset)) {
    return 'ssh';
  }
  return 'unsupported';
}

export function connectionKindLabel(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'MySQL';
  }
  if (kind === 'ssh') {
    return 'SSH';
  }
  return 'Unsupported';
}

export function connectionKindProtocol(kind: JumpServerConnectionKind): JumpServerConnectionProtocol {
  if (kind === 'ssh' || kind === 'mysql') {
    return kind;
  }
  throw new Error('Unsupported JumpServer asset type.');
}

function lowerValues(asset: AssetLikeForConnection): string[] {
  return [
    asset.type,
    asset.platform,
    asset.category,
    ...lowerProtocols(asset)
  ].map((value) => String(value ?? '').toLowerCase()).filter(Boolean);
}

function lowerProtocols(asset: AssetLikeForConnection): string[] {
  return (asset.protocolNames ?? []).map((value) => value.toLowerCase());
}

function isSshCandidateAsset(asset: AssetLikeForConnection): boolean {
  if (isDatabaseAsset(asset)) {
    return false;
  }
  const values = lowerValues(asset);
  return values.includes('host') || values.includes('server') || values.includes('linux') || values.includes('windows');
}

function hasMysqlMarker(values: string[]): boolean {
  return values.some((value) => value.includes('mysql') || value.includes('mariadb'));
}
