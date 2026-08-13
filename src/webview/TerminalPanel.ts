import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { JumpServerClient } from '../jumpserver/JumpServerClient';
import { connectionKindLabel, getAssetConnectionKind, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';
import { JumpServerSession } from '../jumpserver/JumpServerSession';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { showTimedNotification } from '../utils/notifications';
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

/**
 * KoKo delivers one WebSocket frame per PTY burst, and every postMessage hop
 * costs a structured-clone plus a JSON round trip. Holding frames for a display
 * frame's worth of time collapses a `cat` of a large file from thousands of
 * hops into dozens without adding perceptible latency to interactive typing.
 */
const OUTPUT_FLUSH_INTERVAL_MS = 8;
const OUTPUT_FLUSH_BYTES = 64 * 1024;

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
  <section id="terminal" class="terminal-surface" data-scrollback="${escapeAttr(settings.scrollback)}" data-font-size="${escapeAttr(settings.fontSize)}" data-font-family="${escapeAttr(settings.fontFamily)}" data-semantic-highlight="${escapeAttr(settings.semanticHighlight)}"></section>
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
    if (!isTerminalDimension(message.rows) || !isTerminalDimension(message.cols)) {
      return false;
    }
    session.resize(message.rows, message.cols);
    return true;
  }
  return false;
}

/**
 * `rows <= 0` is false for the string "abc", which is how an unvalidated
 * dimension used to reach the JSON sent to KoKo. A PTY has a whole number of
 * rows, so anything else is a bug in the sender and not a size to forward.
 */
function isTerminalDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export class TerminalPanel {
  private static active: TerminalPanel | undefined;
  private static readonly panels = new Set<TerminalPanel>();
  private readonly terminalId = randomUUID();
  private readonly connectionKind: JumpServerConnectionKind;
  private session: JumpServerSession;
  private connected = false;
  private disposed = false;
  private connectionGeneration = 0;
  private pendingOutput: Buffer[] = [];
  private pendingOutputBytes = 0;
  private outputFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private idleDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAt = Date.now();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly asset: CachedJumpServerAsset,
    private readonly jumpServerClient: JumpServerClient,
    private readonly settings: TerminalSettings,
    private readonly terminalContext?: TerminalContextRegistry
  ) {
    this.connectionKind = getAssetConnectionKind(asset);
    this.session = this.createSession(this.connectionGeneration);
    TerminalPanel.panels.add(this);
  }

  static open(
    context: vscode.ExtensionContext,
    asset: CachedJumpServerAsset,
    jumpServerClient: JumpServerClient,
    terminalContext?: TerminalContextRegistry
  ): TerminalPanel {
    const connectionKind = getAssetConnectionKind(asset);
    const panel = vscode.window.createWebviewPanel(
      'jumpserverTerminal',
      `JumpServer ${connectionKindLabel(connectionKind)}: ${asset.name}`,
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

  getTerminalId(): string {
    return this.terminalId;
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
      this.markActivity();
      this.armIdleDisconnect();
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
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
      this.markActivity();
      this.armIdleDisconnect();
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      this.postStatus(formatError(error));
    }
  }

  disconnect(reason?: string): void {
    this.connectionGeneration++;
    this.clearIdleDisconnect();
    this.session.dispose();
    this.connected = false;
    this.terminalContext?.markDisconnected(this.terminalId);
    this.postStatus(reason ?? 'Disconnected');
    const notice = formatTerminalNotice(reason ?? 'Connection disconnected');
    this.terminalContext?.appendOutput(this.terminalId, notice);
    this.postWebviewMessage({ type: 'output', payload: notice });
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      try {
        if (handleTerminalMessage(message, this.session)) {
          this.markActivity();
        }
      } catch (error) {
        // A session that has lost its peer rejects writes rather than dropping
        // them. Typing into one is a status line, not an exception thrown back
        // into VS Code's message dispatcher.
        this.postStatus(formatError(error));
      }
    });

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPanel.active = this;
        this.publishContext();
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.outputFlushTimer) {
        clearTimeout(this.outputFlushTimer);
        this.outputFlushTimer = undefined;
      }
      this.pendingOutput = [];
      this.pendingOutputBytes = 0;
      this.clearIdleDisconnect();
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
      connectionKind: this.connectionKind,
      client: this.jumpServerClient,
      events: {
        output: (data) => {
          // The context buffer feeds MCP marker detection, so it must never be
          // delayed by the webview's coalescing window.
          this.terminalContext?.appendOutput(this.terminalId, data);
          this.markActivity();
          this.queueOutput(data);
        },
        status: (message) => this.handleSessionStatus(message, generation),
        error: (error) => this.postStatus(formatError(error))
      }
    });
  }

  private postStatus(message: string): void {
    this.postWebviewMessage({ type: 'status', payload: message });
  }

  /**
   * A bastion session left open keeps a live credentialled path to a production
   * asset, so it is dropped once nothing has used it for a while. "Used" covers
   * keystrokes, remote output, and MCP agent writes alike: watching keystrokes
   * only would cut the connection out from under an agent mid tool call.
   *
   * Activity just stamps a timestamp. Output arrives thousands of times a
   * second during a large `cat`, and re-arming a timer per frame would undo the
   * batching the rest of this panel exists to do.
   */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private armIdleDisconnect(): void {
    this.clearIdleDisconnect();
    const idleMs = this.settings.idleDisconnectMinutes * 60_000;
    if (!this.connected || idleMs <= 0) {
      return;
    }
    const remaining = Math.max(0, idleMs - (Date.now() - this.lastActivityAt));
    this.idleDisconnectTimer = setTimeout(() => {
      this.idleDisconnectTimer = undefined;
      // The deadline that just fired predates whatever happened since it was
      // armed, so re-arm for the remainder instead of cutting a live session.
      if (Date.now() - this.lastActivityAt < idleMs) {
        this.armIdleDisconnect();
        return;
      }
      const message = `Disconnected after ${this.settings.idleDisconnectMinutes} minute(s) of inactivity.`;
      this.disconnect(message);
      void showTimedNotification(message, 'warning');
    }, remaining);
  }

  private clearIdleDisconnect(): void {
    if (!this.idleDisconnectTimer) {
      return;
    }
    clearTimeout(this.idleDisconnectTimer);
    this.idleDisconnectTimer = undefined;
  }

  private handleSessionStatus(message: string, generation: number): void {
    if (message.startsWith('Disconnected') && generation === this.connectionGeneration) {
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      const detail = message.slice('Disconnected'.length).trim();
      const notice = formatTerminalNotice(`Connection disconnected${detail ? ` ${detail}` : ''}`);
      this.terminalContext?.appendOutput(this.terminalId, notice);
      this.postWebviewMessage({ type: 'output', payload: notice });
    }
    this.postStatus(message);
  }

  private publishContext(): void {
    this.terminalContext?.setActive({
      terminalId: this.terminalId,
      asset: this.asset,
      connected: this.connected,
      // Every MCP agent write reaches the session through this closure, which
      // is what keeps a long-running tool call from idling itself out.
      write: (data) => {
        this.markActivity();
        this.session.write(data);
      }
    });
  }

  private queueOutput(data: Buffer): void {
    if (data.byteLength === 0) {
      return;
    }
    this.pendingOutput.push(data);
    this.pendingOutputBytes += data.byteLength;
    if (this.pendingOutputBytes >= OUTPUT_FLUSH_BYTES) {
      this.flushOutput();
      return;
    }
    this.outputFlushTimer ??= setTimeout(() => this.flushOutput(), OUTPUT_FLUSH_INTERVAL_MS);
  }

  private flushOutput(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = undefined;
    }
    if (this.pendingOutput.length === 0) {
      return;
    }
    const merged = Buffer.concat(this.pendingOutput, this.pendingOutputBytes);
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    // base64 costs ~1.33x on the wire; a JSON array of byte literals costs >4x
    // and forces the webview to walk every element before it can draw.
    this.sendToWebview({ type: 'outputBase64', payload: merged.toString('base64') });
  }

  private postWebviewMessage(message: unknown): void {
    // Anything else the panel says must appear after the bytes it follows.
    this.flushOutput();
    this.sendToWebview(message);
  }

  private sendToWebview(message: unknown): void {
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

/**
 * Takes `unknown` on purpose. Every value here is read from settings.json, so
 * the declared `number` and `boolean` are what the schema asks for rather than
 * what arrives; stringifying inside the escaper is what stops the next data
 * attribute added to this element from quietly skipping the escape.
 */
function escapeAttr(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
