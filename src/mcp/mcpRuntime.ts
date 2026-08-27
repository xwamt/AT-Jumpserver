/**
 * Lazy MCP runtime entry point.
 *
 * This module (and everything it pulls in, notably `@at-series/mcp-hub`) is
 * bundled into `dist/mcpRuntime.js` by esbuild and loaded by `extension.ts`
 * via `require(context.asAbsolutePath(...))` only once a bastion exists, so
 * windows without a configured bastion never pay for hub sync, the bridge
 * HTTP server, or the IDE MCP config write. `extension.ts` must not import
 * runtime values from here or from `@at-series/mcp-hub` statically.
 */
import { detectHostApp } from '@at-series/mcp-hub';
import type * as vscode from 'vscode';
import type { JumpServerAgentToolService } from '../agent/JumpServerAgentToolService';
import { BridgeServer } from './BridgeServer';
import { syncPackagedHub } from './hubSync';
import { ensureAtSeriesConfigForCurrentIde } from './McpConfigInstaller';

export { syncPackagedHub } from './hubSync';
export {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from './McpConfigInstaller';

export interface McpRuntimeHostEnv {
  appName: string;
  appRoot: string;
  uriScheme: string;
  extensionPath: string;
}

export interface StartMcpRuntimeOptions {
  context: vscode.ExtensionContext;
  service: JumpServerAgentToolService;
  hostEnv: McpRuntimeHostEnv;
  workspaceFolder: string | undefined;
}

export interface McpRuntimeHandle {
  /** Hub bundle election result; rejects when the sync failed. */
  hubReady: Promise<{ updated: boolean; activeVersion: string }>;
  /** Bridge listening and registry record published. */
  bridgeReady: Promise<void>;
  /** IDE MCP config write; `undefined` when the host has no supported target. */
  ideConfigReady: Promise<{ updated: boolean } | undefined>;
  dispose(): Promise<void>;
}

export function startMcpRuntime(options: StartMcpRuntimeOptions): McpRuntimeHandle {
  const hubReady = syncPackagedHub(options.context);
  const bridge = new BridgeServer({
    service: options.service,
    hostApp: detectHostApp(options.hostEnv),
    pluginVersion:
      typeof options.context.extension?.packageJSON?.version === 'string'
        ? options.context.extension.packageJSON.version
        : undefined
  });
  const bridgeReady = bridge.start();
  const ideConfigReady = hubReady.then(() =>
    ensureAtSeriesConfigForCurrentIde({
      ...options.hostEnv,
      workspaceFolder: options.workspaceFolder
    })
  );
  return {
    hubReady,
    bridgeReady,
    ideConfigReady,
    dispose: () => bridge.dispose()
  };
}
