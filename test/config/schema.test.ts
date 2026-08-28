import { describe, expect, it } from 'vitest';
import {
  assetTrustKey,
  bastionDisplayName,
  parseAssetCommandTrust,
  parseAssetTrustOverlay,
  parseCachedJumpServerAsset,
  parseCachedJumpServerNode,
  parseJumpServerBastion,
  parseJumpServerBastionList,
  parseJumpServerSettings,
  sanitizeCachedAssetRaw
} from '../../src/config/schema';

describe('JumpServer config schema', () => {
  it('normalizes baseUrl and default settings', () => {
    expect(
      parseJumpServerSettings({
        baseUrl: 'https://jumpserver.example.com/',
        orgId: ' org-1 ',
        username: ' alan ',
        verifyTls: undefined,
        updatedAt: 1
      })
    ).toEqual({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    });
  });

  it('ignores legacy timeout fields from previously saved settings', () => {
    expect(
      parseJumpServerSettings({
        baseUrl: 'https://jumpserver.example.com/',
        orgId: '',
        username: 'alan',
        verifyTls: true,
        connectTimeout: 30,
        updatedAt: 1
      })
    ).toEqual({
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    });
  });

  it('rejects unsupported URLs and blank usernames', () => {
    expect(() => parseJumpServerSettings({ baseUrl: 'ftp://bad', username: 'alan', updatedAt: 1 })).toThrow();
    expect(() => parseJumpServerSettings({ baseUrl: 'https://jms.example.com', username: ' ', updatedAt: 1 })).toThrow();
  });

  it('parses a bastion and fills an empty name from the baseUrl hostname', () => {
    const input = {
      id: '11111111-1111-1111-1111-111111111111',
      name: '  ',
      baseUrl: 'https://jms.prod.example.com/',
      orgId: '',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    };
    expect(parseJumpServerBastion(input)).toMatchObject({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'jms.prod.example.com',
      baseUrl: 'https://jms.prod.example.com'
    });
    expect(parseJumpServerBastionList([input])).toHaveLength(1);
  });

  it('keeps an explicit bastion display name', () => {
    expect(bastionDisplayName(' 生产 ', 'https://jms.example.com')).toBe('生产');
  });

  it('requires bastionId on cached assets and nodes', () => {
    expect(() => parseCachedJumpServerAsset({
      id: 'asset-1',
      name: 'web-1',
      raw: {}
    })).toThrow();
    expect(
      parseCachedJumpServerAsset({
        id: 'asset-1',
        name: 'web-1',
        bastionId: 'b1',
        raw: {}
      })
    ).toMatchObject({ bastionId: 'b1' });
  });

  it('parses cached assets with grouping metadata', () => {
    expect(
      parseCachedJumpServerAsset({
        id: 'asset-1',
        name: 'web-1',
        bastionId: 'b1',
        address: '10.0.0.10',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: 'prod-zone',
        nodePath: ['Production', 'Web'],
        protocolNames: ['ssh'],
        raw: { id: 'asset-1', name: 'web-1' }
      })
    ).toMatchObject({
      id: 'asset-1',
      name: 'web-1',
      bastionId: 'b1',
      nodePath: ['Production', 'Web'],
      protocolNames: ['ssh']
    });
  });

  it('parses cached JumpServer nodes with full path metadata', () => {
    expect(
      parseCachedJumpServerNode({
        id: 'node-middleware',
        name: 'Middleware',
        bastionId: 'b1',
        path: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'],
        assetIds: ['asset-1'],
        raw: { id: 'node-middleware' }
      })
    ).toEqual({
      id: 'node-middleware',
      name: 'Middleware',
      bastionId: 'b1',
      path: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'],
      assetIds: ['asset-1'],
      raw: { id: 'node-middleware' }
    });
  });

  it('parses the three trust levels and falls back to none', () => {
    expect(parseAssetCommandTrust('none')).toBe('none');
    expect(parseAssetCommandTrust('policy')).toBe('policy');
    expect(parseAssetCommandTrust('full')).toBe('full');
    expect(parseAssetCommandTrust('on')).toBe('none');
    expect(parseAssetCommandTrust(true)).toBe('none');
    expect(parseAssetCommandTrust(undefined)).toBe('none');
  });

  it('builds the overlay key from bastionId and assetId', () => {
    expect(assetTrustKey('b1', 'a1')).toBe('b1/a1');
  });

  it('drops overlay entries whose value is not policy or full', () => {
    expect(parseAssetTrustOverlay({
      'b1/a1': 'full',
      'b1/a2': 'policy',
      'b1/a3': 'none',
      'b1/a4': 'yes',
      'b1/a5': 1
    })).toEqual({ 'b1/a1': 'full', 'b1/a2': 'policy' });
    expect(parseAssetTrustOverlay(undefined)).toEqual({});
    expect(parseAssetTrustOverlay([])).toEqual({});
    expect(parseAssetTrustOverlay('junk')).toEqual({});
  });

  it('removes credential-like fields from raw asset metadata', () => {
    expect(
      sanitizeCachedAssetRaw({
        id: 'asset-1',
        password: 'secret',
        token: 'bearer',
        nested: { cookie: 'session', keep: 'value' }
      })
    ).toEqual({
      id: 'asset-1',
      nested: { keep: 'value' }
    });
  });
});
