import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AT_SERIES_HOST_APP_ENV,
  MCP_SERVER_DISPLAY_NAME,
  hubJsPath
} from '@at-series/mcp-hub';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from '../../src/mcp/McpConfigInstaller';
import { AT_JUMPSERVER_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

describe('McpConfigInstaller', () => {
  let home: string;
  let hubJs: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'at-jumpserver-mcp-installer-'));
    hubJs = hubJsPath(home);
    await mkdir(join(home, '.at-series', 'mcp'), { recursive: true });
    await writeFile(hubJs, 'module.exports = {};\n', 'utf8');
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(home, { recursive: true, force: true });
  });

  it('ensure writes AT Series, migrates AT JumpServer Terminal away, keeps other-server', async () => {
    const mcpPath = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            'AT JumpServer Terminal': {
              command: 'node',
              args: ['C:/old/at-jumpserver/dist/mcp-server.js'],
              autoApprove: ['jumpserver_list_assets']
            },
            'other-server': { command: 'uvx', args: ['mcp-server-fetch'] }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await ensureAtSeriesConfigForCurrentIde({
      appName: 'Cursor',
      uriScheme: 'cursor',
      extensionPath: join(home, '.cursor', 'extensions', 'local.at-jumpserver-terminal-0.1.3'),
      home
    });

    expect(result).toEqual({ updated: true });

    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers['AT JumpServer Terminal']).toBeUndefined();
    expect(parsed.mcpServers['other-server']).toEqual({
      command: 'uvx',
      args: ['mcp-server-fetch']
    });
    expect(parsed.mcpServers[MCP_SERVER_DISPLAY_NAME]).toMatchObject({
      command: 'node',
      args: [hubJs.replaceAll('\\', '/')],
      env: { [AT_SERIES_HOST_APP_ENV]: 'cursor' }
    });
  });

  it('autoApprove excludes write/exec tools', async () => {
    const mcpPath = join(home, '.cursor', 'mcp.json');

    await ensureAtSeriesConfigForCurrentIde({
      appName: 'Cursor',
      uriScheme: 'cursor',
      extensionPath: join(home, '.cursor', 'extensions', 'local.at-jumpserver-terminal-0.1.3'),
      home
    });

    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, { autoApprove?: string[] }>;
    };
    const autoApprove = parsed.mcpServers[MCP_SERVER_DISPLAY_NAME]?.autoApprove ?? [];
    expect(autoApprove).toContain('at_list_providers');
    expect(autoApprove).toContain('jumpserver_list_assets');
    expect(autoApprove).toContain('jumpserver_sftp_read_file');
    expect(autoApprove).not.toContain('jumpserver_send_terminal_input');
    expect(autoApprove).not.toContain('jumpserver_run_terminal_command');
    expect(autoApprove).not.toContain('jumpserver_mysql_send_input');
    expect(autoApprove).not.toContain('jumpserver_mysql_execute_sql');
    expect(autoApprove).not.toContain('jumpserver_sftp_write_file');
    expect(autoApprove).not.toContain('jumpserver_sftp_create_file');
    expect(autoApprove).not.toContain('jumpserver_sftp_create_directory');
    expect(autoApprove).not.toContain('jumpserver_sftp_rename');
    expect(autoApprove).not.toContain('jumpserver_sftp_delete');
    for (const tool of AT_JUMPSERVER_TOOL_CATALOG.filter((entry) => entry.risk === 'exec' || entry.risk === 'write')) {
      expect(autoApprove).not.toContain(tool.name);
    }
  });

  it('uninstall removes AT Series only', async () => {
    const mcpPath = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_DISPLAY_NAME]: {
              command: 'node',
              args: [hubJs.replaceAll('\\', '/')],
              env: { [AT_SERIES_HOST_APP_ENV]: 'cursor' },
              autoApprove: ['at_list_providers']
            },
            'other-server': { command: 'uvx', args: ['mcp-server-fetch'] }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await uninstallAtSeriesConfigForCurrentIde({
      appName: 'Cursor',
      uriScheme: 'cursor',
      extensionPath: join(home, '.cursor', 'extensions', 'local.at-jumpserver-terminal-0.1.3'),
      home
    });

    expect(result).toEqual({ removed: true });

    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers[MCP_SERVER_DISPLAY_NAME]).toBeUndefined();
    expect(parsed.mcpServers['other-server']).toBeDefined();
  });
});
