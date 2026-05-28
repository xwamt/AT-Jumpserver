import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('AT JumpServer Terminal manifest', () => {
  it('declares a standalone JumpServer terminal extension without SSH/SFTP/MCP commands', () => {
    expect(manifest.name).toBe('at-jumpserver-terminal');
    expect(manifest.displayName).toBe('AT JumpServer Terminal');
    expect(manifest.version).toBe('0.1.1');
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('jumpserverManager');
    expect(manifest.contributes.viewsContainers.activitybar[0].icon).toBe('media/at-terminal-activity.svg');

    const commandIds = manifest.contributes.commands.map((command: { command: string }) => command.command);
    expect(commandIds).toEqual([
      'jumpserverManager.configure',
      'jumpserverManager.validate',
      'jumpserverManager.refresh',
      'jumpserverManager.connect',
      'jumpserverManager.disconnect',
      'jumpserverManager.reconnect'
    ]);
    expect(JSON.stringify(manifest)).not.toContain('sftp');
    expect(JSON.stringify(manifest)).not.toContain('run_remote_command');
    expect(JSON.stringify(manifest)).not.toContain('sshManager');
    expect(JSON.stringify(manifest)).not.toContain('media/terminal-activity.svg');
  });

  it('uses icon-only actions in the JumpServer view title', () => {
    const commandsById = new Map(manifest.contributes.commands.map((command: { command: string; icon?: unknown; title: string }) => [command.command, command]));
    expect(commandsById.get('jumpserverManager.configure')).toMatchObject({
      icon: '$(gear)'
    });
    expect(commandsById.get('jumpserverManager.refresh')).toMatchObject({
      icon: '$(refresh)'
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
});
