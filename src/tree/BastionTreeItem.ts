import * as vscode from 'vscode';
import type { JumpServerBastion } from '../config/schema';
import { t } from '../i18n/t';

export class BastionTreeItem extends vscode.TreeItem {
  readonly contextValue = 'jumpserverBastion';

  constructor(readonly bastion: JumpServerBastion) {
    super(bastion.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `bastion:${bastion.id}`;
    this.description = hostnameFromBaseUrl(bastion.baseUrl);
  }
}

export class EmptyBastionTreeItem extends vscode.TreeItem {
  readonly contextValue = 'jumpserverEmpty';

  constructor() {
    super(t('Add JumpServer to get started'), vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: 'jumpserverManager.addBastion',
      title: t('Add JumpServer to get started')
    };
  }
}

function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}
