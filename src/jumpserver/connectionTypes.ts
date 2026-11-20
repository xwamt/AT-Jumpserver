import type { JumpServerConnectionProtocol } from './types';
export type { JumpServerConnectionProtocol };
export type JumpServerConnectionKind = 'ssh' | 'mysql' | 'redis' | 'sftp' | 'rdp' | 'unsupported' | (string & {});

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

export function isRedisAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  if (hasRedisMarker(values)) {
    return true;
  }
  return isDatabaseAsset(asset) && hasRedisMarker([String(asset.name ?? '').toLowerCase()]);
}

export function getAssetConnectionKind(asset: AssetLikeForConnection): JumpServerConnectionKind {
  // 1. Specific database detection takes precedence
  if (isMysqlAsset(asset)) {
    return 'mysql';
  }
  if (isRedisAsset(asset)) {
    return 'redis';
  }
  if (isDatabaseAsset(asset)) {
    const protocols = lowerProtocols(asset);
    for (const p of protocols) {
      if (p !== 'ssh') {
        return p;
      }
    }
    const values = lowerValues(asset);
    for (const db of ['postgresql', 'oracle', 'sqlserver', 'mongodb', 'dameng', 'db2', 'clickhouse']) {
      if (values.some((v) => v.includes(db))) {
        return db;
      }
    }
    return 'database';
  }

  // 2. Explicit protocol definitions
  const protocols = lowerProtocols(asset);
  if (protocols.length > 0) {
    if (protocols.includes('ssh')) {
      return 'ssh';
    }
    if (protocols.includes('rdp')) {
      return 'rdp';
    }
    if (protocols.includes('vnc')) {
      return 'vnc';
    }
    if (protocols.includes('telnet')) {
      return 'telnet';
    }
    return protocols[0];
  }

  // 3. Platform / category hints
  const values = lowerValues(asset);
  if (values.includes('rdp') || values.includes('windows')) {
    return 'rdp';
  }
  if (values.includes('vnc')) {
    return 'vnc';
  }
  if (values.includes('k8s') || values.includes('kubernetes')) {
    return 'k8s';
  }
  if (values.includes('web')) {
    return 'web';
  }

  // 4. SSH candidate (Linux, host, server)
  if (isSshCandidateAsset(asset)) {
    return 'ssh';
  }
  return 'unsupported';
}

export function connectionKindLabel(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql' || kind === 'mariadb') {
    return 'MySQL';
  }
  if (kind === 'redis') {
    return 'Redis';
  }
  if (kind === 'ssh') {
    return 'SSH';
  }
  if (kind === 'sftp') {
    return 'SFTP';
  }
  if (kind === 'rdp') {
    return 'RDP';
  }
  if (kind === 'vnc') {
    return 'VNC';
  }
  if (kind === 'telnet') {
    return 'Telnet';
  }
  if (kind === 'k8s' || kind === 'kubernetes') {
    return 'Kubernetes';
  }
  if (kind === 'postgresql') {
    return 'PostgreSQL';
  }
  if (kind === 'oracle') {
    return 'Oracle';
  }
  if (kind === 'sqlserver') {
    return 'SQL Server';
  }
  if (kind === 'mongodb') {
    return 'MongoDB';
  }
  if (kind === 'dameng') {
    return 'Dameng';
  }
  if (kind === 'db2') {
    return 'DB2';
  }
  if (kind === 'unsupported' || !kind) {
    return 'Unsupported';
  }
  return String(kind).toUpperCase();
}

export function connectionKindProtocol(kind: JumpServerConnectionKind): JumpServerConnectionProtocol {
  if (kind && kind !== 'unsupported') {
    return kind as JumpServerConnectionProtocol;
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
  if (values.includes('windows') || values.includes('vnc') || values.includes('web')) {
    return false;
  }
  return values.includes('host') || values.includes('server') || values.includes('linux');
}

function hasMysqlMarker(values: string[]): boolean {
  return values.some((value) => value.includes('mysql') || value.includes('mariadb'));
}

function hasRedisMarker(values: string[]): boolean {
  return values.some((value) => value.includes('redis'));
}
