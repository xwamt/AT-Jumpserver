import { describe, expect, it } from 'vitest';
import {
  parseCachedJumpServerNode,
  parseCachedJumpServerAsset,
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

  it('parses cached assets with grouping metadata', () => {
    expect(
      parseCachedJumpServerAsset({
        id: 'asset-1',
        name: 'web-1',
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
      nodePath: ['Production', 'Web'],
      protocolNames: ['ssh']
    });
  });

  it('parses cached JumpServer nodes with full path metadata', () => {
    expect(
      parseCachedJumpServerNode({
        id: 'node-middleware',
        name: 'Middleware',
        path: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'],
        assetIds: ['asset-1'],
        raw: { id: 'node-middleware' }
      })
    ).toEqual({
      id: 'node-middleware',
      name: 'Middleware',
      path: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'],
      assetIds: ['asset-1'],
      raw: { id: 'node-middleware' }
    });
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
