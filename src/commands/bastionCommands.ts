import * as vscode from 'vscode';
import type { JumpServerConfigManager } from '../config/JumpServerConfigManager';
import type { JumpServerBastion } from '../config/schema';
import { t } from '../i18n/t';
import { assetPathsFromNodes, type JumpServerClient } from '../jumpserver/JumpServerClient';
import { clearKokoCapabilityCache } from '../jumpserver/kokoCapability';
import { resolveOrgContext } from '../jumpserver/orgContext';
import type { JumpServerSftpManager } from '../sftp/JumpServerSftpManager';
import type { JumpServerTreeProvider } from '../tree/JumpServerTreeProvider';
import { showTimedNotification } from '../utils/notifications';
import { JumpServerConfigPanel } from '../webview/JumpServerConfigPanel';
import { TerminalPanel } from '../webview/TerminalPanel';

export type BastionCommandArg = string | { bastion?: { id?: string } };

type BastionRefreshResult =
  | { cancelled: true }
  | { cancelled: false; truncated: boolean; count: number; total: number };

export interface BastionCommandsDeps {
  context: vscode.ExtensionContext;
  configManager: JumpServerConfigManager;
  treeProvider: JumpServerTreeProvider;
  sftpManager: JumpServerSftpManager;
  createClient: (bastionId: string) => Promise<JumpServerClient>;
  dropClient: (bastionId: string) => void;
  ensureMcpRuntime: () => Promise<void>;
  runCommand: (command: () => Promise<void>) => Promise<void>;
}

/**
 * Registers bastion management, refresh, and credential validation commands.
 */
