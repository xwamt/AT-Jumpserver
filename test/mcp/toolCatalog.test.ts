import { describe, it, expect } from 'vitest';
import { JUMPSERVER_MCP_TOOL_NAMES } from '../../src/mcp/BridgeProtocol';
import { AT_JUMPSERVER_PLUGIN_ID, AT_JUMPSERVER_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

describe('toolCatalog', () => {
  it('uses stable pluginId', () => {
    expect(AT_JUMPSERVER_PLUGIN_ID).toBe('at.jumpserver');
  });

  it('declares risk for all fourteen tools', () => {
    expect(AT_JUMPSERVER_TOOL_CATALOG).toHaveLength(14);
    expect(JUMPSERVER_MCP_TOOL_NAMES).toHaveLength(14);
    expect([...JUMPSERVER_MCP_TOOL_NAMES].sort()).toEqual(
      AT_JUMPSERVER_TOOL_CATALOG.map((t) => t.name).sort()
    );

    const byName = Object.fromEntries(AT_JUMPSERVER_TOOL_CATALOG.map((t) => [t.name, t.risk]));
    expect(byName.jumpserver_list_assets).toBe('read');
    expect(byName.jumpserver_get_terminal_context).toBe('read');
    expect(byName.jumpserver_sftp_list_directory).toBe('read');
    expect(byName.jumpserver_sftp_stat_path).toBe('read');
    expect(byName.jumpserver_sftp_read_file).toBe('read');
    expect(byName.jumpserver_sftp_write_file).toBe('write');
    expect(byName.jumpserver_sftp_create_file).toBe('write');
    expect(byName.jumpserver_sftp_create_directory).toBe('write');
    expect(byName.jumpserver_sftp_rename).toBe('write');
    expect(byName.jumpserver_sftp_delete).toBe('write');
    expect(byName.jumpserver_send_terminal_input).toBe('exec');
    expect(byName.jumpserver_run_terminal_command).toBe('exec');
    expect(byName.jumpserver_mysql_execute_sql).toBe('exec');
    expect(byName.jumpserver_redis_execute_command).toBe('exec');

    expect(byName.jumpserver_mysql_get_context).toBeUndefined();
    expect(byName.jumpserver_mysql_send_input).toBeUndefined();
  });

  it('documents list_assets bastion fields and optional filter', () => {
    const list = AT_JUMPSERVER_TOOL_CATALOG.find((t) => t.name === 'jumpserver_list_assets');
    expect(list?.description).toMatch(/bastionId/);
    expect(list?.description).toMatch(/bastionName/);
    expect(list?.description).toMatch(/disambiguate/i);
    expect(list?.description).toMatch(/bastion name/i);
    expect(list?.inputSchema.properties).toEqual(
      expect.objectContaining({
        bastionId: expect.objectContaining({ type: 'string' })
      })
    );
  });

  it('documents that send_terminal_input always confirms', () => {
    const entry = AT_JUMPSERVER_TOOL_CATALOG.find((tool) => tool.name === 'jumpserver_send_terminal_input');
    expect(entry?.description).toMatch(/regardless of the asset trust level/);
  });

  it('documents the full-trust skip on sftp write tools, but not delete', () => {
    for (const name of [
      'jumpserver_sftp_write_file',
      'jumpserver_sftp_create_file',
      'jumpserver_sftp_create_directory',
      'jumpserver_sftp_rename'
    ]) {
      const entry = AT_JUMPSERVER_TOOL_CATALOG.find((tool) => tool.name === name);
      expect(entry?.description, name).toMatch(/unless the asset is set to full trust/);
    }
    const del = AT_JUMPSERVER_TOOL_CATALOG.find((tool) => tool.name === 'jumpserver_sftp_delete');
    expect(del?.description).toMatch(/even on a fully trusted asset/);
  });

  it('documents Redis execute limits and interactive fallback', () => {
    const redis = AT_JUMPSERVER_TOOL_CATALOG.find((t) => t.name === 'jumpserver_redis_execute_command');
    expect(redis?.description).toMatch(/non-blocking/i);
    expect(redis?.description).toMatch(/64KB/i);
    expect(redis?.description).toMatch(/jumpserver_send_terminal_input/);
  });
});
