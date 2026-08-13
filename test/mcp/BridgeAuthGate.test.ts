import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AT_SERIES_TOKEN_HEADER, BRIDGE_MAX_BODY_BYTES } from '@at-series/mcp-hub';
import {
  createBridgeNodeListener,
  createBridgeRequestHandler,
  type BridgeNodeRequest,
  type BridgeNodeResponse
} from '../../src/mcp/BridgeServer';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

const TOKEN = 'a'.repeat(64);

function stubService() {
  return {
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
    mysqlExecuteSql: vi.fn()
  } as never;
}

function dependencies(token = TOKEN) {
  return {
    service: stubService(),
    token,
    bridgeId: 'bridge-1',
    hostApp: 'cursor' as const,
    pluginVersion: '0.3.0'
  };
}

function listener(token = TOKEN) {
  return createBridgeNodeListener(dependencies(token));
}

function health(token: string, headers: Record<string, string>) {
  return createBridgeRequestHandler(dependencies(token))({
    method: 'GET',
    path: '/health',
    headers
  });
}

/**
 * A request whose body stream reports every chunk the server pulls, so a test
 * can tell "rejected without reading" apart from "read, then rejected".
 */
function recordingRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  chunks?: Buffer[];
}) {
  const pulled = { chunks: 0, bytes: 0 };
  const chunks = options.chunks ?? [];
  const request: BridgeNodeRequest = {
    method: options.method ?? 'POST',
    url: options.url ?? '/invoke',
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        pulled.chunks += 1;
        pulled.bytes += chunk.byteLength;
        yield chunk;
      }
    }
  };
  return { request, pulled };
}

function recordingResponse() {
  const headers = new Map<string, string>();
  let body: string | undefined;
  const response: BridgeNodeResponse & { readonly body: string | undefined } = {
    statusCode: 0,
    get body() {
      return body;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(chunk?: string) {
      body = chunk;
    }
  };
  return response;
}

const servers: Server[] = [];

async function startBridge(token = TOKEN): Promise<number> {
  const server = createServer(listener(token));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Declares a body far larger than it sends and never ends the request. A server
 * that buffers the body before authorising cannot answer this at all; one that
 * checks the token first answers immediately.
 */
function postPartialBody(options: {
  port: number;
  declaredBytes: number;
  sentBytes: number;
  headers?: Record<string, string>;
  waitMs?: number;
}): Promise<{ status: number | undefined; sent: number }> {
  return new Promise((resolve) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port: options.port,
      method: 'POST',
      path: '/invoke',
      headers: {
        'content-type': 'application/json',
        'content-length': String(options.declaredBytes),
        ...options.headers
      }
    });
    let settled = false;
    const finish = (status: number | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve({ status, sent: options.sentBytes });
    };
    const timer = setTimeout(() => finish(undefined), options.waitMs ?? 1500);
    client.on('response', (response) => {
      response.resume();
      finish(response.statusCode);
    });
    client.on('error', () => finish(undefined));
    client.write(Buffer.alloc(options.sentBytes, 0x61));
    // Deliberately no client.end(): the body stays incomplete.
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
});

describe('bridge auth gate', () => {
  it('answers 401 before the request body has finished arriving', async () => {
    const port = await startBridge();

    const result = await postPartialBody({
      port,
      declaredBytes: BRIDGE_MAX_BODY_BYTES,
      sentBytes: 4096
    });

    expect(result.status).toBe(401);
  });

  it('never pulls a byte of body from an unauthenticated request', async () => {
    const { request, pulled } = recordingRequest({
      headers: {},
      chunks: [Buffer.alloc(BRIDGE_MAX_BODY_BYTES, 0x61)]
    });
    const response = recordingResponse();

    listener()(request, response);
    await vi.waitFor(() => expect(response.statusCode).toBe(401));

    expect(pulled).toEqual({ chunks: 0, bytes: 0 });
  });

  it('never pulls a byte of body when the token is wrong', async () => {
    const { request, pulled } = recordingRequest({
      headers: { [AT_SERIES_TOKEN_HEADER]: 'b'.repeat(64) },
      chunks: [Buffer.alloc(1024, 0x61)]
    });
    const response = recordingResponse();

    listener()(request, response);
    await vi.waitFor(() => expect(response.statusCode).toBe(401));

    expect(pulled).toEqual({ chunks: 0, bytes: 0 });
  });

  it('still reads the body once the series token is valid', async () => {
    const { request, pulled } = recordingRequest({
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      chunks: [Buffer.from(JSON.stringify({ name: 'jumpserver_list_assets', arguments: {} }))]
    });
    const response = recordingResponse();

    listener()(request, response);
    await vi.waitFor(() => expect(response.statusCode).toBe(200));

    expect(pulled.chunks).toBe(1);
    expect(response.body).toContain('jumpserver_list_assets');
  });

  it('still reads the body for the legacy migration token header', async () => {
    const { request, pulled } = recordingRequest({
      headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
      chunks: [Buffer.from(JSON.stringify({ name: 'jumpserver_list_assets', arguments: {} }))]
    });
    const response = recordingResponse();

    listener()(request, response);
    await vi.waitFor(() => expect(response.statusCode).toBe(200));

    expect(pulled.chunks).toBe(1);
  });

  it('still enforces the body limit for authenticated requests', async () => {
    const { request } = recordingRequest({
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      chunks: [Buffer.alloc(BRIDGE_MAX_BODY_BYTES + 1, 0x61)]
    });
    const response = recordingResponse();

    listener()(request, response);
    await vi.waitFor(() => expect(response.statusCode).toBe(413));

    expect(response.body).toContain('PAYLOAD_TOO_LARGE');
  });
});

describe('bridge token comparison', () => {
  // A bridge that failed to mint a token must be closed, not open to everyone
  // who can send an empty header. `===` calls '' a match; the shared helper
  // does not.
  it('refuses an empty series token even when the bridge minted none', async () => {
    await expect(health('', { [AT_SERIES_TOKEN_HEADER]: '' })).resolves.toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } }
    });
  });

  it('refuses an empty legacy token even when the bridge minted none', async () => {
    await expect(health('', { [BRIDGE_TOKEN_HEADER]: '' })).resolves.toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } }
    });
  });

  it('refuses an absent header without throwing when no token was minted', async () => {
    await expect(health('', {})).resolves.toMatchObject({ status: 401 });
  });

  it('refuses a token that is only a prefix of the real one', async () => {
    await expect(
      health(TOKEN, { [AT_SERIES_TOKEN_HEADER]: TOKEN.slice(0, -1) })
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      health(TOKEN, { [BRIDGE_TOKEN_HEADER]: TOKEN.slice(0, -1) })
    ).resolves.toMatchObject({ status: 401 });
  });

  it('still accepts an exact match on either header', async () => {
    await expect(health(TOKEN, { [AT_SERIES_TOKEN_HEADER]: TOKEN })).resolves.toMatchObject({
      status: 200
    });
    await expect(health(TOKEN, { [BRIDGE_TOKEN_HEADER]: TOKEN })).resolves.toMatchObject({
      status: 200
    });
  });
});
