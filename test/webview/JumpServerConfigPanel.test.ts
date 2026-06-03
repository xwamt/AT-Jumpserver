import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  createConfigAssets,
  JumpServerConfigPanel,
  renderJumpServerConfigBody
} from '../../src/webview/JumpServerConfigPanel';

function createPanel() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const panel = {
    webview: {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return { dispose: vi.fn() };
      })
    },
    dispose: vi.fn(),
    onDidDispose: vi.fn()
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    async fireMessage(message: unknown) {
      for (const listener of messageListeners) {
        await listener(message);
      }
    }
  };
}

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('extension-root')
  } as vscode.ExtensionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JumpServerConfigPanel', () => {
  it('renders configuration fields without including stored password', () => {
    const body = renderJumpServerConfigBody({
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    });

    expect(body).toContain('name="baseUrl"');
    expect(body).toContain('value="https://jumpserver.example.com"');
    expect(body).toContain('name="password"');
    expect(body).not.toContain('connectTimeout');
    expect(body).not.toContain('Connect Timeout');
    expect(body).not.toContain('super-secret');
  });

  it('resolves bundled config webview assets', () => {
    const assets = createConfigAssets(vscode.Uri.file('extension-root'));

    expect(assets.script.fsPath).toBe('extension-root/dist/webview/jumpserver-config.js');
    expect(assets.style?.fsPath).toBe('extension-root/dist/webview/jumpserver-config.css');
  });

  it('opens a webview panel for configuration', async () => {
    const panelHost = createPanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(extensionContext(), {
      getSettings: async () => undefined,
      saveSettings: async () => undefined
    });

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverConfig',
      'Configure JumpServer',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true })
    );
    expect(panelHost.panel.webview.html).toContain('name="baseUrl"');
  });

  it('saves configuration from webview messages without requiring target account input', async () => {
    const panelHost = createPanel();
    const saveSettings = vi.fn();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(extensionContext(), {
      getSettings: async () => undefined,
      saveSettings
    });
    await panelHost.fireMessage({
      type: 'save',
      payload: {
        baseUrl: 'https://jumpserver.example.com/',
        orgId: 'org-1',
        username: 'alan',
        password: 'super-secret',
        verifyTls: true
      }
    });

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://jumpserver.example.com/',
        orgId: 'org-1',
        username: 'alan',
        verifyTls: true
      }),
      'super-secret'
    );
    expect(panelHost.panel.dispose).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('JumpServer configuration saved.');
  });

  it('syncs JumpServer assets every time configuration is saved', async () => {
    const panelHost = createPanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(extensionContext(), {
      getSettings: async () => undefined,
      saveSettings: async () => undefined
    });
    await panelHost.fireMessage({
      type: 'save',
      payload: {
        baseUrl: 'https://jumpserver.example.com/',
        orgId: 'org-1',
        username: 'alan',
        password: 'super-secret',
        verifyTls: true
      }
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('jumpserverManager.refresh');
  });
});
