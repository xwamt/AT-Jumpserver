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
    description:
      'JumpServer SFTP connection key selecting which connected asset to act on. Omit to use the active connection, whichever asset that currently is.'
  },
  terminalId: {
    type: 'string',
    description: 'JumpServer terminal id. Used as the connection key when connectionKey is omitted.'
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
    description:
      'List cached AT JumpServer Terminal assets without exposing credentials. Each result includes bastionId and bastionName so agents can disambiguate duplicate asset names across bastions. Supports an optional bastionId filter, search (matches asset fields plus bastion name/id), and limit/offset pagination (default limit 200, hard max 500). When truncated is true, page with offset instead of dumping the full cache.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description:
            'Optional case-insensitive filter matched against asset id, name, address, node path, bastion id, and bastion name.'
        },
        bastionId: {
          type: 'string',
          description: 'Optional JumpServer bastion id. When set, only assets from that bastion are returned.'
        },
        limit: {
          type: 'number',
          description: 'Optional page size (default 200, hard max 500).'
        },
        offset: {
          type: 'number',
          description: 'Optional zero-based offset into the filtered asset list.'
        }
      }
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
    description:
      'Run a non-interactive command through an existing connected JumpServer SSH terminal. Output defaults to 64KB (hard max 256KB). When truncated is true, narrow the command (grep/head/tail) instead of only raising maxOutputBytes.',
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
          description: 'Optional max bytes of output to capture (default 64KB, hard max 256KB).'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'jumpserver_sftp_list_directory',
    title: 'JumpServer SFTP List Directory',
    description:
      'List a remote directory through the JumpServer SFTP session named by connectionKey, or the active session when it is omitted. Returns at most maxEntries entries (default 500). When truncated is true, narrow the path or raise maxEntries deliberately.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpTargetProperties,
        path: {
          type: 'string',
          description: 'Remote POSIX path.'
        },
        maxEntries: {
          type: 'number',
          description: 'Optional max directory entries to return (default 500, hard max 5000).'
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
    description:
      'Read bounded UTF-8 text from a remote file through JumpServer SFTP. Reads at most maxBytes (default 64KB, hard max 256KB) without buffering the whole file; oversized text returns truncated content with truncated=true. Rejects binary-looking content.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...sftpPathProperties,
        maxBytes: {
          type: 'number',
          description: 'Optional max bytes to read (default 64KB, hard max 256KB).'
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
    description:
      'Create a remote directory on the JumpServer SFTP session named by connectionKey, or the active session when it is omitted, after confirmation. The confirmation names the target asset and address.',
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
    description:
      'Rename a remote file or directory on the JumpServer SFTP session named by connectionKey, or the active session when it is omitted, after confirmation. The confirmation names the target asset and address.',
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
    description:
      'Delete a remote file or directory on the JumpServer SFTP session named by connectionKey, or the active session when it is omitted, after confirmation. The confirmation names the target asset and address.',
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
    description:
      'Execute SQL through an existing connected JumpServer MySQL CLI terminal. Always include LIMIT on SELECT-style queries. Output defaults to 64KB (hard max 256KB). When truncated is true, tighten LIMIT/WHERE instead of only raising maxOutputBytes.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        ...terminalIdProperty,
        sql: {
          type: 'string',
          description: 'SQL to execute. Prefer SELECT ... LIMIT N for large tables.'
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
