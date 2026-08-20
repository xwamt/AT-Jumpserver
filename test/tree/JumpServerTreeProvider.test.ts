import { describe, expect, it } from 'vitest';
import { BastionTreeItem } from '../../src/tree/BastionTreeItem';
import { JumpServerTreeProvider } from '../../src/tree/JumpServerTreeProvider';
import { AssetTreeItem, GroupTreeItem, getAssetOpenKind } from '../../src/tree/TreeItems';

const b1Bastion = {
  id: 'b1',
  name: 'Prod JMS',
  baseUrl: 'https://prod.example.com',
  orgId: '',
  username: 'a',
  verifyTls: true,
  updatedAt: 1
};

const assets = [
  { id: 'asset-1', name: 'web-1', address: '10.0.0.10', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'Web'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} },
  { id: 'asset-2', name: 'db-1', address: '10.0.0.11', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'DB'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} },
  { id: 'asset-5', name: 'gateway-1', address: '10.0.0.12', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Gateway', nodePath: ['Production', 'Network', 'Gateway'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} },
  { id: 'asset-3', name: 'ops-1', address: '', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Ops', nodePath: [], protocolNames: ['ssh'], bastionId: 'b1', raw: {} },
  { id: 'asset-4', name: 'misc-1', address: '', platform: '', category: 'host', type: 'server', zoneName: '', nodePath: [], protocolNames: ['ssh'], bastionId: 'b1', raw: {} }
];

const prod = '11111111-1111-1111-1111-111111111111';
const testId = '22222222-2222-2222-2222-222222222222';
const shared = (bastionId: string, name: string) => ({
  id: 'asset-1',
  name,
  address: '10.0.0.10',
  platform: 'Linux',
  category: 'host',
  type: 'server',
  zoneName: 'DEFAULT',
  nodePath: ['DEFAULT'],
  protocolNames: ['ssh'],
  bastionId,
  raw: {}
});

describe('JumpServerTreeProvider', () => {
  it('uses one root per bastion and unique ids when asset ids collide', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [
        { id: prod, name: 'Prod JMS', baseUrl: 'https://prod.example.com', orgId: '', username: 'a', verifyTls: true, updatedAt: 1 },
        { id: testId, name: 'Test JMS', baseUrl: 'https://test.example.com', orgId: '', username: 'a', verifyTls: true, updatedAt: 1 }
      ],
      listCachedAssets: async () => [shared(prod, 'prod-web'), shared(testId, 'test-web')],
      listCachedAssetNodes: async () => []
    });

    const roots = await provider.getChildren();
    expect(roots.map((item) => item.label)).toEqual(['Prod JMS', 'Test JMS']);
    expect(roots[0].id).toBe(`bastion:${prod}`);
    const prodRoot = roots[0] as BastionTreeItem;
    const testRoot = roots[1] as BastionTreeItem;
    const prodDefault = (await provider.getChildren(prodRoot)).find((item) => item.label === 'DEFAULT') as GroupTreeItem;
    const testDefault = (await provider.getChildren(testRoot)).find((item) => item.label === 'DEFAULT') as GroupTreeItem;
    const [prodAsset] = await provider.getChildren(prodDefault);
    const [testAsset] = await provider.getChildren(testDefault);
    expect(prodAsset.id).toBe(`asset:${prod}/asset-1`);
    expect(testAsset.id).toBe(`asset:${testId}/asset-1`);
    expect((prodAsset as AssetTreeItem).asset.bastionId).toBe(prod);
  });

  it('shows an empty-state row when no bastions are configured', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [],
      listCachedAssets: async () => []
    });
    const roots = await provider.getChildren();
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('Add JumpServer to get started');
  });

  it('groups root nodes by first nodePath segment, zoneName, and Default', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [b1Bastion],
      listCachedAssets: async () => assets
    });

    const [bastionRoot] = await provider.getChildren();
    const roots = await provider.getChildren(bastionRoot);

    expect(roots.map((item) => item.label)).toEqual(['Default', 'Ops', 'Production']);
    expect(roots.every((item) => item instanceof GroupTreeItem)).toBe(true);
  });

  it('walks nested nodePath groups down to asset nodes', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [b1Bastion],
      listCachedAssets: async () => assets
    });
    const [bastionRoot] = await provider.getChildren();
    const production = (await provider.getChildren(bastionRoot)).find((item) => item.label === 'Production') as GroupTreeItem;
    const productionChildren = await provider.getChildren(production);
    const web = productionChildren.find((item) => item.label === 'Web') as GroupTreeItem;
    const webChildren = await provider.getChildren(web);

    expect(productionChildren.map((item) => item.label)).toEqual(['DB', 'Network', 'Web']);
    expect(webChildren).toHaveLength(1);
    expect(webChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((webChildren[0] as AssetTreeItem).asset.id).toBe('asset-1');
  });

  it('walks JumpServer directories deeper than two levels', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [b1Bastion],
      listCachedAssets: async () => assets
    });
    const [bastionRoot] = await provider.getChildren();
    const production = (await provider.getChildren(bastionRoot)).find((item) => item.label === 'Production') as GroupTreeItem;
    const network = (await provider.getChildren(production)).find((item) => item.label === 'Network') as GroupTreeItem;
    const gateway = (await provider.getChildren(network)).find((item) => item.label === 'Gateway') as GroupTreeItem;
    const gatewayChildren = await provider.getChildren(gateway);

    expect(gateway.path).toEqual(['Production', 'Network', 'Gateway']);
    expect(gatewayChildren).toHaveLength(1);
    expect(gatewayChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((gatewayChildren[0] as AssetTreeItem).asset.id).toBe('asset-5');
  });

  it('uses address or platform as asset description', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [b1Bastion],
      listCachedAssets: async () => assets
    });
    const [bastionRoot] = await provider.getChildren();
    const ops = (await provider.getChildren(bastionRoot)).find((item) => item.label === 'Ops') as GroupTreeItem;
    const [asset] = await provider.getChildren(ops);

    expect(asset).toBeInstanceOf(AssetTreeItem);
    expect((asset as AssetTreeItem).description).toBe('Linux');
  });


  it('marks MySQL, Redis, and unsupported database assets without hiding them', () => {
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
      bastionId: 'b1', raw: {}
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
      bastionId: 'b1', raw: {}
    });
    const postgresql = new AssetTreeItem({
      id: 'pg-1',
      name: 'pg-1',
      address: 'pg.example.com',
      platform: 'PostgreSQL',
      category: 'database',
      type: 'postgresql',
      zoneName: '',
      nodePath: [],
      protocolNames: [],
      bastionId: 'b1', raw: {}
    });

    expect(getAssetOpenKind(mysql.asset)).toBe('mysql');
    expect(mysql.contextValue).toBe('jumpserverMysqlAsset');
    expect(mysql.description).toBe('db.example.com - MySQL');
    expect(mysql.tooltip).toBe('mysql-1 (db.example.com) - MySQL');
    expect(getAssetOpenKind(redis.asset)).toBe('redis');
    expect(redis.contextValue).toBe('jumpserverRedisAsset');
    expect(redis.description).toBe('redis.example.com - Redis');
    expect(redis.tooltip).toBe('redis-1 (redis.example.com) - Redis');
    expect(getAssetOpenKind(postgresql.asset)).toBe('unsupported');
    expect(postgresql.contextValue).toBe('jumpserverUnsupportedAsset');
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
      bastionId: 'b1', raw: {}
    });

    expect(getAssetOpenKind(mysql.asset)).toBe('mysql');
    expect(mysql.contextValue).toBe('jumpserverMysqlAsset');
  });

  it('renders JumpServer node tree first, then attaches synced assets to matching nodes', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [b1Bastion],
      listCachedAssetNodes: async () => [
        { id: 'node-default', name: 'DEFAULT', path: ['DEFAULT'], assetIds: [], bastionId: 'b1', raw: {} },
        { id: 'node-prod', name: 'PROD', path: ['DEFAULT', 'PROD'], assetIds: [], bastionId: 'b1', raw: {} },
        { id: 'node-offline-prod', name: 'offline-prod', path: ['DEFAULT', 'PROD', 'offline-prod'], assetIds: [], bastionId: 'b1', raw: {} },
        { id: 'node-middleware', name: 'Middleware', path: ['DEFAULT', 'PROD', 'offline-prod', 'Middleware'], assetIds: ['asset-1'], bastionId: 'b1', raw: {} }
      ],
      listCachedAssets: async () => [
        { id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'Middleware', nodePath: ['Middleware'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} }
      ]
    });

    const [bastionRoot] = await provider.getChildren();
    const [root] = await provider.getChildren(bastionRoot);
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

  it('uses synced asset nodePath to restore hierarchy when cached JumpServer nodes are flat', async () => {
    const provider = new JumpServerTreeProvider({
      listBastions: async () => [b1Bastion],
      listCachedAssetNodes: async () => [
        { id: 'node-default', name: 'DEFAULT', path: ['DEFAULT'], assetIds: [], bastionId: 'b1', raw: {} },
        { id: 'node-prod', name: 'PROD', path: ['PROD'], assetIds: [], bastionId: 'b1', raw: {} },
        { id: 'node-service', name: 'service', path: ['service'], assetIds: ['asset-1'], bastionId: 'b1', raw: {} }
      ],
      listCachedAssets: async () => [
        { id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'service', nodePath: ['DEFAULT', 'PROD', 'service'], protocolNames: ['ssh'], bastionId: 'b1', raw: {} }
      ]
    });

    const [bastionRoot] = await provider.getChildren();
    const roots = await provider.getChildren(bastionRoot);
    const defaultRoot = roots.find((item) => item.label === 'DEFAULT') as GroupTreeItem;
    const prod = (await provider.getChildren(defaultRoot)).find((item) => item.label === 'PROD') as GroupTreeItem;
    const service = (await provider.getChildren(prod)).find((item) => item.label === 'service') as GroupTreeItem;
    const serviceChildren = await provider.getChildren(service);

    expect(roots.map((item) => item.label)).toEqual(['DEFAULT']);
    expect(prod.path).toEqual(['DEFAULT', 'PROD']);
    expect(service.path).toEqual(['DEFAULT', 'PROD', 'service']);
    expect(serviceChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((serviceChildren[0] as AssetTreeItem).asset.id).toBe('asset-1');
  });
});
