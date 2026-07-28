import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type IdeMcpConfigTargetId = 'kiro' | 'cursor';

export interface IdeMcpConfigTarget {
  id: IdeMcpConfigTargetId;
  displayName: string;
}

export interface ResolveIdeMcpConfigTargetOptions {
  appName?: string;
  appRoot?: string;
  uriScheme?: string;
  extensionPath?: string;
}

export interface InstallContinueMcpConfigOptions {
  workspaceFolder: string;
  mcpServerPath: string;
  waitForServerMs?: number;
  pollIntervalMs?: number;
}

export interface InstallIdeMcpConfigOptions {
  home?: string;
  target: IdeMcpConfigTarget | undefined;
  mcpServerPath: string;
  waitForServerMs?: number;
  pollIntervalMs?: number;
}

const AUTO_APPROVE_TOOLS = [
  'jumpserver_list_assets',
  'jumpserver_get_terminal_context',
  'jumpserver_sftp_list_directory',
  'jumpserver_sftp_stat_path',
  'jumpserver_sftp_read_file',
  'jumpserver_mysql_get_context'
];

export function buildContinueMcpConfig(mcpServerPath: string): string {
  const normalized = normalizePath(mcpServerPath);
  return `name: AT JumpServer Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT JumpServer Terminal
    command: node
    args:
      - ${normalized}
`;
}

export function continueMcpConfigPath(workspaceFolder: string): string {
  return join(workspaceFolder, '.continue', 'mcpServers', 'at-jumpserver-terminal.yaml');
}

export async function installContinueMcpConfig(options: InstallContinueMcpConfigOptions): Promise<string> {
  await waitForMcpServerBundle(options);
  const target = continueMcpConfigPath(options.workspaceFolder);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buildContinueMcpConfig(options.mcpServerPath), 'utf8');
  return target;
}

export function kiroMcpConfigPath(home = homedir()): string {
  return join(home, '.kiro', 'settings', 'mcp.json');
}

export function cursorMcpConfigPath(home = homedir()): string {
  return join(home, '.cursor', 'mcp.json');
}

export function resolveIdeMcpConfigTarget(options: ResolveIdeMcpConfigTargetOptions): IdeMcpConfigTarget | undefined {
  const signals = [options.extensionPath, options.appName, options.appRoot, options.uriScheme]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizePath(value).toLowerCase());
  if (signals.some((value) => value.includes('/.kiro/') || value.includes('\\.kiro\\') || value.includes('kiro'))) {
    return { id: 'kiro', displayName: 'Kiro' };
  }
  if (signals.some((value) => value.includes('/.cursor/') || value.includes('\\.cursor\\') || value.includes('cursor'))) {
    return { id: 'cursor', displayName: 'Cursor' };
  }
  return undefined;
}

export async function installIdeMcpConfig(options: InstallIdeMcpConfigOptions): Promise<string> {
  if (!options.target) {
    throw new Error('Unsupported VS Code-compatible IDE for automatic MCP config.');
  }
  await waitForMcpServerBundle(options);
  const target = ideMcpConfigPath(options.target.id, options.home);
  const config = await readJsonObject(target);
  const mcpServers = readMcpServers(config);
  config.name = typeof config.name === 'string' ? config.name : 'AT JumpServer Terminal MCP';
  config.version = typeof config.version === 'string' ? config.version : '0.0.1';
  config.schema = typeof config.schema === 'string' ? config.schema : 'v1';
  config.mcpServers = {
    ...mcpServers,
    'AT JumpServer Terminal': buildIdeMcpServerConfig(options.mcpServerPath)
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}

export async function ensureIdeMcpConfig(options: InstallIdeMcpConfigOptions): Promise<string | undefined> {
  if (!options.target) {
    return undefined;
  }
  await waitForMcpServerBundle(options);
  const target = ideMcpConfigPath(options.target.id, options.home);
  const config = await readJsonObject(target);
  const server = readMcpServers(config)['AT JumpServer Terminal'];
  if (hasCurrentIdeMcpServer(server, options.mcpServerPath)) {
    return undefined;
  }
  return installIdeMcpConfig(options);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(stripJsonBom(text)) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function stripJsonBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.mcpServers) ? config.mcpServers : {};
}

function ideMcpConfigPath(target: IdeMcpConfigTargetId, home = homedir()): string {
  return target === 'kiro' ? kiroMcpConfigPath(home) : cursorMcpConfigPath(home);
}

function buildIdeMcpServerConfig(mcpServerPath: string): Record<string, unknown> {
  return {
    command: 'node',
    args: [normalizePath(mcpServerPath)],
    autoApprove: AUTO_APPROVE_TOOLS
  };
}

function hasCurrentIdeMcpServer(value: unknown, mcpServerPath: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.command !== 'node') {
    return false;
  }
  if (!Array.isArray(value.args) || value.args[0] !== normalizePath(mcpServerPath)) {
    return false;
  }
  const autoApprove = value.autoApprove;
  if (!Array.isArray(autoApprove)) {
    return false;
  }
  return AUTO_APPROVE_TOOLS.every((toolName) => autoApprove.includes(toolName));
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function waitForMcpServerBundle(options: {
  mcpServerPath: string;
  waitForServerMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  if (options.waitForServerMs === 0) {
    return;
  }
  const timeoutMs = options.waitForServerMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (await isFile(options.mcpServerPath)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `AT JumpServer Terminal MCP server bundle is missing: ${normalizePath(options.mcpServerPath)}. Reinstall the MCP VSIX after packaging completes.`
      );
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
