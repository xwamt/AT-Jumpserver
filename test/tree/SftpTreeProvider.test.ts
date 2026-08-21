import { describe, expect, it } from 'vitest';
import { SftpTreeProvider } from '../../src/tree/SftpTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpPlaceholderTreeItem } from '../../src/tree/SftpTreeItems';

const entries = [
  { name: 'app', path: '/home/root/app', type: 'directory' as const },
  { name: 'readme.txt', path: '/home/root/readme.txt', type: 'file' as const, size: 12 }
];

describe('SftpTreeProvider', () => {
  it('shows a placeholder with no active SFTP asset', async () => {
    const provider = new SftpTreeProvider({ getState: () => ({ kind: 'none' }) });
    const children = await provider.getChildren();

    expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
    expect(children[0].label).toBe('Open files from a JumpServer asset');
  });

  it('shows a pending placeholder without listing the remote root', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'pending', asset: { name: 'web-1' } as never }),
      listDirectory: async () => { throw new Error('must not list'); }
    });
    const children = await provider.getChildren();
    expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
    expect(children[0].label).toBe('Files for web-1 connect on first refresh');
  });

  it('renders active root entries with a parent entry', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/root', asset: {} as never }),
      listDirectory: async () => entries
    });

    const children = await provider.getChildren();

    expect(children[0].label).toBe('..');
    expect(children[1]).toBeInstanceOf(SftpDirectoryTreeItem);
    expect(children[2]).toBeInstanceOf(SftpFileTreeItem);
  });

  it('formats file sizes with scaled units', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/root', asset: {} as never }),
      listDirectory: async () => [
        { name: 'small.txt', path: '/home/root/small.txt', type: 'file' as const, size: 512 },
        { name: 'medium.log', path: '/home/root/medium.log', type: 'file' as const, size: 1536 },
        { name: 'large.bin', path: '/home/root/large.bin', type: 'file' as const, size: 1048576 }
      ]
    });

    const children = await provider.getChildren();

    expect((children[1] as SftpFileTreeItem).description).toBe('512 B');
    expect((children[2] as SftpFileTreeItem).description).toBe('1.5 KB');
    expect((children[3] as SftpFileTreeItem).description).toBe('1 MB');
  });

  it('renders disconnected snapshot entries', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'disconnected', rootPath: '/home/root', entries, asset: {} as never })
    });

    const children = await provider.getChildren();

    expect(children.map((child) => child.contextValue)).toEqual(['jumpserverSftpDisconnectedDirectory', 'jumpserverSftpDisconnectedFile']);
  });
});
