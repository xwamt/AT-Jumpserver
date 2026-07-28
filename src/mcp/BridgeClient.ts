import { homedir } from 'node:os';
import { readBridgeDiscovery } from './BridgeDiscovery';
import {
  BRIDGE_HOST,
  BRIDGE_TOKEN_HEADER,
  type MysqlExecuteSqlBridgeRequest,
  type RunTerminalCommandBridgeRequest,
  type SendTerminalInputBridgeRequest,
  type SftpCreateFileBridgeRequest,
  type SftpDeleteBridgeRequest,
  type SftpListDirectoryBridgeRequest,
  type SftpPathBridgeRequest,
  type SftpReadFileBridgeRequest,
  type SftpRenameBridgeRequest,
  type SftpWriteFileBridgeRequest
} from './BridgeProtocol';

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchLikeResponse>;

export class BridgeClient {
  constructor(
    private readonly options: {
      home?: string;
      fetch?: FetchLike;
    } = {}
  ) {}

  listAssets(): Promise<unknown> {
    return this.call('/tools/jumpserver_list_assets', {});
  }

  getTerminalContext(): Promise<unknown> {
    return this.call('/tools/jumpserver_get_terminal_context', {});
  }

  sendTerminalInput(input: SendTerminalInputBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_send_terminal_input', input);
  }

  runTerminalCommand(input: RunTerminalCommandBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_run_terminal_command', input);
  }

  sftpListDirectory(input: SftpListDirectoryBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_list_directory', input);
  }

  sftpStatPath(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_stat_path', input);
  }

  sftpReadFile(input: SftpReadFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_read_file', input);
  }

  sftpWriteFile(input: SftpWriteFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_write_file', input);
  }

  sftpCreateFile(input: SftpCreateFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_create_file', input);
  }

  sftpCreateDirectory(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_create_directory', input);
  }

  sftpRename(input: SftpRenameBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_rename', input);
  }

  sftpDelete(input: SftpDeleteBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_sftp_delete', input);
  }

  mysqlGetContext(): Promise<unknown> {
    return this.call('/tools/jumpserver_mysql_get_context', {});
  }

  mysqlSendInput(input: SendTerminalInputBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_mysql_send_input', input);
  }

  mysqlExecuteSql(input: MysqlExecuteSqlBridgeRequest): Promise<unknown> {
    return this.call('/tools/jumpserver_mysql_execute_sql', input);
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const discovery = await readBridgeDiscovery(this.options.home ?? homedir());
    if (!discovery) {
      throw new Error(
        'AT JumpServer Terminal MCP bridge is not running. Open VS Code with AT JumpServer Terminal installed, then reload this MCP server.'
      );
    }

    const fetchImpl = this.options.fetch ?? fetch;
    let response: FetchLikeResponse;
    try {
      response = await fetchImpl(`http://${BRIDGE_HOST}:${discovery.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [BRIDGE_TOKEN_HEADER]: discovery.token
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error(
        'AT JumpServer Terminal MCP bridge is not reachable. Reload VS Code with AT JumpServer Terminal running, then retry.'
      );
    }

    const parsed = await parseJsonResponse(response);
    if (!response.ok) {
      const message =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String(parsed.error)
          : `Bridge request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    return parsed as T;
  }
}

async function parseJsonResponse(response: FetchLikeResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(`Bridge request failed with HTTP ${response.status}.`);
    }
    throw new Error('AT JumpServer Terminal MCP bridge returned an invalid JSON response.');
  }
}
