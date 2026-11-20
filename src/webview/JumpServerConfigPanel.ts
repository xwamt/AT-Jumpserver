import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ZodError } from 'zod';
import { bastionDisplayName, parseJumpServerBastion, type JumpServerBastion } from '../config/schema';
import { JumpServerClient } from '../jumpserver/JumpServerClient';
import { clearKokoCapabilityCache } from '../jumpserver/kokoCapability';
import type { JumpServerSettingsWithPassword } from '../jumpserver/types';
import { formatError } from '../utils/errors';
import { renderWebviewHtml, type WebviewAsset } from './html';
import { t } from '../i18n/t';

export interface JumpServerConfigPanelStore {
  getBastion(id: string): Promise<JumpServerBastion | undefined>;
  saveBastion(bastion: JumpServerBastion, password?: string): Promise<void>;
  getPassword?(id: string): Promise<string | undefined>;
}

export interface ConfigTestClient {
  healthCheck(): Promise<unknown>;
  ensureAuthToken(): Promise<unknown>;
  getUserProfile(): Promise<Record<string, unknown>>;
  listAccessibleOrgs(): Promise<Array<{ id: string; name: string }>>;
  dispose?(): void;
}

export type JumpServerConfigPanelInput = { mode: 'add' } | { mode: 'edit'; bastionId: string };

type ConfigFormPayload = {
  displayName: string;
  bastionId: string;
  baseUrl: string;
  orgId: string;
  username: string;
  password: string;
  verifyTls: boolean;
};

type ConfigMessage = {
  type: 'save' | 'test';
  payload: ConfigFormPayload;
};

export class JumpServerConfigPanel {
  static async open(
    context: vscode.ExtensionContext,
    store: JumpServerConfigPanelStore,
    input: JumpServerConfigPanelInput,
    idFactory: () => string = randomUUID,
    clientFactory: (settings: JumpServerSettingsWithPassword) => ConfigTestClient = (settings) =>
      new JumpServerClient(settings)
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
    const postToWebview = (message: unknown): void => {
      try {
        void Promise.resolve(panel.webview.postMessage?.(message)).catch(() => undefined);
      } catch {
        // Test doubles or disposed panels may reject postMessage.
      }
    };
    panel.webview.onDidReceiveMessage(async (message: ConfigMessage) => {
      if (message?.type === 'test') {
        await handleTestConnection(message.payload, store, idFactory, clientFactory, postToWebview);
        return;
      }
      if (message?.type !== 'save') {
        return;
      }
      // Nothing awaits this listener, so anything thrown here disappears: the
      // panel would stay open on unsaved values with no hint that the save was
      // rejected, which is strictly worse than an error the user can act on.
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') {
        const errorText = t('JumpServer configuration was not saved: the form sent no values.');
        postToWebview({ type: 'saveError', message: errorText });
        await vscode.window.showErrorMessage(errorText);
        return;
      }
      const savedId = payload.bastionId || idFactory();
      try {
        await store.saveBastion(
          {
            id: savedId,
            name: bastionDisplayName(payload.displayName, payload.baseUrl),
            baseUrl: payload.baseUrl,
            orgId: payload.orgId,
            username: payload.username,
            verifyTls: payload.verifyTls,
            updatedAt: Date.now()
          },
          payload.password || undefined
        );
        clearKokoCapabilityCache(savedId);
      } catch (error) {
        const errorText = t('JumpServer configuration was not saved. {message}', {
          message: formatSettingsError(error)
        });
        postToWebview({ type: 'saveError', message: errorText });
        await vscode.window.showErrorMessage(errorText);
        return;
      }
      // The save itself is done: close the form right away. Refreshing the
      // bastion pulls every asset page and can take many seconds, so it runs
      // fire-and-forget (the command reports its own failures via runCommand),
      // and the success toast must not gate the dispose either — awaiting
      // showInformationMessage blocks until the notification is dismissed.
      panel.dispose();
      void Promise.resolve(
        vscode.commands.executeCommand('jumpserverManager.refreshBastion', savedId)
      ).catch(() => undefined);
      void vscode.window.showInformationMessage(t('JumpServer configuration saved.'));
    });
  }
}

