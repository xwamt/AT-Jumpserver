import { describe, expect, it } from 'vitest';
import {
  connectionKindLabel,
  connectionKindProtocol,
  getAssetConnectionKind,
  isDatabaseAsset,
  isMysqlAsset
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

  it('detects unsupported database assets without hiding them', () => {
    expect(isDatabaseAsset({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe(true);
    expect(getAssetConnectionKind({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe('unsupported');
  });

  it('routes MySQL before SSH when cached metadata is mixed', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'mysql',
      platform: 'MySQL',
      protocolNames: ['ssh']
    })).toBe('mysql');
  });

  it('maps supported connection kinds to labels and protocols', () => {
    expect(connectionKindLabel('ssh')).toBe('SSH');
    expect(connectionKindLabel('mysql')).toBe('MySQL');
    expect(connectionKindProtocol('ssh')).toBe('ssh');
    expect(connectionKindProtocol('mysql')).toBe('mysql');
    expect(() => connectionKindProtocol('unsupported')).toThrow('Unsupported JumpServer asset type.');
  });
});
