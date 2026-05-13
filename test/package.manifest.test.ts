import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('AT JumpServer Terminal manifest', () => {
  it('declares a standalone JumpServer terminal extension without SSH/SFTP/MCP commands', () => {
    expect(manifest.name).toBe('at-jumpserver-terminal');
    expect(manifest.displayName).toBe('AT JumpServer Terminal');
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('jumpserverManager');

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
  });
});
