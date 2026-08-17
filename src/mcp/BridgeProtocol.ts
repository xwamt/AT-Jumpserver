import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES
} from '@at-series/mcp-hub';
import type { TerminalContextSnapshot } from '../terminal/TerminalContext';

export { AT_JUMPSERVER_PLUGIN_DISPLAY_NAME } from './toolCatalog';
export { AT_SERIES_TOKEN_HEADER, BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES, AT_SERIES_PROTOCOL_VERSION };

/** Legacy auth header accepted during migration. */
export const BRIDGE_TOKEN_HEADER = 'x-at-jumpserver-terminal-token';

export const JUMPSERVER_MCP_TOOL_NAMES = [
  'jumpserver_list_assets',
  'jumpserver_get_terminal_context',
  'jumpserver_send_terminal_input',
  'jumpserver_run_terminal_command',
  'jumpserver_sftp_list_directory',
  'jumpserver_sftp_stat_path',
  'jumpserver_sftp_read_file',
  'jumpserver_sftp_write_file',
  'jumpserver_sftp_create_file',
  'jumpserver_sftp_create_directory',
  'jumpserver_sftp_rename',
  'jumpserver_sftp_delete',
  'jumpserver_mysql_execute_sql',
  'jumpserver_redis_execute_command'
] as const;

export type JumpServerMcpToolName = typeof JUMPSERVER_MCP_TOOL_NAMES[number];

export interface BridgeDiscovery {
  port: number;
  token: string;
  pid: number;
  updatedAt: number;
}

export interface RemoveBridgeDiscoveryOwner {
  port: number;
  token: string;
  pid: number;
}

export type GetTerminalContextBridgeResponse = TerminalContextSnapshot;

export interface ListAssetsBridgeRequest {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface TerminalTargetBridgeRequest {
  terminalId?: string;
}

export interface SendTerminalInputBridgeRequest extends TerminalTargetBridgeRequest {
  input: string;
}

export interface RunTerminalCommandBridgeRequest extends TerminalTargetBridgeRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SftpTargetBridgeRequest {
  connectionKey?: string;
  terminalId?: string;
}

export interface SftpPathBridgeRequest extends SftpTargetBridgeRequest {
  path: string;
}

export interface SftpListDirectoryBridgeRequest extends SftpTargetBridgeRequest {
  path?: string;
  maxEntries?: number;
}

export interface SftpReadFileBridgeRequest extends SftpPathBridgeRequest {
  maxBytes?: number;
}

export interface SftpWriteFileBridgeRequest extends SftpPathBridgeRequest {
  content: string;
  overwrite?: boolean;
}

export interface SftpCreateFileBridgeRequest extends SftpPathBridgeRequest {
  content?: string;
}

export interface SftpRenameBridgeRequest extends SftpTargetBridgeRequest {
  oldPath: string;
  newPath: string;
}

export interface SftpDeleteBridgeRequest extends SftpPathBridgeRequest {}

export interface MysqlExecuteSqlBridgeRequest extends TerminalTargetBridgeRequest {
  sql: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RedisExecuteCommandBridgeRequest extends TerminalTargetBridgeRequest {
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface BridgeErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
