import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import type { z } from 'zod';
import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES,
  FsBridgePublisher,
  type HostApp
} from '@at-series/mcp-hub';
import type { JumpServerAgentToolService } from '../agent/JumpServerAgentToolService';
import { formatError } from '../utils/errors';
import {
  listAssetsBridgeSchema,
  mysqlExecuteSqlBridgeSchema,
  mysqlSendInputBridgeSchema,
  runTerminalCommandBridgeSchema,
  sendTerminalInputBridgeSchema,
  sftpCreateFileBridgeSchema,
  sftpListDirectoryBridgeSchema,
  sftpPathBridgeSchema,
  sftpReadFileBridgeSchema,
  sftpRenameBridgeSchema,
  sftpWriteFileBridgeSchema
} from './bridgeSchemas';
import { AT_JUMPSERVER_PLUGIN_DISPLAY_NAME, BRIDGE_TOKEN_HEADER } from './BridgeProtocol';
import { AT_JUMPSERVER_PLUGIN_ID, AT_JUMPSERVER_TOOL_CATALOG } from './toolCatalog';

/** Heartbeat cadence for `~/.at-series` registry freshness (protocol: ≤30s). */
const BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000;

/** Deadline for a client to deliver a whole request; not a response deadline. */
const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

/** Deadline for the request line and headers alone. Must not exceed the above. */
const BRIDGE_HEADERS_TIMEOUT_MS = 10_000;

export interface BridgePublisherFactoryOptions {
  bridgeId: string;
  hostApp: HostApp;
  home: string;
}

export interface BridgeServerOptions {
  service: JumpServerAgentToolService;
  home?: string;
  hostApp: HostApp;
  pluginVersion?: string;
  /** Test hook: override FsBridgePublisher construction. */
  createPublisher?: (options: BridgePublisherFactoryOptions) => FsBridgePublisher;
}

export interface BridgeHandlerDependencies {
  service: JumpServerAgentToolService;
  token: string;
  bridgeId: string;
  hostApp: HostApp;
  pluginVersion: string;
  pluginDisplayName?: string;
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

/**
 * The subset of `http.IncomingMessage` the bridge touches. Narrowing it here
 * lets tests drive the node path with a stream they can observe, instead of
 * only being able to assert on what a real socket happened to deliver.
 */
export interface BridgeNodeRequest extends AsyncIterable<Buffer | string> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The subset of `http.ServerResponse` the bridge touches. */
export interface BridgeNodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

const DEFAULT_PLUGIN_VERSION = '0.0.0';

export class BridgeServer {
  private server: Server | undefined;
  private token = '';
  private port: number | undefined;
  private publisher: FsBridgePublisher | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly bridgeId = randomUUID();
  private readonly service: JumpServerAgentToolService;
  private readonly home: string;
  private readonly hostApp: HostApp;
  private readonly pluginVersion: string;
  private readonly createPublisher: (options: BridgePublisherFactoryOptions) => FsBridgePublisher;

  constructor(options: BridgeServerOptions) {
    this.service = options.service;
    this.home = options.home ?? homedir();
    this.hostApp = options.hostApp;
    this.pluginVersion = options.pluginVersion ?? DEFAULT_PLUGIN_VERSION;
    this.createPublisher = options.createPublisher ?? ((publisherOptions) => new FsBridgePublisher(publisherOptions));
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = randomBytes(32).toString('hex');
    this.server = createServer(createBridgeNodeListener({
      service: this.service,
      token: this.token,
      bridgeId: this.bridgeId,
      hostApp: this.hostApp,
      pluginVersion: this.pluginVersion
    }));
    // Node's defaults (5 min / 1 min) let a local process pin sockets open by
    // dribbling a request. These bound receipt of the request only, so they do
    // not cap how long a tool call may take to answer.
    this.server.requestTimeout = BRIDGE_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = BRIDGE_HEADERS_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, BRIDGE_HOST, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start AT JumpServer Terminal MCP bridge.');
    }
    this.port = address.port;

