import { describe, expect, it, vi } from 'vitest';
import { AT_SERIES_TOKEN_HEADER } from '@at-series/mcp-hub';
import { createBridgeRequestHandler, readLimitedBody } from '../../src/mcp/BridgeServer';
import { BRIDGE_MAX_BODY_BYTES, BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';
import { AT_JUMPSERVER_PLUGIN_ID, AT_JUMPSERVER_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

async function call(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  options: {
    path: string;
    method?: string;
    token?: string;
    tokenHeader?: string;
    body?: unknown;
  }
) {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers[options.tokenHeader ?? AT_SERIES_TOKEN_HEADER] = options.token;
  }
  return handler({
    method: options.method ?? 'GET',
    path: options.path,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function createHandler(
  overrides: {
    token?: string;
    service?: Record<string, unknown>;
    hostApp?: string;
    bridgeId?: string;
    pluginVersion?: string;
  } = {}
) {
  return createBridgeRequestHandler({
    token: overrides.token ?? 'secret',
    bridgeId: overrides.bridgeId ?? 'bridge-1',
    hostApp: (overrides.hostApp ?? 'cursor') as 'cursor',
    pluginVersion: overrides.pluginVersion ?? '0.3.0',
    service: {
      listAssets: async () => ({ assets: [] }),
      getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] }),
      sendTerminalInput: vi.fn(),
      runTerminalCommand: vi.fn(),
      sftpListDirectory: vi.fn(),
      sftpStatPath: vi.fn(),
      sftpReadFile: vi.fn(),
      sftpWriteFile: vi.fn(),
      sftpCreateFile: vi.fn(),
      sftpCreateDirectory: vi.fn(),
      sftpRename: vi.fn(),
      sftpDelete: vi.fn(),
      mysqlGetContext: vi.fn(),
      mysqlSendInput: vi.fn(),
      mysqlExecuteSql: vi.fn(),
      ...overrides.service
    } as never
  });
}

describe('createBridgeRequestHandler', () => {
  it('rejects requests without a valid series token', async () => {
    const handler = createHandler();

    await expect(call(handler, { path: '/health' })).resolves.toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } }
    });
    await expect(
      call(handler, { path: '/health', token: 'wrong', tokenHeader: AT_SERIES_TOKEN_HEADER })
    ).resolves.toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } }
    });
  });

  it('accepts legacy x-at-jumpserver-terminal-token during migration', async () => {
    const handler = createHandler();

    await expect(
      call(handler, {
        path: '/health',
        token: 'secret',
        tokenHeader: BRIDGE_TOKEN_HEADER
      })
    ).resolves.toMatchObject({
      status: 200,
      body: { ok: true, protocolVersion: 1 }
    });
  });

  it('returns rich health shape with protocolVersion and pluginId', async () => {
    const handler = createHandler({
      service: {
        getTerminalContext: async () => ({
          connectedTerminals: [{ terminalId: 't1' }, { terminalId: 't2' }],
          knownTerminals: []
        })
      }
    });

    await expect(
      call(handler, { path: '/health', token: 'secret', tokenHeader: AT_SERIES_TOKEN_HEADER })
    ).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        protocolVersion: 1,
        bridgeId: 'bridge-1',
        pluginId: AT_JUMPSERVER_PLUGIN_ID,
        pluginDisplayName: 'AT JumpServer Terminal',
        pluginVersion: '0.3.0',
        hostApp: 'cursor',
        pid: process.pid,
        updatedAt: expect.any(Number),
        connectedTargets: 2,
        toolCount: AT_JUMPSERVER_TOOL_CATALOG.length
      }
    });
  });

  it('lists tools with risk fields', async () => {
    const handler = createHandler();

    const response = await call(handler, {
      path: '/tools',
      token: 'secret',
      tokenHeader: AT_SERIES_TOKEN_HEADER
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ protocolVersion: 1 });
    const tools = (response.body as { tools: Array<{ name: string; risk: string }> }).tools;
    expect(tools).toEqual(AT_JUMPSERVER_TOOL_CATALOG);
    expect(tools.every((tool) => typeof tool.risk === 'string')).toBe(true);
    expect(tools.find((tool) => tool.name === 'jumpserver_list_assets')?.risk).toBe('read');
    expect(tools.find((tool) => tool.name === 'jumpserver_run_terminal_command')?.risk).toBe('exec');
  });

  it('invokes jumpserver_list_assets through POST /invoke', async () => {
    const service = {
      listAssets: vi.fn(async () => ({
        assets: [{ id: 'asset-1', name: 'Production', host: '10.0.0.1' }]
      })),
      getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] })
    };
    const handler = createHandler({ service });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        tokenHeader: AT_SERIES_TOKEN_HEADER,
        body: { name: 'jumpserver_list_assets', arguments: {} }
      })
    ).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        name: 'jumpserver_list_assets',
        result: {
          assets: [{ id: 'asset-1', name: 'Production', host: '10.0.0.1' }]
        }
      }
    });
    expect(service.listAssets).toHaveBeenCalledOnce();
  });

  it('returns 422 VALIDATION_ERROR when invoke args fail schema validation', async () => {
    const handler = createHandler({
      service: {
        sftpStatPath: vi.fn()
      }
    });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'jumpserver_sftp_stat_path', arguments: { path: 123 } }
      })
    ).resolves.toMatchObject({
      status: 422,
      body: { error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/path|invalid|expected/i) } }
    });
  });

  it('returns USER_CANCELLED when user cancels confirmation', async () => {
    const handler = createHandler({
      service: {
        runTerminalCommand: async () => {
          throw new Error('Terminal command was cancelled.');
        }
      }
    });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: {
          name: 'jumpserver_run_terminal_command',
          arguments: { command: 'pwd' }
        }
      })
    ).resolves.toMatchObject({
      status: 499,
      body: { error: { code: 'USER_CANCELLED', message: 'Terminal command was cancelled.' } }
    });
  });

  it('returns 404 NOT_FOUND for unknown tools', async () => {
    const handler = createHandler();
    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'does_not_exist', arguments: {} }
      })
    ).resolves.toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } }
    });
  });
});

describe('readLimitedBody', () => {
  it('rejects bodies larger than BRIDGE_MAX_BODY_BYTES', async () => {
    const big = 'x'.repeat(BRIDGE_MAX_BODY_BYTES + 1);
    const result = await readLimitedBody([Buffer.from(big)], BRIDGE_MAX_BODY_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
    }
  });

  it('accepts bodies within the limit', async () => {
    const result = await readLimitedBody([Buffer.from('{"ok":true}')], BRIDGE_MAX_BODY_BYTES);
    expect(result).toEqual({ ok: true, body: '{"ok":true}' });
  });
});
