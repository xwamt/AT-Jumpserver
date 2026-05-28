import { describe, expect, it, vi } from 'vitest';
import { TerminalContextRegistry, type ActiveTerminalContext } from '../../src/terminal/TerminalContext';

function context(terminalId: string, assetId: string, connected = false): ActiveTerminalContext {
  return {
    terminalId,
    asset: {
      id: assetId,
      name: assetId,
      address: '',
      platform: 'Linux',
      category: 'host',
      type: 'server',
      zoneName: '',
      nodePath: [],
      protocolNames: ['ssh'],
      raw: {}
    },
    connected,
    write: vi.fn()
  };
}

describe('TerminalContextRegistry', () => {
  it('keeps contexts for multiple terminals and emits active changes when switching back', () => {
    const registry = new TerminalContextRegistry();
    const activeChanges: Array<ActiveTerminalContext | undefined> = [];
    registry.onDidChangeActiveContext((next) => activeChanges.push(next));

    registry.setActive(context('terminal-1', 'asset-1', true));
    registry.setActive(context('terminal-2', 'asset-2', true));
    registry.setActive(context('terminal-1', 'asset-1', true));

    expect(registry.getActive()?.terminalId).toBe('terminal-1');
    expect(registry.getContext('terminal-2')?.asset.id).toBe('asset-2');
    expect(activeChanges.map((next) => next?.terminalId)).toEqual(['terminal-1', 'terminal-2', 'terminal-1']);
  });

  it('emits changed and removed context events without losing other terminals', () => {
    const registry = new TerminalContextRegistry();
    const changed: ActiveTerminalContext[] = [];
    const removed: string[] = [];
    registry.onDidChangeContext((next) => changed.push(next));
    registry.onDidRemoveContext((terminalId) => removed.push(terminalId));

    registry.setActive(context('terminal-1', 'asset-1', false));
    registry.setActive(context('terminal-2', 'asset-2', true));
    registry.markConnected('terminal-1');
    registry.clearIfActive('terminal-2');

    expect(changed.map((next) => `${next.terminalId}:${next.connected}`)).toEqual([
      'terminal-1:false',
      'terminal-2:true',
      'terminal-1:true'
    ]);
    expect(removed).toEqual(['terminal-2']);
    expect(registry.getContext('terminal-1')?.connected).toBe(true);
  });
});