export function registerBastionCommands(deps: BastionCommandsDeps): vscode.Disposable[] {
  const {
    context,
    configManager,
    treeProvider,
    sftpManager,
    createClient,
    dropClient,
    ensureMcpRuntime,
    runCommand
  } = deps;

  return [
    vscode.commands.registerCommand('jumpserverManager.configure', async () => {
      await runCommand(async () => {
        const bastions = await configManager.listBastions();
        if (bastions.length === 0) {
          await JumpServerConfigPanel.open(context, configManager, { mode: 'add' });
          return;
        }
        const picked = await vscode.window.showQuickPick(
          [
            ...bastions.map((bastion) => ({
              label: bastion.name,
              description: bastion.baseUrl,
              bastionId: bastion.id
            })),
            { label: t('Add JumpServer'), description: '', bastionId: '' }
          ],
          { title: t('Select a JumpServer bastion'), ignoreFocusOut: true }
        );
        if (!picked) {
          return;
        }
        await JumpServerConfigPanel.open(
          context,
          configManager,
          picked.bastionId === '' ? { mode: 'add' } : { mode: 'edit', bastionId: picked.bastionId }
        );
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.addBastion', () => {
      void JumpServerConfigPanel.open(context, configManager, { mode: 'add' });
    }),
    vscode.commands.registerCommand('jumpserverManager.editBastion', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        await JumpServerConfigPanel.open(context, configManager, { mode: 'edit', bastionId: bastion.id });
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.removeBastion', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        const deleteAction = t('Delete');
        const answer = await vscode.window.showWarningMessage(
          t('Delete JumpServer bastion {name}?', { name: bastion.name }),
          { modal: true },
          deleteAction
        );
        if (answer !== deleteAction) {
          return;
        }
        await configManager.deleteBastion(bastion.id);
        dropClient(bastion.id);
        clearKokoCapabilityCache(bastion.id);
        for (const terminalId of TerminalPanel.disposeSessionsForBastion(bastion.id)) {
          sftpManager.removeTerminal(terminalId);
        }
        treeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.refreshBastion', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        const result = await refreshBastion(configManager, treeProvider, bastion.id, createClient);
        notifyRefreshSummary([bastion], [{ status: 'fulfilled', value: result }]);
        if (!result.cancelled) {
          // A working bastion now exists; late-start MCP for windows that
          // activated with none configured. No-op when already running.
          void ensureMcpRuntime();
        }
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.validate', async (item?: BastionCommandArg) => {
      await runCommand(async () => {
        const bastion = await pickBastion(configManager, item);
        if (!bastion) {
          return;
        }
        const client = await createClient(bastion.id);
        await client.healthCheck();
        await client.ensureAuthToken();
        // Verifying an account should not drag the whole node tree along.
        await client.getUserProfile();
        const org = await ensureOrgContext(configManager, client, bastion);
        if (!org) {
          return;
        }
        client.setOrgId(org.id);
        showTimedNotification(t('JumpServer account verified. Organization: {org}.', { org: org.name }));
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.refresh', async () => {
      await runCommand(async () => {
        const bastions = await configManager.listBastions();
        if (bastions.length === 0) {
          throw new Error('JumpServer is not configured.');
        }
        const results = await Promise.allSettled(
          bastions.map((bastion) => refreshBastion(configManager, treeProvider, bastion.id, createClient))
        );
        notifyRefreshSummary(bastions, results);
        if (results.some((result) => result.status === 'fulfilled' && !result.value.cancelled)) {
          void ensureMcpRuntime();
        }
      });
    })
  ];
}

async function pickBastion(
  configManager: JumpServerConfigManager,
  item?: BastionCommandArg
): Promise<JumpServerBastion | undefined> {
  const requestedId = bastionIdFromArg(item);
  if (requestedId) {
    return configManager.requireBastion(requestedId);
  }
  const bastions = await configManager.listBastions();
  if (bastions.length === 0) {
    throw new Error('JumpServer is not configured.');
  }
  if (bastions.length === 1) {
    return bastions[0];
  }
  const picked = await vscode.window.showQuickPick(
    bastions.map((bastion) => ({
      label: bastion.name,
      description: bastion.baseUrl,
      bastionId: bastion.id
    })),
    { title: t('Select a JumpServer bastion'), ignoreFocusOut: true }
  );
  if (!picked) {
    return undefined;
  }
  return configManager.requireBastion(picked.bastionId);
}

function bastionIdFromArg(item?: BastionCommandArg): string | undefined {
  if (typeof item === 'string' && item) {
    return item;
  }
  if (item && typeof item === 'object' && typeof item.bastion?.id === 'string' && item.bastion.id) {
    return item.bastion.id;
  }
  return undefined;
}

async function refreshBastion(
  configManager: JumpServerConfigManager,
  treeProvider: JumpServerTreeProvider,
  bastionId: string,
  createClient: (bastionId: string) => Promise<JumpServerClient>
): Promise<BastionRefreshResult> {
  const bastion = await configManager.requireBastion(bastionId);
  const client = await createClient(bastionId);
  const org = await ensureOrgContext(configManager, client, bastion);
  if (!org) {
    return { cancelled: true };
  }
  client.setOrgId(org.id);
  const nodes = await client.listAssetNodes();
  await configManager.saveCachedAssetNodes(bastionId, nodes);
  treeProvider.refresh();
  const inventory = await client.listAllAssets({ treePaths: assetPathsFromNodes(nodes) });
  await configManager.saveCachedAssets(bastionId, inventory.assets);
  treeProvider.refresh();
  return {
    cancelled: false,
    truncated: inventory.truncated,
    count: inventory.assets.length,
    total: inventory.total
  };
}

function notifyRefreshSummary(
  bastions: JumpServerBastion[],
  results: PromiseSettledResult<BastionRefreshResult>[]
): void {
  const failed = results
    .map((result, index) => ({ result, bastion: bastions[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; bastion: JumpServerBastion } =>
      entry.result.status === 'rejected'
    );
  const succeeded = results.filter(
    (result): result is PromiseFulfilledResult<Exclude<BastionRefreshResult, { cancelled: true }>> =>
      result.status === 'fulfilled' && !result.value.cancelled
  );
  if (succeeded.length === 0 && failed.length === 0) {
    return;
  }
  const truncated = succeeded.filter((result) => result.value.truncated);
  const warning = failed.length > 0 || truncated.length > 0;
  if (failed.length > 0) {
    showTimedNotification(
      t('JumpServer assets refreshed: {ok} succeeded, {fail} failed ({names}).', {
        ok: succeeded.length,
        fail: failed.length,
        names: failed.map((entry) => entry.bastion.name).join(', ')
      }),
      'warning'
    );
    return;
  }
  let message = t('JumpServer assets refreshed: {ok} succeeded.', { ok: succeeded.length });
  if (truncated.length > 0) {
    message = `${message} ${truncated.map((result) =>
      t('JumpServer assets refreshed: {count} of {total} (cache cap reached).', {
        count: result.value.count,
        total: result.value.total
      })
    ).join(' ')}`;
  }
  if (warning) {
    showTimedNotification(message, 'warning');
    return;
  }
  showTimedNotification(message);
}

async function ensureOrgContext(
  configManager: JumpServerConfigManager,
  client: JumpServerClient,
  bastion: JumpServerBastion
): Promise<{ id: string; name: string } | undefined> {
  // A saved org id is trusted as-is: listing orgs on every refresh/validate
  // costs a REST round-trip, and a stale org still surfaces through the
  // existing error toasts when the follow-up asset calls fail.
  const savedOrgId = bastion.orgId.trim();
  if (savedOrgId) {
    return { id: savedOrgId, name: bastion.name || savedOrgId };
  }
  const accessible = await client.listAccessibleOrgs();
  const context = resolveOrgContext({ savedOrgId: bastion.orgId, accessibleOrgs: accessible });
  if (context.effectiveOrg && context.effectiveOrg.source === 'reserved_auto_select') {
    await configManager.saveBastion({ ...bastion, orgId: context.effectiveOrg.id, updatedAt: Date.now() });
    return context.effectiveOrg;
  }
  if (context.effectiveOrg && !context.selectionRequired) {
    return context.effectiveOrg;
  }
  const picked = await vscode.window.showQuickPick(
    context.candidateOrgs.map((org) => ({
      label: org.name || org.id,
      description: org.id,
      orgId: org.id,
      name: org.name || org.id
    })),
    { title: t('Select the JumpServer organization to query.'), ignoreFocusOut: true }
  );
  if (!picked) {
    showTimedNotification(t('Organization selection was cancelled.'), 'error');
    return undefined;
  }
  await configManager.saveBastion({ ...bastion, orgId: picked.orgId, updatedAt: Date.now() });
  return { id: picked.orgId, name: picked.name };
}
