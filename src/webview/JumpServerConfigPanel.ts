import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ZodError } from 'zod';
import { bastionDisplayName, type JumpServerBastion } from '../config/schema';
import { formatError } from '../utils/errors';
import { renderWebviewHtml, type WebviewAsset } from './html';
import { t } from '../i18n/t';

export interface JumpServerConfigPanelStore {
  getBastion(id: string): Promise<JumpServerBastion | undefined>;
  saveBastion(bastion: JumpServerBastion, password?: string): Promise<void>;
}

export type JumpServerConfigPanelInput = { mode: 'add' } | { mode: 'edit'; bastionId: string };

type ConfigMessage = {
  type: 'save';
  payload: {
    displayName: string;
    bastionId: string;
    baseUrl: string;
    orgId: string;
    username: string;
    password: string;
    verifyTls: boolean;
  };
};

export class JumpServerConfigPanel {
  static async open(
    context: vscode.ExtensionContext,
    store: JumpServerConfigPanelStore,
    input: JumpServerConfigPanelInput,
    idFactory: () => string = randomUUID
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'jumpserverConfig',
      t('Configure JumpServer'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    const bastion = input.mode === 'edit' ? await store.getBastion(input.bastionId) : undefined;
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      createConfigAssets(context.extensionUri),
      renderJumpServerConfigBody(
        input.mode === 'edit' ? (bastion ?? { id: input.bastionId }) : undefined
      )
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
          t('JumpServer configuration was not saved: the form sent no values.')
        );
        return;
      }
      try {
        await store.saveBastion(
          {
            id: payload.bastionId || idFactory(),
            name: bastionDisplayName(payload.displayName, payload.baseUrl),
            baseUrl: payload.baseUrl,
            orgId: payload.orgId,
            username: payload.username,
            verifyTls: payload.verifyTls,
            updatedAt: Date.now()
          },
          payload.password || undefined
        );
      } catch (error) {
        await vscode.window.showErrorMessage(
          t('JumpServer configuration was not saved. {message}', { message: formatSettingsError(error) })
        );
        return;
      }
      await vscode.commands.executeCommand('jumpserverManager.refresh');
      await vscode.window.showInformationMessage(t('JumpServer configuration saved.'));
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

export function renderJumpServerConfigBody(bastion?: Partial<JumpServerBastion>): string {
  const hiddenBastionId = bastion?.id
    ? `<input type="hidden" name="bastionId" value="${escapeAttr(bastion.id)}" />`
    : '';
  return `<main class="config-shell">
  <form id="configForm" class="config-form">
    ${hiddenBastionId}
    <label>${escapeAttr(t('Display name'))}<input name="displayName" value="${escapeAttr(bastion?.name ?? '')}" /></label>
    <label>${escapeAttr(t('Base URL'))}<input name="baseUrl" required value="${escapeAttr(bastion?.baseUrl ?? '')}" /></label>
    <label>${escapeAttr(t('Org ID'))}<input name="orgId" value="${escapeAttr(bastion?.orgId ?? '')}" /></label>
    <label>${escapeAttr(t('Username'))}<input name="username" required value="${escapeAttr(bastion?.username ?? '')}" /></label>
    <label>${escapeAttr(t('Password'))}<input name="password" type="password" autocomplete="current-password" /></label>
    <label class="config-row"><input name="verifyTls" type="checkbox" ${bastion?.verifyTls === false ? '' : 'checked'} /> ${escapeAttr(t('Verify TLS'))}</label>
    <button type="submit">${escapeAttr(t('Save'))}</button>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
