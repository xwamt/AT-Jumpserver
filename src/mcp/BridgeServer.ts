import { randomUUID } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES,
  bridgesDirForHostApp,
  createBridgeToken,
  FsBridgePublisher,
  timingSafeEqualToken,
  type HostApp
} from '@at-series/mcp-hub';
import type { JumpServerAgentToolService } from '../agent/JumpServerAgentToolService';
import { formatError } from '../utils/errors';
import {
  listAssetsBridgeSchema,
  mysqlExecuteSqlBridgeSchema,
  redisExecuteCommandBridgeSchema,
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

/**
 * The hub's `fs.watch` on the registry fires on every rewrite, so an idle
 * bridge that rewrites its record twice a minute keeps the hub (and any
 * cloud-synced home directory) churning for nothing. Heartbeats are skipped
 * while `connectedTargets` is unchanged and rewritten immediately when it
 * changes; this interval bounds how stale `updatedAt` may get regardless, as
 * a safety net for consumers that read the timestamp instead of probing
 * `/health`.
 */
export const BRIDGE_HEARTBEAT_FORCE_WRITE_INTERVAL_MS = 5 * 60_000;

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
  /** Pre-serialized `body`; transports send it verbatim instead of re-stringifying. */
  serializedBody?: string;
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

const TOOLS_RESPONSE_BODY = {
  protocolVersion: AT_SERIES_PROTOCOL_VERSION,
  tools: AT_JUMPSERVER_TOOL_CATALOG
};

/**
 * `GET /tools` returns a constant; serialize the multi-KB catalog once at
 * module load instead of on every hub poll.
 */
export const TOOLS_RESPONSE_JSON = JSON.stringify(TOOLS_RESPONSE_BODY);

export class BridgeServer {
  private server: Server | undefined;
  private token = '';
  private port: number | undefined;
  private publisher: FsBridgePublisher | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastPublishedTargets: number | undefined;
  private lastHeartbeatWriteAt = 0;
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
    // Windows that crash never unpublish, so their records would sit in the
    // registry forever and make the hub probe dead ports. Only records this
    // plugin wrote are candidates — other plugins own their own lifecycle.
    try {
      await gcStaleBridgeRecords({ hostApp: this.hostApp, home: this.home });
    } catch {
      // Registry hygiene must never block the bridge from starting.
    }
    this.token = createBridgeToken();
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
    this.lastPublishedTargets = connectedTargets;
    this.lastHeartbeatWriteAt = Date.now();
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
      const now = Date.now();
      if (
        connectedTargets === this.lastPublishedTargets &&
        now - this.lastHeartbeatWriteAt < BRIDGE_HEARTBEAT_FORCE_WRITE_INTERVAL_MS
      ) {
        // Nothing changed: skip the disk write instead of rewriting the same
        // record (an utimes-style touch would still trip the hub's fs.watch).
        return;
      }
      await publisher.heartbeat({ capabilities: { connectedTargets } });
      this.lastPublishedTargets = connectedTargets;
      this.lastHeartbeatWriteAt = now;
    } catch {
      // Best-effort; next interval retries.
    }
  }
}

export interface GcStaleBridgeRecordsOptions {
  hostApp: HostApp;
  home?: string;
  /** Test hook: replace the `process.kill(pid, 0)` liveness probe. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Delete registry records left behind by dead windows of THIS plugin.
 * Records from other plugins are never touched, whatever their state. A live
 * pid is trusted as-is (pid reuse handing a stale record to an unrelated
 * process is acceptable — the hub's health probe rejects it anyway).
 * Returns the file names it removed.
 */
export async function gcStaleBridgeRecords(options: GcStaleBridgeRecordsOptions): Promise<string[]> {
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  let names: string[];
  try {
    names = await readdir(bridgesDirForHostApp(options.hostApp, options.home));
  } catch {
    return [];
  }
  const dir = bridgesDirForHostApp(options.hostApp, options.home);
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const recordPath = join(dir, name);
    try {
      const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as {
        pluginId?: unknown;
        pid?: unknown;
      };
      if (parsed?.pluginId !== AT_JUMPSERVER_PLUGIN_ID) {
        continue;
      }
      if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
        continue;
      }
      if (isPidAlive(parsed.pid)) {
        continue;
      }
      await unlink(recordPath);
      removed.push(name);
    } catch {
      // Unreadable or contended record: leave it for its owner or the next GC.
    }
  }
  return removed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
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
        return { status: 200, body: TOOLS_RESPONSE_BODY, serializedBody: TOOLS_RESPONSE_JSON };
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
    case 'jumpserver_mysql_execute_sql': {
      const parsed = parseArgsWithSchema(args, mysqlExecuteSqlBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.mysqlExecuteSql(parsed.data) };
    }
    case 'jumpserver_redis_execute_command': {
      const parsed = parseArgsWithSchema(args, redisExecuteCommandBridgeSchema);
      if (!parsed.ok) {
        return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
      }
      return { ok: true, value: await service.redisExecuteCommand(parsed.data) };
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
  return (
    matchesToken(headerValue(headers, AT_SERIES_TOKEN_HEADER), token) ||
    matchesToken(headerValue(headers, BRIDGE_TOKEN_HEADER), token)
  );
}

/**
 * Protocol v1 §7.2 requires constant-time comparison. `timingSafeEqualToken`
 * takes two strings, so an absent header is resolved to a plain miss here
 * rather than handed to the comparison as `undefined`.
 */
function matchesToken(presented: string | undefined, token: string): boolean {
  return typeof presented === 'string' && timingSafeEqualToken(presented, token);
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
    writeJson(response, result.status, result.body, result.serializedBody);
  } catch (error) {
    writeJson(response, 500, {
      error: { code: 'INTERNAL_ERROR', message: formatError(error) }
    });
  }
}

function writeJson(
  response: BridgeNodeResponse,
  status: number,
  body: unknown,
  serializedBody?: string
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(serializedBody ?? JSON.stringify(body));
}
