import { describe, it, expect } from 'vitest';
import { AT_JUMPSERVER_PLUGIN_ID, AT_JUMPSERVER_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

describe('toolCatalog', () => {
  it('uses stable pluginId', () => {
    expect(AT_JUMPSERVER_PLUGIN_ID).toBe('at.jumpserver');
  });

  it('declares risk for all fifteen tools', () => {
    expect(AT_JUMPSERVER_TOOL_CATALOG).toHaveLength(15);
    const byName = Object.fromEntries(AT_JUMPSERVER_TOOL_CATALOG.map((t) => [t.name, t.risk]));
    expect(byName.jumpserver_list_assets).toBe('read');
    expect(byName.jumpserver_get_terminal_context).toBe('read');
    expect(byName.jumpserver_sftp_list_directory).toBe('read');
    expect(byName.jumpserver_sftp_stat_path).toBe('read');
    expect(byName.jumpserver_sftp_read_file).toBe('read');
    expect(byName.jumpserver_mysql_get_context).toBe('read');
    expect(byName.jumpserver_sftp_write_file).toBe('write');
    expect(byName.jumpserver_sftp_create_file).toBe('write');
    expect(byName.jumpserver_sftp_create_directory).toBe('write');
    expect(byName.jumpserver_sftp_rename).toBe('write');
    expect(byName.jumpserver_sftp_delete).toBe('write');
    expect(byName.jumpserver_send_terminal_input).toBe('exec');
    expect(byName.jumpserver_run_terminal_command).toBe('exec');
    expect(byName.jumpserver_mysql_send_input).toBe('exec');
    expect(byName.jumpserver_mysql_execute_sql).toBe('exec');
  });
});
