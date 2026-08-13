import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AT_SERIES_TOKEN_HEADER,
  ensureAtSeriesMcpConfig,
  hubJsPath,
  listBridgeRecords,
  syncHubBundle,
  type BridgeErrorBody,
  type BridgeHealthResponse,
  type BridgeInvokeSuccess,
  type BridgeToolsResponse
} from '@at-series/mcp-hub';
import { JumpServerAgentToolService } from '../../src/agent/JumpServerAgentToolService';
import { BridgeServer } from '../../src/mcp/BridgeServer';
import { AT_JUMPSERVER_PLUGIN_ID, AT_JUMPSERVER_TOOL_CATALOG } from '../../src/mcp/toolCatalog';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

describe('P0c functional e2e smoke', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('runs Bridge -> registry -> health/tools/invoke -> confirm cancel -> installer -> hub sync -> dispose', async () => {
    const home = await mkdtemp(join(tmpdir(), 'p0c-func-'));
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
    });

    const write = vi.fn();
    const confirm = vi.fn(async () => false);
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'term-1',
      asset: {
        id: 'a1',
        name: 'web-1',
        address: '10.0.0.1',
        platform: 'Linux',
        category: 'host',
        type: 'linux',
        zoneName: 'default',
        nodePath: ['Default'],
        protocolNames: ['ssh'],
        raw: {}
      },
      connected: true,
      write
    });

    const service = new JumpServerAgentToolService({
      configManager: { listCachedAssets: async () => [] },
      terminalContext,
      sftp: {
        listDirectory: async () => [],
        stat: async () => ({ size: 0, modifiedAt: 0 }),
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => undefined,
        createFile: async () => undefined,
        mkdir: async () => undefined,
        rename: async () => undefined,
        deleteEntry: async () => undefined,
        getConnectionAsset: () => undefined
      },
      confirm
    });

    const bridge = new BridgeServer({
      service,
      hostApp: 'cursor',
      pluginVersion: '0.1.5',
      home
    });
    await bridge.start();
    cleanups.push(async () => {
      await bridge.dispose();
    });

    const records = await listBridgeRecords({ home, hostApp: 'cursor' });
    expect(records).toHaveLength(1);
    expect(records[0]?.pluginId).toBe(AT_JUMPSERVER_PLUGIN_ID);
    expect(records[0]?.tools.some((t) => t.name === 'jumpserver_send_terminal_input' && t.risk === 'exec')).toBe(
      true
    );

    const port = records[0]!.port;
    const token = records[0]!.token;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetchJson<BridgeHealthResponse>(`${base}/health`, {
      headers: { [AT_SERIES_TOKEN_HEADER]: token }
    });
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({
      ok: true,
      pluginId: AT_JUMPSERVER_PLUGIN_ID,
      protocolVersion: 1
    });

    const tools = await fetchJson<BridgeToolsResponse>(`${base}/tools`, {
      headers: { [AT_SERIES_TOKEN_HEADER]: token }
    });
    expect(tools.status).toBe(200);
    if (isBridgeError(tools.json)) {
      throw new Error(`GET /tools returned an error body: ${tools.json.error.code}`);
    }
    expect(tools.json.tools).toHaveLength(15);
    expect(tools.json.tools.map((t) => t.name).sort()).toEqual(
      AT_JUMPSERVER_TOOL_CATALOG.map((t) => t.name).sort()
    );

    const list = await fetchJson<BridgeInvokeSuccess>(`${base}/invoke`, {
      method: 'POST',
      headers: { [AT_SERIES_TOKEN_HEADER]: token },
      body: { name: 'jumpserver_list_assets', arguments: {} }
    });
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ ok: true, name: 'jumpserver_list_assets' });

    const cancelled = await fetchJson<BridgeInvokeSuccess>(`${base}/invoke`, {
      method: 'POST',
      headers: { [AT_SERIES_TOKEN_HEADER]: token },
      body: { name: 'jumpserver_send_terminal_input', arguments: { input: 'whoami\n' } }
    });
    expect(cancelled.status).toBe(499);
    if (!isBridgeError(cancelled.json)) {
      throw new Error('POST /invoke on a cancelled confirm must return an error body');
    }
    expect(cancelled.json.error.code).toBe('USER_CANCELLED');
    expect(confirm).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    const unauthorized = await fetchJson(`${base}/invoke`, {
      method: 'POST',
      headers: { [AT_SERIES_TOKEN_HEADER]: 'wrong' },
      body: { name: 'jumpserver_list_assets', arguments: {} }
    });
    expect(unauthorized.status).toBe(401);

    const hubDir = join(home, '.at-series', 'mcp');
    await mkdir(hubDir, { recursive: true });
    const bundlePath = join(hubDir, 'packaged-hub.js');
    await writeFile(bundlePath, 'console.log("hub-smoke");\n', 'utf8');
    const sync = await syncHubBundle({
      version: '0.1.1',
      bundlePath,
      pluginId: AT_JUMPSERVER_PLUGIN_ID,
      pluginVersion: '0.1.5',
      home
    });
    expect(sync.activeVersion).toBe('0.1.1');
    await access(hubJsPath(home));

    await ensureAtSeriesMcpConfig({
      target: 'cursor',
      hostApp: 'cursor',
      hubJsAbsolutePath: hubJsPath(home),
      home
    });

    // Seed legacy entry then re-ensure to prove migration path still works after AT Series exists
    const mcpPath = join(home, '.cursor', 'mcp.json');
    const before = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    before.mcpServers['AT JumpServer Terminal'] = {
      command: 'node',
      args: ['C:/old/mcp-server.js']
    };
    before.mcpServers['Other Tool'] = { command: 'echo', args: ['hi'] };
    await writeFile(mcpPath, JSON.stringify(before, null, 2), 'utf8');

    await ensureAtSeriesMcpConfig({
      target: 'cursor',
      hostApp: 'cursor',
      hubJsAbsolutePath: hubJsPath(home),
      home
    });

    const after = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string>; autoApprove?: string[] }>;
    };
    expect(after.mcpServers['AT Series']).toBeTruthy();
    expect(after.mcpServers['AT JumpServer Terminal']).toBeUndefined();
    expect(after.mcpServers['Other Tool']).toBeTruthy();
    expect(normalizePath(after.mcpServers['AT Series'].args?.[0] ?? '')).toBe(normalizePath(hubJsPath(home)));
    expect(after.mcpServers['AT Series'].env?.AT_SERIES_HOST_APP).toBe('cursor');
    expect(after.mcpServers['AT Series'].env?.AT_SERIES_TOOL_SELECTION_IDLE_MS).toBe('0');
    const auto = after.mcpServers['AT Series'].autoApprove ?? [];
    expect(auto).toEqual([
      'at_list_providers',
      'at_search_tools',
      'at_get_tool',
      'at_select_tools',
      'at_clear_tool_selection'
    ]);
    expect(auto).not.toContain('jumpserver_list_assets');
    expect(auto).not.toContain('jumpserver_send_terminal_input');

    await bridge.dispose();
    const afterDispose = await listBridgeRecords({ home, hostApp: 'cursor' });
    expect(afterDispose).toHaveLength(0);
    // hub.js must remain after unpublish
    await access(hubJsPath(home));
  }, 30_000);
});

/** Every Bridge endpoint may answer with an error body instead of its success shape. */
async function fetchJson<T = unknown>(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; json: T | BridgeErrorBody }> {
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: res.status, json: (await res.json()) as T | BridgeErrorBody };
}

function isBridgeError(body: unknown): body is BridgeErrorBody {
  return typeof body === 'object' && body !== null && 'error' in body;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}
