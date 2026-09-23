import { describe, expect, it } from 'vitest';
import {
  connectionKindLabel,
  connectionKindProtocol,
  getAssetConnectionKind,
  isDatabaseAsset,
  isMysqlAsset,
  isRedisAsset
} from '../../src/jumpserver/connectionTypes';

describe('connectionTypes', () => {
  it('detects MySQL assets from protocol and database metadata', () => {
    expect(isMysqlAsset({ protocolNames: ['mysql'] })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: 'mysql', platform: 'MySQL' })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: '', platform: '', name: 'prod-mariadb-01' })).toBe(true);
  });

  it('does not treat SSH hosts with mysql in their name as MySQL assets', () => {
    expect(isMysqlAsset({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'mysql-backup-host',
      protocolNames: ['ssh']
    })).toBe(false);
  });

  it('detects Redis assets from protocol and database metadata', () => {
    expect(isRedisAsset({ protocolNames: ['redis'] })).toBe(true);
    expect(isRedisAsset({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe(true);
    expect(isRedisAsset({ category: 'database', type: '', platform: '', name: 'cache-redis-01' })).toBe(true);
    expect(isDatabaseAsset({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe(true);
    expect(getAssetConnectionKind({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe('redis');
  });

  it('detects PostgreSQL, RDP, VNC, Kubernetes, and Web assets correctly (P0-2)', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'postgresql',
      platform: 'PostgreSQL',
      protocolNames: ['postgresql']
    })).toBe('postgresql');

    expect(getAssetConnectionKind({
      category: 'host',
      type: 'server',
      platform: 'Windows',
      protocolNames: ['rdp']
    })).toBe('rdp');

    expect(getAssetConnectionKind({
      category: 'host',
      type: 'server',
      platform: 'VNC',
      protocolNames: ['vnc']
    })).toBe('vnc');

    expect(getAssetConnectionKind({
      category: 'k8s',
      type: 'kubernetes',
      protocolNames: ['k8s']
    })).toBe('k8s');

    expect(getAssetConnectionKind({
      category: 'web',
      type: 'web',
      protocolNames: ['web']
    })).toBe('web');
  });

  it('does not treat SSH hosts with redis in their name as Redis assets', () => {
    expect(isRedisAsset({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'redis-backup-host',
      protocolNames: ['ssh']
    })).toBe(false);
  });

  it('treats host server assets without cached protocols as SSH candidates', () => {
    expect(getAssetConnectionKind({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'uat-service',
      protocolNames: []
    })).toBe('ssh');
  });

  it('routes MySQL before Redis/SSH when metadata is mixed', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'mysql',
      platform: 'MySQL',
      protocolNames: ['ssh']
    })).toBe('mysql');
  });

  it('routes Redis before SSH when metadata is mixed', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'redis',
      platform: 'Redis',
      protocolNames: ['ssh', 'redis']
    })).toBe('redis');
  });

  it('maps supported connection kinds to labels and protocols', () => {
    expect(connectionKindLabel('ssh')).toBe('SSH');
    expect(connectionKindLabel('mysql')).toBe('MySQL');
    expect(connectionKindLabel('redis')).toBe('Redis');
    expect(connectionKindProtocol('ssh')).toBe('ssh');
    expect(connectionKindProtocol('mysql')).toBe('mysql');
    expect(connectionKindProtocol('redis')).toBe('redis');
    expect(() => connectionKindProtocol('unsupported')).toThrow('Unsupported JumpServer asset type.');
  });
});
