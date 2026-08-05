import type { ToolCatalogEntry } from '@at-series/mcp-hub';

export const AT_JUMPSERVER_PLUGIN_ID = 'at.jumpserver' as const;
export const AT_JUMPSERVER_PLUGIN_DISPLAY_NAME = 'AT JumpServer Terminal' as const;

const terminalIdProperty = {
  terminalId: {
    type: 'string',
    description: 'JumpServer terminal id, or active for the active terminal.'
  }
} as const;

const sftpTargetProperties = {
  connectionKey: {
    type: 'string',
    description: 'JumpServer SFTP connection key.'
  },
  terminalId: {
    type: 'string',
    description: 'JumpServer terminal id.'
  }
} as const;

const sftpPathProperties = {
  ...sftpTargetProperties,
  path: {
    type: 'string',
    description: 'Remote POSIX path.'
  }
} as const;

export const AT_JUMPSERVER_TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'jumpserver_list_assets',
    title: 'JumpServer List Assets',
    description: 'List cached AT JumpServer Terminal assets without exposing credentials.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'jumpserver_get_terminal_context',
    title: 'JumpServer Terminal Context',
    description:
      'Return active, connected, and known AT JumpServer Terminal contexts (SSH, MySQL CLI, and Redis CLI).',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'jumpserver_send_terminal_input',
    title: 'JumpServer Send Terminal Input',
    description:
      'Send raw input to a connected JumpServer terminal (SSH, MySQL CLI, or Redis CLI) after confirmation.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalIdProperty,
        input: {
          type: 'string',
          description: 'Raw terminal input to send.'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'jumpserver_run_terminal_command',
    title: 'JumpServer Run SSH Command',
    description: 'Run a non-interactive command through an existing connected JumpServer SSH terminal.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalIdProperty,
        command: {
          type: 'string',
          description: 'Non-interactive shell command to run.'
        },
        cwd: {
          type: 'string',
          description: 'Optional POSIX working directory.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds.'
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Optional max bytes of output to capture.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'jumpserver_sftp_list_directory',
    title: 'JumpServer SFTP List Directory',
    description: 'List a remote directory through the active JumpServer SFTP session.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: {
          type: 'string',
          description: 'Remote POSIX path.'
        }
      }
    }
  },
  {
    name: 'jumpserver_sftp_stat_path',
    title: 'JumpServer SFTP Stat Path',
    description: 'Return metadata for a remote path through JumpServer SFTP.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { ...sftpPathProperties },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_read_file',
    title: 'JumpServer SFTP Read File',
    description: 'Read bounded UTF-8 text from a remote file through JumpServer SFTP.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpPathProperties,
        maxBytes: {
          type: 'number',
          description: 'Optional max bytes to read.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_write_file',
    title: 'JumpServer SFTP Write File',
    description: 'Write UTF-8 text to a remote file through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpPathProperties,
        content: {
          type: 'string',
          description: 'UTF-8 file content.'
        },
        overwrite: {
          type: 'boolean',
          description: 'Set true to replace an existing file.'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'jumpserver_sftp_create_file',
    title: 'JumpServer SFTP Create File',
    description: 'Create a remote file through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpPathProperties,
        content: {
          type: 'string',
          description: 'Optional UTF-8 file content.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_create_directory',
    title: 'JumpServer SFTP Create Directory',
    description: 'Create a remote directory through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { ...sftpPathProperties },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_sftp_rename',
    title: 'JumpServer SFTP Rename',
    description: 'Rename a remote file or directory through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        oldPath: {
          type: 'string',
          description: 'Existing remote POSIX path.'
        },
        newPath: {
          type: 'string',
          description: 'New remote POSIX path.'
        }
      },
      required: ['oldPath', 'newPath']
    }
  },
  {
    name: 'jumpserver_sftp_delete',
    title: 'JumpServer SFTP Delete',
    description: 'Delete a remote file or directory through JumpServer SFTP after confirmation.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { ...sftpPathProperties },
      required: ['path']
    }
  },
  {
    name: 'jumpserver_mysql_execute_sql',
    title: 'JumpServer MySQL Execute SQL',
    description: 'Execute SQL through an existing connected JumpServer MySQL CLI terminal.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalIdProperty,
        sql: {
          type: 'string',
          description: 'SQL to execute.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds.'
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Optional max bytes of output to capture.'
        }
      },
      required: ['sql']
    }
  },
  {
    name: 'jumpserver_redis_execute_command',
    title: 'JumpServer Redis Execute Command',
    description:
      'Execute one non-blocking Redis command through an existing connected JumpServer Redis CLI terminal. ' +
      'Prefer narrow keys and SCAN over KEYS. Output defaults to 64KB (hard max 256KB). ' +
      'Blocking commands (SUBSCRIBE/MONITOR/BLPOP/…) are rejected; use jumpserver_send_terminal_input for those.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalIdProperty,
        command: {
          type: 'string',
          description: 'Single Redis command, e.g. GET mykey or HGETALL user:1'
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds.'
        },
        maxOutputBytes: {
          type: 'number',
          description: 'Optional max bytes of output to capture (default 64KB, hard max 256KB).'
        }
      },
      required: ['command']
    }
  }
];
