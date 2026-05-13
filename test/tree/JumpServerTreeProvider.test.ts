import { describe, expect, it } from 'vitest';
import { JumpServerTreeProvider } from '../../src/tree/JumpServerTreeProvider';
import { AssetTreeItem, GroupTreeItem } from '../../src/tree/TreeItems';

const assets = [
  { id: 'asset-1', name: 'web-1', address: '10.0.0.10', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'Web'], protocolNames: ['ssh'], raw: {} },
  { id: 'asset-2', name: 'db-1', address: '10.0.0.11', platform: 'Linux', category: 'host', type: 'server', zoneName: 'zone-a', nodePath: ['Production', 'DB'], protocolNames: ['ssh'], raw: {} },
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

    expect(productionChildren.map((item) => item.label)).toEqual(['DB', 'Web']);
    expect(webChildren).toHaveLength(1);
    expect(webChildren[0]).toBeInstanceOf(AssetTreeItem);
    expect((webChildren[0] as AssetTreeItem).asset.id).toBe('asset-1');
  });

  it('uses address or platform as asset description', async () => {
    const provider = new JumpServerTreeProvider({ listCachedAssets: async () => assets });
    const ops = (await provider.getChildren()).find((item) => item.label === 'Ops') as GroupTreeItem;
    const [asset] = await provider.getChildren(ops);

    expect(asset).toBeInstanceOf(AssetTreeItem);
    expect((asset as AssetTreeItem).description).toBe('Linux');
  });
});
