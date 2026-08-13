import * as vscode from 'vscode';
import { ZodError } from 'zod';
import type { JumpServerSettings } from '../config/schema';
import { formatError } from '../utils/errors';
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
      if (message?.type !== 'save') {
        return;
      }
      // Nothing awaits this listener, so anything thrown here disappears: the
      // panel would stay open on unsaved values with no hint that the save was
      // rejected, which is strictly worse than an error the user can act on.
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') {
        await vscode.window.showErrorMessage(
          'JumpServer configuration was not saved: the form sent no values.'
        );
        return;
      }
      try {
        await store.saveSettings(
          {
            baseUrl: payload.baseUrl,
            orgId: payload.orgId,
            username: payload.username,
            verifyTls: payload.verifyTls,
            updatedAt: Date.now()
          },
          payload.password || undefined
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`JumpServer configuration was not saved. ${formatSettingsError(error)}`);
        return;
      }
      await vscode.commands.executeCommand('jumpserverManager.refresh');
      await vscode.window.showInformationMessage('JumpServer configuration saved.');
      panel.dispose();
    });
  }
}

/**
 * A ZodError's own `message` is a JSON dump of every issue - accurate and
 * unreadable. The form has five fields, so naming the ones that failed is all
 * a user needs to fix it.
 */
export function formatSettingsError(error: unknown): string {
  if (!(error instanceof ZodError)) {
    return formatError(error);
  }
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'settings'}: ${issue.message}`)
    .join('; ');
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
