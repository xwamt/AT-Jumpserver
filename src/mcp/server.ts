#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeClient } from './BridgeClient';

const bridge = new BridgeClient();
const server = new McpServer({
  name: 'at-jumpserver-terminal',
  version: '0.1.1'
});

const terminalTargetSchema = {
  terminalId: z.string().optional().describe('JumpServer terminal id, or active for the active terminal.')
};

const sftpTargetSchema = {
  connectionKey: z.string().optional().describe('JumpServer SFTP connection key.'),
  terminalId: z.string().optional().describe('JumpServer terminal id.')
};

const sftpPathSchema = {
  ...sftpTargetSchema,
  path: z.string().min(1).describe('Remote POSIX path.')
};

server.registerTool(
  'jumpserver_list_assets',
  {
    title: 'JumpServer List Assets',
    description: 'List cached AT JumpServer Terminal assets without exposing credentials.',
    inputSchema: {}
  },
  async () => textResult(await bridge.listAssets())
);

server.registerTool(
  'jumpserver_get_terminal_context',
  {
    title: 'JumpServer Terminal Context',
    description: 'Return active, connected, and known AT JumpServer Terminal contexts.',
    inputSchema: {}
  },
  async () => textResult(await bridge.getTerminalContext())
);

server.registerTool(
  'jumpserver_send_terminal_input',
  {
    title: 'JumpServer Send Terminal Input',
    description: 'Send raw input to a connected JumpServer terminal.',
    inputSchema: {
      ...terminalTargetSchema,
      input: z.string().describe('Raw terminal input to send.')
    }
  },
  async (input) => textResult(await bridge.sendTerminalInput(input))
);

server.registerTool(
  'jumpserver_run_terminal_command',
  {
    title: 'JumpServer Run SSH Command',
    description: 'Run a non-interactive command through an existing connected JumpServer SSH terminal.',
    inputSchema: {
      ...terminalTargetSchema,
      command: z.string().min(1).describe('Non-interactive shell command to run.'),
      cwd: z.string().optional().describe('Optional POSIX working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Optional timeout in milliseconds.'),
      maxOutputBytes: z.number().int().positive().optional().describe('Optional max bytes of output to capture.')
    }
  },
  async (input) => textResult(await bridge.runTerminalCommand(input))
);

server.registerTool(
  'jumpserver_sftp_list_directory',
  {
    title: 'JumpServer SFTP List Directory',
    description: 'List a remote directory through the active JumpServer SFTP session.',
    inputSchema: {
      ...sftpTargetSchema,
      path: z.string().optional().describe('Remote POSIX path.')
    }
  },
  async (input) => textResult(await bridge.sftpListDirectory(input))
);

server.registerTool(
  'jumpserver_sftp_stat_path',
  {
    title: 'JumpServer SFTP Stat Path',
    description: 'Return metadata for a remote path through JumpServer SFTP.',
    inputSchema: sftpPathSchema
  },
  async (input) => textResult(await bridge.sftpStatPath(input))
);

server.registerTool(
  'jumpserver_sftp_read_file',
  {
    title: 'JumpServer SFTP Read File',
    description: 'Read bounded UTF-8 text from a remote file through JumpServer SFTP.',
    inputSchema: {
      ...sftpPathSchema,
      maxBytes: z.number().int().positive().optional().describe('Optional max bytes to read.')
    }
  },
  async (input) => textResult(await bridge.sftpReadFile(input))
);

server.registerTool(
  'jumpserver_sftp_write_file',
  {
    title: 'JumpServer SFTP Write File',
    description: 'Write UTF-8 text to a remote file through JumpServer SFTP after confirmation.',
    inputSchema: {
      ...sftpPathSchema,
      content: z.string().describe('UTF-8 file content.'),
      overwrite: z.boolean().optional().describe('Set true to replace an existing file.')
    }
  },
  async (input) => textResult(await bridge.sftpWriteFile(input))
);

server.registerTool(
  'jumpserver_sftp_create_file',
  {
    title: 'JumpServer SFTP Create File',
    description: 'Create a remote file through JumpServer SFTP after confirmation.',
    inputSchema: {
      ...sftpPathSchema,
      content: z.string().optional().describe('Optional UTF-8 file content.')
    }
  },
  async (input) => textResult(await bridge.sftpCreateFile(input))
);

server.registerTool(
  'jumpserver_sftp_create_directory',
  {
    title: 'JumpServer SFTP Create Directory',
    description: 'Create a remote directory through JumpServer SFTP after confirmation.',
    inputSchema: sftpPathSchema
  },
  async (input) => textResult(await bridge.sftpCreateDirectory(input))
);

server.registerTool(
  'jumpserver_sftp_rename',
  {
    title: 'JumpServer SFTP Rename',
    description: 'Rename a remote file or directory through JumpServer SFTP after confirmation.',
    inputSchema: {
      ...sftpTargetSchema,
      oldPath: z.string().min(1).describe('Existing remote POSIX path.'),
      newPath: z.string().min(1).describe('New remote POSIX path.')
    }
  },
  async (input) => textResult(await bridge.sftpRename(input))
);

server.registerTool(
  'jumpserver_sftp_delete',
  {
    title: 'JumpServer SFTP Delete',
    description: 'Delete a remote file or directory through JumpServer SFTP after confirmation.',
    inputSchema: sftpPathSchema
  },
  async (input) => textResult(await bridge.sftpDelete(input))
);

server.registerTool(
  'jumpserver_mysql_get_context',
  {
    title: 'JumpServer MySQL Context',
    description: 'Return active, connected, and known JumpServer MySQL terminal contexts.',
    inputSchema: {}
  },
  async () => textResult(await bridge.mysqlGetContext())
);

server.registerTool(
  'jumpserver_mysql_send_input',
  {
    title: 'JumpServer MySQL Send Input',
    description: 'Send raw input to a connected JumpServer MySQL CLI terminal.',
    inputSchema: {
      ...terminalTargetSchema,
      input: z.string().describe('Raw MySQL CLI input to send.')
    }
  },
  async (input) => textResult(await bridge.mysqlSendInput(input))
);

server.registerTool(
  'jumpserver_mysql_execute_sql',
  {
    title: 'JumpServer MySQL Execute SQL',
    description: 'Execute SQL through an existing connected JumpServer MySQL CLI terminal.',
    inputSchema: {
      ...terminalTargetSchema,
      sql: z.string().min(1).describe('SQL to execute.'),
      timeoutMs: z.number().int().positive().optional().describe('Optional timeout in milliseconds.'),
      maxOutputBytes: z.number().int().positive().optional().describe('Optional max bytes of output to capture.')
    }
  },
  async (input) => textResult(await bridge.mysqlExecuteSql(input))
);

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