    const connectedTargets = await readConnectedTargets(this.service);
    const publisher = this.createPublisher({
      bridgeId: this.bridgeId,
      hostApp: this.hostApp,
      home: this.home
    });
    this.publisher = publisher;
    try {
      await publisher.publish({
        protocolVersion: AT_SERIES_PROTOCOL_VERSION,
        bridgeId: this.bridgeId,
        pluginId: AT_JUMPSERVER_PLUGIN_ID,
        pluginDisplayName: AT_JUMPSERVER_PLUGIN_DISPLAY_NAME,
        pluginVersion: this.pluginVersion,
        hostApp: this.hostApp,
        port: address.port,
        token: this.token,
        pid: process.pid,
        updatedAt: Date.now(),
        tools: AT_JUMPSERVER_TOOL_CATALOG,
        capabilities: { connectedTargets }
      });
    } catch (error) {
      await this.rollbackFailedStart();
      throw error;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat();
    }, BRIDGE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async rollbackFailedStart(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.publisher = undefined;
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async dispose(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const publisher = this.publisher;
    this.publisher = undefined;
    if (publisher) {
      await publisher.unpublish();
    }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async tickHeartbeat(): Promise<void> {
    const publisher = this.publisher;
    if (!publisher) {
      return;
    }
    try {
      const connectedTargets = await readConnectedTargets(this.service);
      await publisher.heartbeat({ capabilities: { connectedTargets } });
    } catch {
      // Best-effort; next interval retries.
    }
  }
}

async function readConnectedTargets(service: JumpServerAgentToolService): Promise<number> {
  try {
    const context = await service.getTerminalContext();
    return Array.isArray(context?.connectedTerminals)
      ? context.connectedTerminals.length
      : 0;
  } catch {
    return 0;
  }
}

export function createBridgeRequestHandler(dependencies: BridgeHandlerDependencies) {
  const pluginDisplayName = dependencies.pluginDisplayName ?? AT_JUMPSERVER_PLUGIN_DISPLAY_NAME;

  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    try {
      if (!isAuthorized(request.headers, dependencies.token)) {
        return bridgeError(401, 'UNAUTHORIZED', 'Unauthorized MCP bridge request.');
      }

      const path = normalizePath(request.path);
      const method = request.method.toUpperCase();

      if (path === '/health' && (method === 'GET' || method === 'POST')) {
        return json(200, await buildHealthResponse(dependencies, pluginDisplayName));
      }

      if (path === '/tools' && method === 'GET') {
        return json(200, {
          protocolVersion: AT_SERIES_PROTOCOL_VERSION,
          tools: AT_JUMPSERVER_TOOL_CATALOG
        });
      }

      if (path === '/invoke' && method === 'POST') {
        return await handleInvoke(dependencies, request.body);
      }

      if (method !== 'GET' && method !== 'POST') {
        return bridgeError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }

      return bridgeError(404, 'NOT_FOUND', 'Unknown AT JumpServer Terminal MCP bridge endpoint.');
    } catch (error) {
      return bridgeError(
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  };
}

async function buildHealthResponse(
  dependencies: BridgeHandlerDependencies,
  pluginDisplayName: string
) {
  const connectedTargets = await readConnectedTargets(dependencies.service);

  return {
    ok: true,
    protocolVersion: AT_SERIES_PROTOCOL_VERSION,
    bridgeId: dependencies.bridgeId,
    pluginId: AT_JUMPSERVER_PLUGIN_ID,
    pluginDisplayName,
    pluginVersion: dependencies.pluginVersion,
    hostApp: dependencies.hostApp,
    pid: process.pid,
    updatedAt: Date.now(),
    connectedTargets,
    toolCount: AT_JUMPSERVER_TOOL_CATALOG.length
  };
}

async function handleInvoke(
  dependencies: BridgeHandlerDependencies,
  body: string | undefined
): Promise<BridgeResponse> {
  let raw: unknown = {};
  if (body) {
    try {
      raw = JSON.parse(body);
    } catch {
      return bridgeError(400, 'BAD_REQUEST', 'Invalid JSON body.');
    }
  }

  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof (raw as { name?: unknown }).name !== 'string' ||
    typeof (raw as { arguments?: unknown }).arguments !== 'object' ||
    (raw as { arguments?: unknown }).arguments === null ||
    Array.isArray((raw as { arguments?: unknown }).arguments)
  ) {
    return bridgeError(400, 'BAD_REQUEST', 'Expected { name: string, arguments: object }.');
  }

  const name = (raw as { name: string }).name;
  const args = (raw as { arguments: Record<string, unknown> }).arguments;

  try {
    const result = await dispatchTool(dependencies.service, name, args);
    if (!result.ok) {
      return result.response;
    }
    return json(200, { ok: true, name, result: result.value });
  } catch (error) {
    if (error instanceof Error && /cancelled/i.test(error.message)) {
      return bridgeError(499, 'USER_CANCELLED', error.message);
    }
    throw error;
  }
}

async function dispatchTool(
  service: JumpServerAgentToolService,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; response: BridgeResponse }> {
  switch (name) {
    case 'jumpserver_list_assets': {
      const parsed = parseArgsWithSchema(args, listAssetsBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.listAssets(parsed.data) };
    }
    case 'jumpserver_get_terminal_context':
      return { ok: true, value: await service.getTerminalContext() };
    case 'jumpserver_send_terminal_input': {
      const parsed = parseArgsWithSchema(args, sendTerminalInputBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sendTerminalInput(parsed.data) };
    }
    case 'jumpserver_run_terminal_command': {
      const parsed = parseArgsWithSchema(args, runTerminalCommandBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      const command = parsed.data.command.trim();
      if (!command) {
        return {
          ok: false,
          response: bridgeError(422, 'VALIDATION_ERROR', 'Terminal command cannot be empty.')
        };
      }
      return {
        ok: true,
        value: await service.runTerminalCommand({ ...parsed.data, command })
      };
    }
    case 'jumpserver_sftp_list_directory': {
      const parsed = parseArgsWithSchema(args, sftpListDirectoryBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpListDirectory(parsed.data) };
    }
    case 'jumpserver_sftp_stat_path': {
      const parsed = parseArgsWithSchema(args, sftpPathBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpStatPath(parsed.data) };
    }
    case 'jumpserver_sftp_read_file': {
      const parsed = parseArgsWithSchema(args, sftpReadFileBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpReadFile(parsed.data) };
    }
    case 'jumpserver_sftp_write_file': {
      const parsed = parseArgsWithSchema(args, sftpWriteFileBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpWriteFile(parsed.data) };
    }
    case 'jumpserver_sftp_create_file': {
      const parsed = parseArgsWithSchema(args, sftpCreateFileBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpCreateFile(parsed.data) };
    }
    case 'jumpserver_sftp_create_directory': {
      const parsed = parseArgsWithSchema(args, sftpPathBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpCreateDirectory(parsed.data) };
    }
    case 'jumpserver_sftp_rename': {
      const parsed = parseArgsWithSchema(args, sftpRenameBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpRename(parsed.data) };
    }
    case 'jumpserver_sftp_delete': {
      const parsed = parseArgsWithSchema(args, sftpPathBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.sftpDelete(parsed.data) };
    }
    case 'jumpserver_mysql_get_context':
      return { ok: true, value: await service.mysqlGetContext() };
    case 'jumpserver_mysql_send_input': {
      const parsed = parseArgsWithSchema(args, mysqlSendInputBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.mysqlSendInput(parsed.data) };
    }
    case 'jumpserver_mysql_execute_sql': {
      const parsed = parseArgsWithSchema(args, mysqlExecuteSqlBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.mysqlExecuteSql(parsed.data) };
    }
    default:
      return {
        ok: false,
        response: bridgeError(404, 'NOT_FOUND', `Unknown tool: ${name}`)
      };
  }
}

function parseArgsWithSchema<T>(
  raw: unknown,
  schema: z.ZodType<T>
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
    };
  }
  return { ok: true, data: parsed.data };
}

export async function readLimitedBody(
  request: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  maxBytes: number
): Promise<{ ok: true; body: string } | { ok: false; status: 413; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      return { ok: false, status: 413, error: `Request body exceeds ${maxBytes} bytes.` };
    }
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}

function isAuthorized(
  headers: Record<string, string | string[] | undefined>,
  token: string
): boolean {
  const series = headerValue(headers, AT_SERIES_TOKEN_HEADER);
  if (series === token) {
    return true;
  }
  const legacy = headerValue(headers, BRIDGE_TOKEN_HEADER);
  return legacy === token;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  return withoutQuery.length > 0 ? withoutQuery : '/';
}

function json(status: number, body: unknown): BridgeResponse {
  return { status, body };
}

function bridgeError(
  status: number,
  code: string,
  message: string,
  details?: unknown
): BridgeResponse {
  return {
    status,
    body: {
      error: details === undefined ? { code, message } : { code, message, details }
    }
  };
}

/**
 * Wires a `createBridgeRequestHandler` into the node HTTP plumbing: body
 * limiting, JSON framing, and the pre-body auth gate.
 */
export function createBridgeNodeListener(
  dependencies: BridgeHandlerDependencies
): (request: BridgeNodeRequest, response: BridgeNodeResponse) => void {
  const handler = createBridgeRequestHandler(dependencies);
  return (request, response) => {
    void handleNodeRequest(handler, dependencies.token, request, response);
  };
}

async function handleNodeRequest(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  token: string,
  request: BridgeNodeRequest,
  response: BridgeNodeResponse
): Promise<void> {
  try {
    // The token lives in a header, so it can be checked before a single body
    // byte is buffered. Reading first would let every local process make the
    // extension host hold BRIDGE_MAX_BODY_BYTES per concurrent request without
    // ever presenting a credential.
    if (!isAuthorized(request.headers, token)) {
      writeJson(response, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized MCP bridge request.' }
      });
      return;
    }
    const limited = await readLimitedBody(request, BRIDGE_MAX_BODY_BYTES);
    if (!limited.ok) {
      writeJson(response, limited.status, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: limited.error }
      });
      return;
    }
    const result = await handler({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: limited.body
    });
    writeJson(response, result.status, result.body);
  } catch (error) {
    writeJson(response, 500, {
      error: { code: 'INTERNAL_ERROR', message: formatError(error) }
    });
  }
}

function writeJson(response: BridgeNodeResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}
