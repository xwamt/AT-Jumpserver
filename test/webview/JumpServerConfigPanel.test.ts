import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parseJumpServerBastion } from '../../src/config/schema';
import {
  createConfigAssets,
  JumpServerConfigPanel,
  renderJumpServerConfigBody
} from '../../src/webview/JumpServerConfigPanel';

const FIXED_BASTION_ID = '11111111-1111-1111-1111-111111111111';

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

function idFactory() {
  return FIXED_BASTION_ID;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JumpServerConfigPanel', () => {
  it('renders configuration fields without including stored password', () => {
    const body = renderJumpServerConfigBody({
      id: FIXED_BASTION_ID,
      name: 'prod',
      baseUrl: 'https://jumpserver.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    });

    expect(body).toContain('name="displayName"');
    expect(body).toContain('value="prod"');
    expect(body).toContain('name="baseUrl"');
    expect(body).toContain('value="https://jumpserver.example.com"');
    expect(body).toContain('name="password"');
    expect(body).not.toContain('connectTimeout');
    expect(body).not.toContain('Connect Timeout');
    expect(body).not.toContain('super-secret');
  });

  it('omits hidden bastionId when adding and includes it when editing', () => {
    expect(renderJumpServerConfigBody()).not.toContain('name="bastionId"');
    expect(renderJumpServerConfigBody()).toContain('name="displayName"');

    const body = renderJumpServerConfigBody({
      id: FIXED_BASTION_ID,
      name: '生产',
      baseUrl: 'https://jms.prod.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: false,
      updatedAt: 1
    });
    expect(body).toContain('name="bastionId"');
    expect(body).toContain(`value="${FIXED_BASTION_ID}"`);
    expect(body).toContain('value="生产"');
    expect(body).toContain('value="https://jms.prod.example.com"');
    expect(body).toContain('value="alan"');
    expect(body).toContain('value="org-1"');
    expect(body).not.toContain('name="verifyTls" type="checkbox" checked');
  });

  it('resolves bundled config webview assets', () => {
    const assets = createConfigAssets(vscode.Uri.file('extension-root'));

    expect(assets.script.fsPath).toBe('extension-root/dist/webview/jumpserver-config.js');
    expect(assets.style?.fsPath).toBe('extension-root/dist/webview/jumpserver-config.css');
  });

  it('opens a webview panel for configuration', async () => {
    const panelHost = createPanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(
      extensionContext(),
      {
        getBastion: async () => undefined,
        saveBastion: async () => undefined
      },
      { mode: 'add' },
      idFactory
    );

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverConfig',
      'Configure JumpServer',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true })
    );
    expect(panelHost.panel.webview.html).toContain('name="baseUrl"');
    expect(panelHost.panel.webview.html).toContain('name="displayName"');
  });

  it('saves a new bastion with a generated id and hostname display name', async () => {
    const panelHost = createPanel();
    const saveBastion = vi.fn();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(
      extensionContext(),
      { getBastion: async () => undefined, saveBastion },
      { mode: 'add' },
      idFactory
    );
    await panelHost.fireMessage({
      type: 'save',
      payload: {
        displayName: '',
        bastionId: '',
        baseUrl: 'https://jms.prod.example.com/',
        orgId: '',
        username: 'alan',
        password: 'secret',
        verifyTls: true
      }
    });

    expect(saveBastion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: FIXED_BASTION_ID,
        name: 'jms.prod.example.com',
        baseUrl: 'https://jms.prod.example.com/',
        username: 'alan'
      }),
      'secret'
    );
    expect(panelHost.panel.dispose).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('JumpServer configuration saved.');
  });

  it('prefills an existing bastion and saves under that id', async () => {
    const panelHost = createPanel();
    const saveBastion = vi.fn();
    const getBastion = vi.fn(async () => ({
      id: FIXED_BASTION_ID,
      name: '生产',
      baseUrl: 'https://jms.prod.example.com',
      orgId: 'org-1',
      username: 'alan',
      verifyTls: true,
      updatedAt: 1
    }));
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(
      extensionContext(),
      { getBastion, saveBastion },
      { mode: 'edit', bastionId: FIXED_BASTION_ID },
      () => '22222222-2222-2222-2222-222222222222'
    );

    expect(getBastion).toHaveBeenCalledWith(FIXED_BASTION_ID);
    expect(panelHost.panel.webview.html).toContain('name="displayName"');
    expect(panelHost.panel.webview.html).toContain('value="生产"');
    expect(panelHost.panel.webview.html).toContain('name="bastionId"');
    expect(panelHost.panel.webview.html).toContain(`value="${FIXED_BASTION_ID}"`);
    expect(panelHost.panel.webview.html).toContain('value="https://jms.prod.example.com"');
    expect(panelHost.panel.webview.html).toContain('value="alan"');
    expect(panelHost.panel.webview.html).toContain('value="org-1"');

    await panelHost.fireMessage({
      type: 'save',
      payload: {
        displayName: '生产',
        bastionId: FIXED_BASTION_ID,
        baseUrl: 'https://jms.prod.example.com/',
        orgId: 'org-1',
        username: 'alan',
        password: 'secret',
        verifyTls: true
      }
    });

    expect(saveBastion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: FIXED_BASTION_ID,
        name: '生产',
        baseUrl: 'https://jms.prod.example.com/',
        orgId: 'org-1',
        username: 'alan'
      }),
      'secret'
    );
  });

  /**
   * `parseJumpServerBastion` runs inside `saveBastion`, and its ZodError used
   * to escape an async listener nobody awaits: the panel stayed open, nothing
   * was written, and the user was told none of it.
   */
  it('names the field that failed validation instead of failing silently', async () => {
    const panelHost = createPanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(
      extensionContext(),
      {
        getBastion: async () => undefined,
        saveBastion: async (bastion) => {
          parseJumpServerBastion(bastion);
        }
      },
      { mode: 'add' },
      idFactory
    );
    await panelHost.fireMessage({
      type: 'save',
      payload: {
        displayName: '',
        bastionId: '',
        baseUrl: 'jumpserver.example.com',
        orgId: 'org-1',
        username: 'alan',
        password: 'super-secret',
        verifyTls: true
      }
    });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('baseUrl'));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('http://'));
    // The form has to stay open on the value the user still needs to correct.
    expect(panelHost.panel.dispose).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('reports a save message that arrived without a payload', async () => {
    const panelHost = createPanel();
    const saveBastion = vi.fn();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(
      extensionContext(),
      { getBastion: async () => undefined, saveBastion },
      { mode: 'add' },
      idFactory
    );
    await expect(panelHost.fireMessage({ type: 'save' })).resolves.toBeUndefined();

    expect(saveBastion).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(panelHost.panel.dispose).not.toHaveBeenCalled();
  });

  it('syncs JumpServer assets every time configuration is saved', async () => {
    const panelHost = createPanel();
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panelHost.panel);

    await JumpServerConfigPanel.open(
      extensionContext(),
      {
        getBastion: async () => undefined,
        saveBastion: async () => undefined
      },
      { mode: 'add' },
      idFactory
    );
    await panelHost.fireMessage({
      type: 'save',
      payload: {
        displayName: '',
        bastionId: '',
        baseUrl: 'https://jumpserver.example.com/',
        orgId: 'org-1',
        username: 'alan',
        password: 'super-secret',
        verifyTls: true
      }
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('jumpserverManager.refreshBastion', FIXED_BASTION_ID);
  });
});
