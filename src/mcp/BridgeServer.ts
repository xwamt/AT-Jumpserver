import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import type { JumpServerAgentToolService } from '../agent/JumpServerAgentToolService';
import { formatError } from '../utils/errors';
import { removeBridgeDiscovery, writeBridgeDiscovery } from './BridgeDiscovery';
import { BRIDGE_HOST, BRIDGE_TOKEN_HEADER } from './BridgeProtocol';

export interface BridgeHandlerDependencies {
  service: JumpServerAgentToolService;
  token: string;
}

export interface BridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

export class BridgeServer {
  private server: Server | undefined;
  private token = '';
  private port: number | undefined;

  constructor(
    private readonly service: JumpServerAgentToolService,
    private readonly home = homedir()
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = randomBytes(32).toString('hex');
    const handler = createBridgeRequestHandler({ service: this.service, token: this.token });
    this.server = createServer((request, response) => {
      void handleNodeRequest(handler, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, BRIDGE_HOST, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start AT JumpServer Terminal MCP bridge.');
    }
    this.port = address.port;
    await writeBridgeDiscovery(this.home, {
      port: address.port,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now()
    });
  }

  async dispose(): Promise<void> {
    const server = this.server;
    const port = this.port;
    const token = this.token;
    this.server = undefined;
    this.port = undefined;
    await removeBridgeDiscovery(
      this.home,
      port && token ? { port, token, pid: process.pid } : undefined
    );
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function createBridgeRequestHandler(dependencies: BridgeHandlerDependencies) {
  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    try {
      if (request.headers[BRIDGE_TOKEN_HEADER] !== dependencies.token) {
        return json(401, { error: 'Unauthorized JumpServer MCP bridge request.' });
      }
      if (request.path === '/health') {
        return json(200, { ok: true });
      }
      if (request.method !== 'POST') {
        return json(405, { error: 'Method not allowed.' });
      }
      const body = parseBody(request.body);
      if (request.path === '/tools/jumpserver_list_assets') {
        return json(200, await dependencies.service.listAssets());
      }
      if (request.path === '/tools/jumpserver_get_terminal_context') {
        return json(200, await dependencies.service.getTerminalContext());
      }
      if (request.path === '/tools/jumpserver_send_terminal_input') {
        return json(200, await dependencies.service.sendTerminalInput(body as never));
      }
      if (request.path === '/tools/jumpserver_run_terminal_command') {
        return json(200, await dependencies.service.runTerminalCommand(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_list_directory') {
        return json(200, await dependencies.service.sftpListDirectory(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_stat_path') {
        return json(200, await dependencies.service.sftpStatPath(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_read_file') {
        return json(200, await dependencies.service.sftpReadFile(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_write_file') {
        return json(200, await dependencies.service.sftpWriteFile(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_create_file') {
        return json(200, await dependencies.service.sftpCreateFile(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_create_directory') {
        return json(200, await dependencies.service.sftpCreateDirectory(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_rename') {
        return json(200, await dependencies.service.sftpRename(body as never));
      }
      if (request.path === '/tools/jumpserver_sftp_delete') {
        return json(200, await dependencies.service.sftpDelete(body as never));
      }
      if (request.path === '/tools/jumpserver_mysql_get_context') {
        return json(200, await dependencies.service.mysqlGetContext());
      }
      if (request.path === '/tools/jumpserver_mysql_send_input') {
        return json(200, await dependencies.service.mysqlSendInput(body as never));
      }
      if (request.path === '/tools/jumpserver_mysql_execute_sql') {
        return json(200, await dependencies.service.mysqlExecuteSql(body as never));
      }
      return json(404, { error: 'Unknown AT JumpServer Terminal MCP bridge endpoint.' });
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

function parseBody<T>(body: string | undefined): T {
  if (!body) {
    return {} as T;
  }
  return JSON.parse(body) as T;
}

function json(status: number, body: unknown): BridgeResponse {
  return { status, body };
}

async function handleNodeRequest(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const result = await handler({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    });
    response.statusCode = result.status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(result.body));
  } catch (error) {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: formatError(error) }));
  }
}
