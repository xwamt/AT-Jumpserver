import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../../src/mcp/BridgeClient';
import { writeBridgeDiscovery } from '../../src/mcp/BridgeDiscovery';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

describe('JumpServer BridgeClient', () => {
  it('throws a clear error when bridge discovery is missing', async () => {
    const client = new BridgeClient({ home: join(process.cwd(), '.tmp-missing-jumpserver-bridge') });
    await expect(client.listAssets()).rejects.toThrow('AT JumpServer Terminal MCP bridge is not running');
  });

  it('calls the JumpServer bridge with the discovery token', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-client');
    await writeBridgeDiscovery(home, { port: 34567, token: 'token-1', pid: 111, updatedAt: 222 });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ assets: [] })
    }));
    const client = new BridgeClient({ home, fetch: fetchImpl });

    await expect(client.listAssets()).resolves.toEqual({ assets: [] });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:34567/tools/jumpserver_list_assets', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BRIDGE_TOKEN_HEADER]: 'token-1'
      },
      body: '{}'
    });
  });

  it('surfaces bridge error responses', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-client-error');
    await writeBridgeDiscovery(home, { port: 34568, token: 'token-2', pid: 111, updatedAt: 222 });
    const client = new BridgeClient({
      home,
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'No matching JumpServer terminal.' })
      })
    });

    await expect(client.getTerminalContext()).rejects.toThrow('No matching JumpServer terminal.');
  });
});
