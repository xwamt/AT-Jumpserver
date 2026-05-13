import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { JumpServerClient } from '../jumpserver/JumpServerClient';
import { JumpServerSession } from '../jumpserver/JumpServerSession';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { renderWebviewHtml, type WebviewAsset } from './html';

type TerminalMessage =
  | { type: 'ready'; rows: number; cols: number }
  | { type: 'input'; payload: string }
  | { type: 'resize'; rows: number; cols: number };

interface TerminalSessionLike {
  write(data: string): void;
  resize(rows: number, cols: number): void;
}

export interface TerminalSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
  semanticHighlight: boolean;
  idleDisconnectMinutes: number;
}

export interface ConfigurationLike {
  get<T>(key: string, defaultValue: T): T;
}

export function resolveTerminalSettings(configuration: ConfigurationLike): TerminalSettings {
  return {
    scrollback: configuration.get('scrollback', 5000),
    fontSize: configuration.get('terminalFontSize', 14),
    fontFamily: configuration.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace'),
    semanticHighlight: configuration.get('semanticHighlight', true),
    idleDisconnectMinutes: configuration.get('idleDisconnectMinutes', 60)
  };
}

export function createTerminalAssets(extensionUri: vscode.Uri): WebviewAsset {
  return {
    script: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'terminal.js'),
    style: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'terminal.css')
  };
}

export function createTerminalViewColumn(): vscode.ViewColumn {
  return vscode.ViewColumn.Active;
}

export function renderTerminalBody(settings: TerminalSettings): string {
  return `<main class="terminal-shell">
  <header class="terminal-status terminal-status--connecting" id="status" role="status" aria-live="polite">
    <span class="terminal-status-dot"></span>
    <span class="terminal-status-text">Starting...</span>
    <span class="terminal-host">xterm.js</span>
  </header>
  <section id="terminal" class="terminal-surface" data-scrollback="${settings.scrollback}" data-font-size="${settings.fontSize}" data-font-family="${escapeAttr(settings.fontFamily)}" data-semantic-highlight="${settings.semanticHighlight}"></section>
</main>`;
}

export function formatTerminalNotice(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

export function handleTerminalMessage(message: TerminalMessage, session: TerminalSessionLike): boolean {
  if (message.type === 'input' && typeof message.payload === 'string') {
    session.write(message.payload);
    return true;
  }
  if (message.type === 'ready' || message.type === 'resize') {
    session.resize(message.rows, message.cols);
    return true;
  }
  return false;
}

export class TerminalPanel {
  private static active: TerminalPanel | undefined;
  private static readonly panels = new Set<TerminalPanel>();
  private readonly terminalId = randomUUID();
  private session: JumpServerSession;
  private connected = false;
  private disposed = false;
  private connectionGeneration = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly asset: CachedJumpServerAsset,
    private readonly jumpServerClient: JumpServerClient,
    private readonly settings: TerminalSettings,
    private readonly terminalContext?: TerminalContextRegistry
  ) {
    this.session = this.createSession(this.connectionGeneration);
    TerminalPanel.panels.add(this);
  }

  static open(
    context: vscode.ExtensionContext,
    asset: CachedJumpServerAsset,
    jumpServerClient: JumpServerClient,
    terminalContext?: TerminalContextRegistry
  ): TerminalPanel {
    const panel = vscode.window.createWebviewPanel(
      'jumpserverTerminal',
      `JumpServer: ${asset.name}`,
      createTerminalViewColumn(),
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    const settings = resolveTerminalSettings(vscode.workspace.getConfiguration('jumpserverManager'));
    const terminal = new TerminalPanel(panel, asset, jumpServerClient, settings, terminalContext);
    TerminalPanel.active = terminal;
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      createTerminalAssets(context.extensionUri),
      renderTerminalBody(settings)
    );
    terminal.bind();
    terminal.publishContext();
    void terminal.connect();
    return terminal;
  }

  static getActive(): TerminalPanel | undefined {
    return TerminalPanel.active;
  }

  static disconnectAll(): void {
    for (const terminal of Array.from(TerminalPanel.panels)) {
      terminal.disconnect();
    }
    TerminalPanel.panels.clear();
    TerminalPanel.active = undefined;
  }

  async connect(): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      await this.session.connect();
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = true;
      this.terminalContext?.markConnected(this.terminalId);
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.postStatus(formatError(error));
    }
  }

  async reconnect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    try {
      this.postStatus('Reconnecting...');
      this.session.dispose();
      this.session = this.createSession(generation);
      await this.session.connect();
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = true;
      this.terminalContext?.markConnected(this.terminalId);
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.postStatus(formatError(error));
    }
  }

  disconnect(): void {
    this.connectionGeneration++;
    this.session.dispose();
    this.connected = false;
    this.terminalContext?.markDisconnected(this.terminalId);
    this.postStatus('Disconnected');
    this.postWebviewMessage({ type: 'output', payload: formatTerminalNotice('Connection disconnected') });
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      handleTerminalMessage(message, this.session);
    });

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPanel.active = this;
        this.publishContext();
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.connectionGeneration++;
      this.session.dispose();
      this.connected = false;
      this.terminalContext?.clearIfActive(this.terminalId);
      TerminalPanel.panels.delete(this);
      if (TerminalPanel.active === this) {
        TerminalPanel.active = undefined;
      }
    });
  }

  private createSession(generation: number): JumpServerSession {
    return new JumpServerSession({
      asset: this.asset,
      client: this.jumpServerClient,
      events: {
        output: (data) => this.postWebviewMessage({ type: 'outputBytes', payload: [...data] }),
        status: (message) => this.handleSessionStatus(message, generation),
        error: (error) => this.postStatus(formatError(error))
      }
    });
  }

  private postStatus(message: string): void {
    this.postWebviewMessage({ type: 'status', payload: message });
  }

  private handleSessionStatus(message: string, generation: number): void {
    if (message === 'Disconnected' && generation === this.connectionGeneration) {
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.postWebviewMessage({ type: 'output', payload: formatTerminalNotice('Connection disconnected') });
    }
    this.postStatus(message);
  }

  private publishContext(): void {
    this.terminalContext?.setActive({
      terminalId: this.terminalId,
      asset: this.asset,
      connected: this.connected,
      write: (data) => this.session.write(data)
    });
  }

  private postWebviewMessage(message: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
    } catch {
      // VS Code can reject or throw if a late terminal event arrives after disposal.
    }
  }
}

export function renderTerminalHtml(webview: vscode.Webview, assets: WebviewAsset, settings: TerminalSettings): string {
  return renderWebviewHtml(webview, assets, renderTerminalBody(settings));
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
