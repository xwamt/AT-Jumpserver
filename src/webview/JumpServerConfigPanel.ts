import * as vscode from 'vscode';
import type { JumpServerSettings } from '../config/schema';
import { renderWebviewHtml, type WebviewAsset } from './html';

export interface JumpServerConfigPanelStore {
  getSettings(): Promise<JumpServerSettings | undefined>;
  saveSettings(settings: JumpServerSettings, password?: string): Promise<void>;
}

type ConfigMessage = {
  type: 'save';
  payload: {
    baseUrl: string;
    orgId: string;
    username: string;
    password: string;
    verifyTls: boolean;
  };
};

export class JumpServerConfigPanel {
  static async open(context: vscode.ExtensionContext, store: JumpServerConfigPanelStore): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'jumpserverConfig',
      'Configure JumpServer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    const settings = await store.getSettings();
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      createConfigAssets(context.extensionUri),
      renderJumpServerConfigBody(settings)
    );
    panel.webview.onDidReceiveMessage(async (message: ConfigMessage) => {
      if (message.type !== 'save') {
        return;
      }
      const now = Date.now();
      await store.saveSettings(
        {
          baseUrl: message.payload.baseUrl,
          orgId: message.payload.orgId,
          username: message.payload.username,
          verifyTls: message.payload.verifyTls,
          updatedAt: now
        },
        message.payload.password || undefined
      );
      await vscode.window.showInformationMessage('JumpServer configuration saved.');
      panel.dispose();
    });
  }
}

export function createConfigAssets(extensionUri: vscode.Uri): WebviewAsset {
  return {
    script: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'jumpserver-config.js'),
    style: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'jumpserver-config.css')
  };
}

export function renderJumpServerConfigBody(settings?: JumpServerSettings): string {
  return `<main class="config-shell">
  <form id="configForm" class="config-form">
    <label>Base URL<input name="baseUrl" required value="${escapeAttr(settings?.baseUrl ?? '')}" /></label>
    <label>Org ID<input name="orgId" value="${escapeAttr(settings?.orgId ?? '')}" /></label>
    <label>Username<input name="username" required value="${escapeAttr(settings?.username ?? '')}" /></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" /></label>
    <label class="config-row"><input name="verifyTls" type="checkbox" ${settings?.verifyTls === false ? '' : 'checked'} /> Verify TLS</label>
    <button type="submit">Save</button>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
