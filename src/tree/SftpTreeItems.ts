import * as vscode from 'vscode';
import { formatFileSize } from '../sftp/FileSize';
import type { JumpServerSftpEntry } from '../sftp/SftpTypes';
import { t } from '../i18n/t';

export class SftpPlaceholderTreeItem extends vscode.TreeItem {
  constructor(label: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'jumpserverSftpPlaceholder';
    if (command) {
      this.command = command;
    }
  }
}

export class SftpParentDirectoryTreeItem extends vscode.TreeItem {
  constructor() {
    super('..', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'jumpserverSftpParentDirectory';
    this.command = { command: 'jumpserverManager.sftp.goUp', title: t('Go Up') };
  }
}


export class SftpDirectoryTreeItem extends vscode.TreeItem {
  constructor(
    readonly entry: JumpServerSftpEntry,
    disconnected = false
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = disconnected ? 'jumpserverSftpDisconnectedDirectory' : 'jumpserverSftpDirectory';
    this.tooltip = entry.path;
  }
}

export class SftpFileTreeItem extends vscode.TreeItem {
  constructor(
    readonly entry: JumpServerSftpEntry,
    disconnected = false
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = disconnected ? 'jumpserverSftpDisconnectedFile' : 'jumpserverSftpFile';
    this.description = entry.size === undefined ? undefined : formatFileSize(entry.size);
    this.tooltip = entry.path;
    if (!disconnected) {
      this.command = {
        command: 'jumpserverManager.sftp.preview',
        title: t('Preview'),
        arguments: [this]
      };
    }
  }
}
