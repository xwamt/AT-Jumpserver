import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('AT JumpServer Terminal manifest', () => {
  it('declares JumpServer terminal, SFTP file commands, and MCP install command', () => {
    expect(manifest.name).toBe('at-jumpserver-terminal');
    expect(manifest.displayName).toBe('AT JumpServer Terminal');
    expect(manifest.version).toBe('0.1.2');
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('jumpserverManager');
    expect(manifest.contributes.viewsContainers.activitybar[0].icon).toBe('media/at-terminal-activity.svg');

    const commandIds = manifest.contributes.commands.map((command: { command: string }) => command.command);
    expect(commandIds).toEqual([
      'jumpserverManager.configure',
      'jumpserverManager.validate',
      'jumpserverManager.refresh',
      'jumpserverManager.connect',
      'jumpserverManager.sftp.refresh',
      'jumpserverManager.sftp.goUp',
      'jumpserverManager.sftp.upload',
      'jumpserverManager.sftp.download',
      'jumpserverManager.sftp.preview',
      'jumpserverManager.sftp.edit',
      'jumpserverManager.sftp.delete',
      'jumpserverManager.sftp.rename',
      'jumpserverManager.sftp.newFolder',
      'jumpserverManager.sftp.copyPath',
      'jumpserverManager.installMcpConfig',
      'jumpserverManager.disconnect',
      'jumpserverManager.reconnect'
    ]);
    expect(manifest.contributes.views.jumpserverManager).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'jumpserverManager.sftpFiles', name: 'Files' })
    ]));
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'jumpserverManager.sftp.upload' }),
      expect.objectContaining({ command: 'jumpserverManager.sftp.download' }),
      expect.objectContaining({ command: 'jumpserverManager.sftp.preview' }),
      expect.objectContaining({ command: 'jumpserverManager.sftp.edit' })
    ]));
    expect(manifest.contributes.commands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'jumpserverManager.sftp.open' })
    ]));
    const fileMenus = manifest.contributes.menus['view/item/context'].filter((item: { command: string }) =>
      item.command === 'jumpserverManager.sftp.preview' || item.command === 'jumpserverManager.sftp.edit'
    );
    expect(fileMenus).toHaveLength(2);
    expect(fileMenus.every((item: { when: string }) => item.when.includes('viewItem == jumpserverSftpFile'))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('run_remote_command');
    expect(JSON.stringify(manifest)).not.toContain('sshManager');
    expect(JSON.stringify(manifest)).not.toContain('jumpserverManager.sftp.goToPath');
    expect(JSON.stringify(manifest)).not.toContain('media/terminal-activity.svg');
  });

  it('contributes JumpServer MCP tools and install command', () => {
    const tools = manifest.contributes.languageModelTools ?? [];
    const toolNames = tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
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
      'jumpserver_mysql_get_context',
      'jumpserver_mysql_send_input',
      'jumpserver_mysql_execute_sql'
    ]));
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'jumpserverManager.installMcpConfig',
        title: 'JumpServer: Install MCP Config'
      })
    ]));
  });

  it('uses icon-only actions in the JumpServer view title', () => {
    const commandsById = new Map(manifest.contributes.commands.map((command: { command: string; icon?: unknown; title: string }) => [command.command, command]));
    expect(commandsById.get('jumpserverManager.configure')).toMatchObject({
      icon: '$(gear)'
    });
    expect(commandsById.get('jumpserverManager.refresh')).toMatchObject({
      icon: '$(refresh)'
    });
    expect(commandsById.get('jumpserverManager.sftp.upload')).toMatchObject({
      icon: '$(cloud-upload)'
    });
    expect(commandsById.get('jumpserverManager.sftp.download')).toMatchObject({
      icon: '$(cloud-download)'
    });
  });

  it('shows the connect menu for SSH, MySQL, and unsupported JumpServer assets', () => {
    const connectMenu = manifest.contributes.menus['view/item/context'].find(
      (item: { command: string }) => item.command === 'jumpserverManager.connect'
    );

    expect(connectMenu.when).toContain('view == jumpserverManager.assets');
    expect(connectMenu.when).toContain('jumpserverAsset');
    expect(connectMenu.when).toContain('jumpserverMysqlAsset');
    expect(connectMenu.when).toContain('jumpserverUnsupportedAsset');
  });

  it('does not show a standalone Open Files action on assets', () => {
    const assetMenus = manifest.contributes.menus['view/item/context'].filter(
      (item: { when: string }) => item.when.includes('view == jumpserverManager.assets')
    );

    expect(assetMenus).toHaveLength(1);
    expect(assetMenus[0].command).toBe('jumpserverManager.connect');
    expect(JSON.stringify(manifest)).not.toContain('jumpserverManager.sftp.open');
  });

  it('keeps SFTP file open actions out of inline tree buttons', () => {
    const fileActionMenus = manifest.contributes.menus['view/item/context'].filter((item: { command: string }) =>
      [
        'jumpserverManager.sftp.download',
        'jumpserverManager.sftp.preview',
        'jumpserverManager.sftp.edit'
      ].includes(item.command)
    );

    expect(fileActionMenus).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'jumpserverManager.sftp.download', group: 'transfer@2' }),
      expect.objectContaining({ command: 'jumpserverManager.sftp.edit', group: 'open@1' }),
      expect.objectContaining({ command: 'jumpserverManager.sftp.preview', group: 'open@2' })
    ]));
    expect(fileActionMenus.every((item: { group: string }) => !item.group.startsWith('inline'))).toBe(true);
  });
});
