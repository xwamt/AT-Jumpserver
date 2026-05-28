import { describe, expect, it } from 'vitest';
import { JumpServerTreeProvider } from '../../src/tree/JumpServerTreeProvider';
import { AssetTreeItem, GroupTreeItem, getAssetOpenKind } from '../../src/tree/TreeItems';

const assets = [
  { id: 'asset-1', name: 'web-1', address: '10.0.0.10', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'Web'], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-2', name: 'db-1', address: '10.0.0.11', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'DB'], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-5', name: 'gateway-1', address: '10.0.0.12', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Gateway', nodePath: ['Production', 'Network', 'Gateway'], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-3', name: 'ops-1', address: '', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Ops', nodePath: [], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-4', name: 'misc-1', address: '', platform: '', category: 'host', type: 'server', zoneName: '', nodePath: [], protocolNames: ['ssh'], raw: {} }
];

describe('JumpServerTreeProvider', () => {
  it('groups root nodes by first nodePath segment, zoneName, and Default', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });

    const roots = await provider.getChildren();

    expect(roots.map((item) => item.label)).toEqual(['Default', 'Ops', 'Production']);
    expect(roots.every((item) => item instanceof GroupTreeItem)).toBe(true);
  });

  it('walks nested nodePath groups down to asset nodes', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });
    const production = (await provider.getChildren()).find((item) => item.label === 'Production') as GroupTreeItem;
    const productionChildren = await provider.getChildren(production);
    const web = productionChildren.find((item) => item.label === 'Web') as GroupTreeItem;
    const webChildren = await provider.getChildren(web);

    expect(productionChildren.map((item) => item.label)).toEqual(['DB', 'Network', 'Web']);
    expect(webChildren).toHaveLength(1);
    expect(webChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((webChildren[0] as AssetTreeItem).asset.id).toBe('asset-1');
  });

  it('walks JumpServer directories deeper than two levels', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });
    const production = (await provider.getChildren()).find((item) => item.label === 'Production') as GroupTreeItem;
    const network = (await provider.getChildren(production)).find((item) => item.label === 'Network') as GroupTreeItem;
    const gateway = (await provider.getChildren(network)).find((item) => item.label === 'Gateway') as GroupTreeItem;
    const gatewayChildren = await provider.getChildren(gateway);

    expect(gateway.path).toEqual(['Production', 'Network', 'Gateway']);
    expect(gatewayChildren).toHaveLength(1);
    expect(gatewayChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((gatewayChildren[0] as AssetTreeItem).asset.id).toBe('asset-5');
  });

  it('uses address or platform as asset description', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });
    const ops = (await provider.getChildren()).find((item) => item.label === 'Ops') as GroupTreeItem;
    const [asset] = await provider.getChildren(ops);

    expect(asset).toBeInstanceOf(AssetTreeItem);
    expect((asset as AssetTreeItem).description).toBe('Linux');
  });


  it('marks MySQL and unsupported database assets without hiding them', () => {
    const mysql = new AssetTreeItem({
      id: 'mysql-1',
      name: 'mysql-1',
      address: 'db.example.com',
      platform: 'MySQL',
      category: 'database',
      type: 'mysql',
      zoneName: '',
      nodePath: [],
      protocolNames: [],
      raw: {}
    });
    const redis = new AssetTreeItem({
      id: 'redis-1',
      name: 'redis-1',
      address: 'redis.example.com',
      platform: 'Redis6+',
      category: 'database',
      type: 'redis',
      zoneName: '',
      nodePath: [],
      protocolNames: [],
      raw: {}
    });

    expect(getAssetOpenKind(mysql.asset)).toBe('mysql');
    expect(mysql.contextValue).toBe('jumpserverMysqlAsset');
    expect(mysql.description).toBe('db.example.com - MySQL');
    expect(getAssetOpenKind(redis.asset)).toBe('unsupported');
    expect(redis.contextValue).toBe('jumpserverUnsupportedAsset');
  });

  it('routes MySQL database assets to the terminal even if cached protocols include ssh', () => {
    const mysql = new AssetTreeItem({
      id: 'mysql-1',
      name: 'mysql-1',
      address: 'db.example.com',
      platform: 'MySQL',
      category: 'database',
      type: 'mysql',
      zoneName: '',
      nodePath: [],
      protocolNames: ['ssh'],
      raw: {}
    });

    expect(getAssetOpenKind(mysql.asset)).toBe('mysql');
    expect(mysql.contextValue).toBe('jumpserverMysqlAsset');
  });

  it('renders JumpServer node tree first, then attaches synced assets to matching nodes', async () => {
    const provider = new JumpServerTreeProvider({
      listCachedAssetNodes: async () => [
        { id: 'node-default', name: 'DEFAULT', path: ['DEFAULT'], assetIds: [], raw: {} },
        { id: 'node-prod', name: 'PROD', path: ['DEFAULT', 'PROD'], assetIds: [], raw: {} },
        { id: 'node-offline-prod', name: 'offline-prod', path: ['DEFAULT', 'PROD', 'offline-prod'], assetIds: [], raw: {} },
        { id: 'node-middleware', name: 'Middleware', path: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'], assetIds: ['asset-1'], raw: {} }
      ],
      listCachedAssets: async () => [
        { id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Middleware', nodePath: ['Middleware'], protocolNames: ['ssh'], raw: {} }
      ]
    });

    const [root] = await provider.getChildren();
    const [prod] = await provider.getChildren(root as GroupTreeItem);
    const [offlineProd] = await provider.getChildren(prod as GroupTreeItem);
    const [middleware] = await provider.getChildren(offlineProd as GroupTreeItem);
    const middlewareChildren = await provider.getChildren(middleware as GroupTreeItem);

    expect(root.label).toBe('DEFAULT');
    expect(prod.label).toBe('PROD');
    expect(offlineProd.label).toBe('offline-prod');
    expect(middleware.label).toBe('Middleware');
    expect(middlewareChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((middlewareChildren[0] as AssetTreeItem).asset.id).toBe('asset-1');
  });
});
