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

  it('renders disconnected snapshot entries', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'disconnected', rootPath: '/home/root', entries, asset: {} as never })
    });

    const children = await provider.getChildren();

    expect(children.map((child) => child.contextValue)).toEqual(['jumpserverSftpDisconnectedDirectory', 'jumpserverSftpDisconnectedFile']);
  });
});