async function handleTestConnection(
  payload: ConfigFormPayload | undefined,
  store: JumpServerConfigPanelStore,
  idFactory: () => string,
  clientFactory: (settings: JumpServerSettingsWithPassword) => ConfigTestClient,
  postToWebview: (message: unknown) => void
): Promise<void> {
  if (!payload || typeof payload !== 'object') {
    postToWebview({
      type: 'testResult',
      ok: false,
      message: t('JumpServer configuration was not saved: the form sent no values.')
    });
    return;
  }

  let bastion: JumpServerBastion;
  try {
    bastion = parseJumpServerBastion({
      id: payload.bastionId || idFactory(),
      name: bastionDisplayName(payload.displayName, payload.baseUrl),
      baseUrl: payload.baseUrl,
      orgId: payload.orgId,
      username: payload.username,
      verifyTls: payload.verifyTls,
      updatedAt: Date.now()
    });
  } catch (error) {
    postToWebview({
      type: 'testResult',
      ok: false,
      message: t('Connection test failed: {message}', { message: formatSettingsError(error) })
    });
    return;
  }

  const password = payload.password || (payload.bastionId ? await store.getPassword?.(payload.bastionId) : undefined);
  if (!password) {
    postToWebview({
      type: 'testResult',
      ok: false,
      message: t('Password is required to test the connection.')
    });
    return;
  }

  const client = clientFactory({
    baseUrl: bastion.baseUrl,
    orgId: bastion.orgId,
    username: bastion.username,
    password,
    verifyTls: bastion.verifyTls
  });
  try {
    await client.healthCheck();
    await client.ensureAuthToken();
    const profile = await client.getUserProfile();
    const orgs = bastion.orgId.trim() ? [] : await client.listAccessibleOrgs().catch(() => []);
    const userLabel = typeof profile?.username === 'string' && profile.username ? profile.username : bastion.username;
    const successMessage = orgs.length > 0
      ? t('Connection succeeded as {user}. Accessible organizations: {orgs}.', {
          user: userLabel,
          orgs: orgs.map((org) => org.name || org.id).join(', ')
        })
      : t('Connection succeeded as {user}.', { user: userLabel });
    postToWebview({ type: 'testResult', ok: true, message: successMessage });
  } catch (error) {
    postToWebview({
      type: 'testResult',
      ok: false,
      message: t('Connection test failed: {message}', { message: formatSettingsError(error) })
    });
  } finally {
    client.dispose?.();
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
  const isEdit = Boolean(bastion?.id);
  const hiddenBastionId = bastion?.id
    ? `<input type="hidden" name="bastionId" value="${escapeAttr(bastion.id)}" />`
    : '';
  const passwordAttrs = isEdit
    ? `placeholder="${escapeAttr(t('Leave blank to keep current password'))}"`
    : 'required';
  return `<main class="config-shell">
  <form id="configForm" class="config-form">
    ${hiddenBastionId}
    <label>${escapeAttr(t('Display name'))}<input name="displayName" value="${escapeAttr(bastion?.name ?? '')}" /></label>
    <label>${escapeAttr(t('Base URL'))}<input name="baseUrl" required placeholder="https://jumpserver.example.com" value="${escapeAttr(bastion?.baseUrl ?? '')}" /><span class="field-hint">${escapeAttr(t('Example: https://jumpserver.example.com'))}</span></label>
    <label>${escapeAttr(t('Org ID'))}<input name="orgId" placeholder="${escapeAttr(t('Optional — leave blank to detect automatically'))}" value="${escapeAttr(bastion?.orgId ?? '')}" /><span class="field-hint">${escapeAttr(t('Leave blank to auto-detect or select an organization on refresh.'))}</span></label>
    <label>${escapeAttr(t('Username'))}<input name="username" required value="${escapeAttr(bastion?.username ?? '')}" /></label>
    <label>${escapeAttr(t('Password'))}<input name="password" type="password" autocomplete="current-password" ${passwordAttrs} /></label>
    <label class="config-row"><input name="verifyTls" type="checkbox" ${bastion?.verifyTls === false ? '' : 'checked'} /> ${escapeAttr(t('Verify TLS'))}</label>
    <div class="config-actions">
      <button type="submit" id="saveBtn">${escapeAttr(t('Save'))}</button>
      <button type="button" id="testBtn" class="button-secondary" data-testing-label="${escapeAttr(t('Testing...'))}">${escapeAttr(t('Test Connection'))}</button>
    </div>
    <div id="statusBanner" class="status-banner" role="status" aria-live="polite" hidden></div>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
