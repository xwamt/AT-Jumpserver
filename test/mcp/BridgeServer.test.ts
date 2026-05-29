import { describe, expect, it, vi } from 'vitest';
import { createBridgeRequestHandler } from '../../src/mcp/BridgeServer';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

describe('JumpServer BridgeServer', () => {
  it('rejects requests without the bridge token', async () => {
    const handler = createBridgeRequestHandler({ service: service(), token: 'secret' });
    await expect(handler({ method: 'POST', path: '/tools/jumpserver_list_assets', headers: {}, body: '{}' }))
      .resolves.toEqual({ status: 401, body: { error: 'Unauthorized JumpServer MCP bridge request.' } });
  });

  it('routes list assets requests', async () => {
    const svc = service({ listAssets: vi.fn(async () => ({ assets: [] })) });
    const handler = createBridgeRequestHandler({ service: svc, token: 'secret' });
    await expect(handler({
      method: 'POST',
      path: '/tools/jumpserver_list_assets',
      headers: { [BRIDGE_TOKEN_HEADER]: 'secret' },
      body: '{}'
    })).resolves.toEqual({ status: 200, body: { assets: [] } });
  });

  it('returns 404 for unknown endpoints', async () => {
    const handler = createBridgeRequestHandler({ service: service(), token: 'secret' });
    await expect(handler({
      method: 'POST',
      path: '/tools/unknown',
      headers: { [BRIDGE_TOKEN_HEADER]: 'secret' },
      body: '{}'
    })).resolves.toEqual({ status: 404, body: { error: 'Unknown AT JumpServer Terminal MCP bridge endpoint.' } });
  });
});

function service(overrides = {}) {
  return {
    listAssets: async () => ({}),
    getTerminalContext: async () => ({}),
    sendTerminalInput: async () => ({}),
    runTerminalCommand: async () => ({}),
    sftpListDirectory: async () => ({}),
    sftpStatPath: async () => ({}),
    sftpReadFile: async () => ({}),
    sftpWriteFile: async () => ({}),
    sftpCreateFile: async () => ({}),
    sftpCreateDirectory: async () => ({}),
    sftpRename: async () => ({}),
    sftpDelete: async () => ({}),
    mysqlGetContext: async () => ({}),
    mysqlSendInput: async () => ({}),
    mysqlExecuteSql: async () => ({}),
    ...overrides
  } as never;
}
