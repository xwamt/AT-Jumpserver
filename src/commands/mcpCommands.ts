import * as vscode from 'vscode';
import { t } from '../i18n/t';
import { showTimedNotification } from '../utils/notifications';
import { errorMessage } from '../utils/redaction';

export type McpRuntimeModule = typeof import('../mcp/mcpRuntime');

export interface McpCommandsDeps {
  context: vscode.ExtensionContext;
  loadMcpRuntimeModule: () => Promise<McpRuntimeModule>;
  hostEnv: {
    appName: string;
    appRoot: string;
    uriScheme: string;
    extensionPath: string;
  };
  currentWorkspaceFolder: () => string | undefined;
  runCommand: (command: () => Promise<void>) => Promise<void>;
}

/**
 * Registers IDE MCP hub repair and configuration uninstall commands.
 */
export function registerMcpCommands(deps: McpCommandsDeps): vscode.Disposable[] {
  const { context, loadMcpRuntimeModule, hostEnv, currentWorkspaceFolder, runCommand } = deps;

  return [
    vscode.commands.registerCommand('jumpserverManager.installMcpConfig', async () => {
      await runCommand(async () => {
        const runtime = await loadMcpRuntimeModule();
        try {
          // Repair must not trust the metadata short-circuit: force the full
          // read+hash election so a tampered ~/.at-series install is rebuilt.
          await runtime.syncPackagedHub(context, { force: true });
        } catch (error) {
          showTimedNotification(t('AT Series hub sync failed: {message}', { message: errorMessage(error) }), 'error');
          return;
        }
        const result = await runtime.ensureAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        });
        if (result) {
          showTimedNotification(
            result.updated
              ? t('AT Series MCP config installed/repaired.')
              : t('AT Series MCP config is already up to date.')
          );
          return;
        }
        showTimedNotification(
          t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.'),
          'warning'
        );
      });
    }),
    vscode.commands.registerCommand('jumpserverManager.uninstallAtSeriesMcpConfig', async () => {
      await runCommand(async () => {
        const runtime = await loadMcpRuntimeModule();
        const result = await runtime.uninstallAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        });
        if (result?.removed) {
          showTimedNotification(t('AT Series MCP config uninstalled.'));
          return;
        }
        if (result) {
          showTimedNotification(t('AT Series MCP config was not present.'));
          return;
        }
        showTimedNotification(
          t('No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.'),
          'warning'
        );
      });
    })
  ];
}
