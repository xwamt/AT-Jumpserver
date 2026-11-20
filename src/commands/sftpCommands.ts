import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { JumpServerSftpManager } from '../sftp/JumpServerSftpManager';
import { dirname, joinRemotePath, remoteBasename } from '../sftp/RemotePath';
import type { SftpEditSessionManager } from '../sftp/SftpEditSessionManager';
import { assertTextFileEditable, DEFAULT_SFTP_EDIT_MAX_BYTES } from '../sftp/SftpFileGuards';
import { openRemotePreviewFile, type SftpPreviewDocumentStore } from '../sftp/SftpPreview';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from '../tree/SftpTreeItems';
import type { SftpTreeProvider } from '../tree/SftpTreeProvider';
import { getAssetOpenKind } from '../tree/TreeItems';
import { showTimedNotification } from '../utils/notifications';

export interface SftpCommandsDeps {
  context: vscode.ExtensionContext;
  sftpManager: JumpServerSftpManager;
  sftpTreeProvider: SftpTreeProvider;
  sftpPreviewStore: SftpPreviewDocumentStore;
  sftpEditManager: SftpEditSessionManager;
  terminalContext: TerminalContextRegistry;
  runCommand: (command: () => Promise<void>) => Promise<void>;
}

/**
 * Registers SFTP file browser, transfer, preview, remote edit, and terminal navigation commands.
 */
export function registerSftpCommands(deps: SftpCommandsDeps): vscode.Disposable[] {
  const {
    context,
    sftpManager,
    sftpTreeProvider,
    sftpPreviewStore,
    sftpEditManager,
    terminalContext,
    runCommand
  } = deps;

  return [
    vscode.commands.registerCommand('jumpserverManager.sftp.refresh', async () => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        await sftpManager.refreshDirectory();
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.goUp', async () => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        await sftpManager.changeToParentDirectory();
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.goToPath', async () => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        const state = sftpManager.getState();
        const currentPath = state.kind === 'active' || state.kind === 'disconnected' ? state.rootPath : '/';
        const targetPath = await vscode.window.showInputBox({
          prompt: t('Remote directory path'),
          value: currentPath,
          ignoreFocusOut: true
        });
        const trimmed = targetPath?.trim();
        if (!trimmed) {
          return;
        }
        await sftpManager.changeDirectory(trimmed);
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.upload', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        const sources = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
        if (!sources?.length) {
          return;
        }
        const targetDirectory = getSftpTargetDirectory(sftpManager, item);
        for (const source of sources) {
          await sftpManager.uploadFile(source.fsPath, joinRemotePath(targetDirectory, localBasename(source.fsPath)));
        }
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.download', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(item.entry.name) });
        if (!target) {
          return;
        }
        await sftpManager.downloadFile(item.entry.path, target.fsPath, item.entry.type === 'directory');
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.preview', async (item?: SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const allowed = await ensurePreviewEditAllowed(sftpManager, item);
        await openRemotePreviewFile({
          storageUri: context.globalStorageUri ?? context.extensionUri,
          remotePath: item.entry.path,
          previewStore: sftpPreviewStore,
          initialContent: allowed.sample,
          downloadFile: (remotePath, localPath) => sftpManager.downloadFile(remotePath, localPath, false),
          openUri: async (uri, options) => {
            await vscode.commands.executeCommand('vscode.open', uri, options);
          }
        });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const allowed = await ensurePreviewEditAllowed(sftpManager, item);
        await sftpEditManager.openRemoteFile(item.entry.path, { initialContent: allowed.sample });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.delete', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const deleteAction = t('Delete');
        const answer = await vscode.window.showWarningMessage(
          t('Delete {path}?', { path: item.entry.path }),
          { modal: true },
          deleteAction
        );
        if (answer !== deleteAction) {
          return;
        }
        await sftpManager.deleteEntry(item.entry);
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.rename', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const nextName = await vscode.window.showInputBox({ prompt: t('New name'), value: item.entry.name });
        if (!nextName || nextName === item.entry.name) {
          return;
        }
        await sftpManager.rename(item.entry.path, joinRemotePath(dirname(item.entry.path), nextName));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.newFolder', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        const name = await vscode.window.showInputBox({ prompt: t('Folder name') });
        if (!name) {
          return;
        }
        await sftpManager.mkdir(joinRemotePath(getSftpTargetDirectory(sftpManager, item), name));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.newFile', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runCommand(async () => {
        if (!await ensureSftpAssetOpen(sftpManager)) {
          return;
        }
        const name = await vscode.window.showInputBox({ prompt: t('File name') });
        if (!name) {
          return;
        }
        await sftpManager.createFile(joinRemotePath(getSftpTargetDirectory(sftpManager, item), name));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.copyPath', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        await vscode.env.clipboard.writeText(item.entry.path);
        showTimedNotification(t('Remote path copied.'));
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.sftp.cdToDirectory', async (item?: SftpDirectoryTreeItem) => {
      if (!item) {
        return;
      }
      await runCommand(async () => {
        const active = terminalContext.getActive();
        if (!active || !active.connected || getAssetOpenKind(active.asset) !== 'ssh') {
          showTimedNotification(t('Connect an SSH JumpServer terminal first.'), 'warning');
          return;
        }
        active.write(`cd ${quotePosixShellArg(item.entry.path)}\r`);
      });
    })
  ];
}

async function ensureSftpAssetOpen(manager: JumpServerSftpManager): Promise<boolean> {
  if (manager.getState().kind !== 'none') {
    return true;
  }
  showTimedNotification(t('Open files from a JumpServer asset first.'), 'warning');
  return false;
}

async function ensurePreviewEditAllowed(
  manager: JumpServerSftpManager,
  item: SftpFileTreeItem
): Promise<{ size: number; sample: Buffer }> {
  if (!await ensureSftpAssetOpen(manager)) {
    throw new Error(t('Open files from a JumpServer asset first.'));
  }
  const stat = item.entry.size === undefined
    ? await manager.stat(item.entry.path)
    : { size: item.entry.size, modifiedAt: item.entry.modifiedAt ?? 0 };
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size });
  const sample = await manager.readFile(item.entry.path, Math.min(DEFAULT_SFTP_EDIT_MAX_BYTES, Math.max(stat.size, 1)));
  assertTextFileEditable({ remotePath: item.entry.path, size: stat.size, sample });
  return { size: stat.size, sample };
}

function getSftpTargetDirectory(
  manager: JumpServerSftpManager,
  item?: SftpDirectoryTreeItem | SftpFileTreeItem
): string {
  if (item instanceof SftpDirectoryTreeItem) {
    return item.entry.path;
  }
  if (item instanceof SftpFileTreeItem) {
    return dirname(item.entry.path);
  }
  const state = manager.getState();
  if (state.kind === 'active' || state.kind === 'disconnected') {
    return state.rootPath;
  }
  throw new Error(t('No active JumpServer SFTP asset.'));
}

function localBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || remoteBasename(path);
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
