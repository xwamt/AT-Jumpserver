import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('AT JumpServer Terminal manifest', () => {
  it('declares JumpServer terminal, SFTP file commands, and MCP install command', () => {
    expect(manifest.name).toBe('at-jumpserver-terminal');
    expect(manifest.displayName).toBe('%atJumpServer.displayName%');
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('jumpserverManager');
    expect(manifest.contributes.viewsContainers.activitybar[0].icon).toBe('media/at-terminal-activity.svg');

    const commandIds = manifest.contributes.commands.map((command: { command: string }) => command.command);
    expect(commandIds).toEqual([
      'jumpserverManager.configure',
      'jumpserverManager.addBastion',
      'jumpserverManager.removeBastion',
      'jumpserverManager.refreshBastion',
      'jumpserverManager.editBastion',
      'jumpserverManager.validate',
      'jumpserverManager.refresh',
      'jumpserverManager.connect',
      'jumpserverManager.copyHostIp',
      'jumpserverManager.setAssetTrust',
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
      'jumpserverManager.uninstallAtSeriesMcpConfig',
      'jumpserverManager.disconnect',
      'jumpserverManager.reconnect'
    ]);
    expect(manifest.contributes.views.jumpserverManager).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'jumpserverManager.sftpFiles', name: '%atJumpServer.view.sftpFiles.name%' })
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

  it('activates on startup only, with no redundant onView events', () => {
    // Contributed views implicitly activate the extension anyway; the explicit
    // onView events only duplicated onStartupFinished.
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
  });

  it('does not depend on @modelcontextprotocol/sdk directly', () => {
    expect(manifest.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('contributes AT Series MCP install commands without language model tools', () => {
    expect(manifest.contributes.languageModelTools).toBeUndefined();
    expect(JSON.stringify(manifest.activationEvents ?? [])).not.toContain('onLanguageModelTool');
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'jumpserverManager.installMcpConfig',
        title: '%atJumpServer.command.installMcpConfig.title%'
      }),
      expect.objectContaining({
        command: 'jumpserverManager.uninstallAtSeriesMcpConfig',
        title: '%atJumpServer.command.uninstallAtSeriesMcpConfig.title%'
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

  it('shows the connect menu for SSH, MySQL, Redis, and unsupported JumpServer assets', () => {
    const connectMenu = manifest.contributes.menus['view/item/context'].find(
      (item: { command: string }) => item.command === 'jumpserverManager.connect'
    );

    expect(connectMenu.when).toContain('view == jumpserverManager.assets');
    expect(connectMenu.when).toContain('jumpserverAsset');
    expect(connectMenu.when).toContain('jumpserverMysqlAsset');
    expect(connectMenu.when).toContain('jumpserverRedisAsset');
    expect(connectMenu.when).toContain('jumpserverUnsupportedAsset');
  });

  it('shows Copy Host IP for SSH, MySQL, Redis, and unsupported JumpServer assets', () => {
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'jumpserverManager.copyHostIp',
        title: '%atJumpServer.command.copyHostIp.title%',
        icon: '$(copy)'
      })
    ]));

    const copyHostIpMenu = manifest.contributes.menus['view/item/context'].find(
      (item: { command: string }) => item.command === 'jumpserverManager.copyHostIp'
    );

    expect(copyHostIpMenu).toMatchObject({ group: '3_copy@1' });
    expect(copyHostIpMenu.when).toContain('view == jumpserverManager.assets');
    expect(copyHostIpMenu.when).toContain('jumpserverAsset');
    expect(copyHostIpMenu.when).toContain('jumpserverMysqlAsset');
    expect(copyHostIpMenu.when).toContain('jumpserverRedisAsset');
    expect(copyHostIpMenu.when).toContain('jumpserverUnsupportedAsset');
  });

  it('does not show a standalone Open Files action on assets', () => {
    const assetMenus = manifest.contributes.menus['view/item/context'].filter(
      (item: { when: string }) =>
        item.when.includes('view == jumpserverManager.assets') && !item.when.includes('jumpserverBastion')
    );

    expect(assetMenus.map((item: { command: string }) => item.command)).toEqual([
      'jumpserverManager.connect',
      'jumpserverManager.copyHostIp',
      'jumpserverManager.setAssetTrust'
    ]);
    expect(JSON.stringify(manifest)).not.toContain('jumpserverManager.sftp.open');
  });

  it('offers Set Asset Trust on connectable assets only, hidden from the palette', () => {
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'jumpserverManager.setAssetTrust',
        title: '%atJumpServer.command.setAssetTrust.title%'
      })
    ]));

    const menu = manifest.contributes.menus['view/item/context'].find(
      (item: { command: string }) => item.command === 'jumpserverManager.setAssetTrust'
    );
    expect(menu).toMatchObject({ group: '2_manage@1' });
    expect(menu.when).toContain('view == jumpserverManager.assets');
    expect(menu.when).toContain('viewItem == jumpserverAsset');
    expect(menu.when).toContain('viewItem == jumpserverMysqlAsset');
    expect(menu.when).toContain('viewItem == jumpserverRedisAsset');
    // An unsupported asset has no MCP execution surface; trust would be noise.
    expect(menu.when).not.toContain('jumpserverUnsupportedAsset');

    const palette = manifest.contributes.menus.commandPalette.find(
      (item: { command: string }) => item.command === 'jumpserverManager.setAssetTrust'
    );
    expect(palette).toEqual({ command: 'jumpserverManager.setAssetTrust', when: 'false' });
  });

  it('titles Set Asset Trust in both nls languages', () => {
    const english = JSON.parse(readFileSync(join(__dirname, '..', 'package.nls.json'), 'utf8'));
    const chinese = JSON.parse(readFileSync(join(__dirname, '..', 'package.nls.zh-cn.json'), 'utf8'));
    expect(english['atJumpServer.command.setAssetTrust.title']).toBe('JumpServer: Set Asset Trust Level');
    expect(chinese['atJumpServer.command.setAssetTrust.title']).toBe('JumpServer: 设置资产信任级别');
  });

  it('shows bastion actions when the tree item is a JumpServer bastion', () => {
    const bastionMenus = manifest.contributes.menus['view/item/context'].filter(
      (item: { when: string }) => item.when.includes('viewItem == jumpserverBastion')
    );

    expect(bastionMenus.map((item: { command: string }) => item.command)).toEqual([
      'jumpserverManager.refreshBastion',
      'jumpserverManager.editBastion',
      'jumpserverManager.removeBastion'
    ]);
    expect(bastionMenus.every((item: { when: string }) => item.when.includes('view == jumpserverManager.assets'))).toBe(true);
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
