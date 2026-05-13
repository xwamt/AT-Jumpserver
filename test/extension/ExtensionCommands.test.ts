import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';

beforeEach(() => {
  deactivate();
  vi.clearAllMocks();
});

describe('extension command wiring', () => {
  it('registers JumpServer-only commands and asset tree view', () => {
    const context = {
      globalState: { get: vi.fn((_key, fallback) => fallback), update: vi.fn() },
      secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
      subscriptions: [],
      extensionUri: vscode.Uri.file('extension-root')
    } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(vscode.window.createTreeView).toHaveBeenCalledWith('jumpserverManager.assets', expect.any(Object));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.configure', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.validate', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.connect', expect.any(Function));
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('sshManager.connect', expect.any(Function));
  });
});
