import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';
import { JumpServerClient } from '../jumpserver/JumpServerClient';
import { connectionKindLabel, getAssetConnectionKind, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';
import { JumpServerSession } from '../jumpserver/JumpServerSession';
import type { JumpServerAccountRef, TerminalConnectionState } from '../jumpserver/types';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { showTimedNotification } from '../utils/notifications';
import { renderWebviewHtml, type WebviewAsset } from './html';
import { t } from '../i18n/t';

type TerminalMessage =
  | { type: 'ready'; rows: number; cols: number }
  | { type: 'input'; payload: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'reconnect' };

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

export function renderTerminalBody(settings: TerminalSettings, hostLabel = 'xterm.js'): string {
  return `<main class="terminal-shell">
  <header class="terminal-status terminal-status--connecting" id="status" role="status" aria-live="polite">
    <span class="terminal-status-dot"></span>
    <span class="terminal-status-text">${escapeAttr(t('Starting...'))}</span>
    <button id="reconnect-btn" class="terminal-reconnect-btn" type="button" title="${escapeAttr(t('Reconnect'))}" aria-label="${escapeAttr(t('Reconnect'))}">
      <svg class="terminal-reconnect-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
        <path d="M13.65 2.35A7.958 7.958 0 0 0 8 0a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24l-2.48 2.48H16V0l-2.35 2.35z"/>
      </svg>
      <span class="terminal-reconnect-label">${escapeAttr(t('Reconnect'))}</span>
    </button>
    <span class="terminal-host">${escapeAttr(hostLabel)}</span>
  </header>
  <section id="terminal" class="terminal-surface" data-scrollback="${escapeAttr(settings.scrollback)}" data-font-size="${escapeAttr(settings.fontSize)}" data-font-family="${escapeAttr(settings.fontFamily)}" data-semantic-highlight="${escapeAttr(settings.semanticHighlight)}"></section>
</main>`;
}


export function formatTerminalNotice(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

export function handleTerminalMessage(
  message: TerminalMessage,
  session: TerminalSessionLike,
  panel?: { reconnect(): Promise<void> }
): boolean {
  if (message.type === 'reconnect') {
    void panel?.reconnect();
    return true;
  }
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

export interface AccountPreferenceStore {
  getPreferredAccountKey(bastionId: string, assetId: string): string | undefined;
  setPreferredAccountKey(bastionId: string, assetId: string, accountKey: string | undefined): Promise<void>;
}

export function accountRefKey(account: JumpServerAccountRef): string {
  return account.kind === 'alias' ? `alias:${account.alias}` : `managed:${account.id}`;
}

export class TerminalPanel {
  private static active: TerminalPanel | undefined;
  private static readonly panels = new Set<TerminalPanel>();
  private static accountPreferenceStore: AccountPreferenceStore | undefined;
  private readonly terminalId = randomUUID();
  private readonly connectionKind: JumpServerConnectionKind;
  private session: JumpServerSession;
  private currentTokenId: string | undefined;
  private connected = false;
  private disposed = false;
  private connectionGeneration = 0;
  private pendingOutput: Buffer[] = [];
  private pendingOutputBytes = 0;
  private outputFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private idleDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAt = Date.now();
  private lastSize: { rows: number; cols: number } | undefined;
  private forceNextAccountPick: boolean;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly asset: CachedJumpServerAsset,
    private readonly jumpServerClient: JumpServerClient,
    private settings: TerminalSettings,
    private readonly terminalContext?: TerminalContextRegistry,
    options?: { forceAccountPick?: boolean }
  ) {
    this.connectionKind = getAssetConnectionKind(asset);
    this.forceNextAccountPick = Boolean(options?.forceAccountPick);
    this.session = this.createSession(this.connectionGeneration);
    TerminalPanel.panels.add(this);
  }

  static setAccountPreferenceStore(store?: AccountPreferenceStore): void {
    TerminalPanel.accountPreferenceStore = store;
  }

  static open(
    context: vscode.ExtensionContext,
    asset: CachedJumpServerAsset,
    jumpServerClient: JumpServerClient,
    terminalContext?: TerminalContextRegistry,
    options?: { forceAccountPick?: boolean }
  ): TerminalPanel {
    const connectionKind = getAssetConnectionKind(asset);
    const panel = vscode.window.createWebviewPanel(
      'jumpserverTerminal',
      t('JumpServer {kind}: {name}', { kind: connectionKindLabel(connectionKind), name: asset.name }),
      createTerminalViewColumn(),
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    const settings = resolveTerminalSettings(vscode.workspace.getConfiguration('jumpserverManager'));
    const terminal = new TerminalPanel(panel, asset, jumpServerClient, settings, terminalContext, options);
    const hostLabel = `${asset.address || asset.name} · ${connectionKindLabel(connectionKind)}`;
    TerminalPanel.active = terminal;
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      createTerminalAssets(context.extensionUri),
      renderTerminalBody(settings, hostLabel)
    );
    terminal.bind();
    terminal.publishContext();
    void vscode.commands.executeCommand('setContext', 'jumpserverTerminalActive', true);
    void terminal.connect();
    return terminal;
  }

  static getActive(): TerminalPanel | undefined {
    return TerminalPanel.active;
  }

  static getReusableToken(connectionKey?: string, asset?: CachedJumpServerAsset): string | undefined {
    if (connectionKey) {
      for (const panel of TerminalPanel.panels) {
        if (panel.terminalId === connectionKey && panel.connected && panel.currentTokenId) {
          return panel.currentTokenId;
        }
      }
    }
    if (asset) {
      for (const panel of TerminalPanel.panels) {
        if (
          panel.connected &&
          panel.currentTokenId &&
          panel.asset.id === asset.id &&
          panel.asset.bastionId === asset.bastionId
        ) {
          return panel.currentTokenId;
        }
      }
    }
    if (connectionKey) {
      for (const panel of TerminalPanel.panels) {
        if (panel.asset.id === connectionKey && panel.connected && panel.currentTokenId) {
          return panel.currentTokenId;
        }
      }
    }
    return undefined;
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
    TerminalPanel.accountPreferenceStore = undefined;
    void vscode.commands.executeCommand('setContext', 'jumpserverTerminalActive', false);
  }

  static syncConfiguration(settings: TerminalSettings): void {
    for (const terminal of TerminalPanel.panels) {
      terminal.applySettings(settings);
    }
  }

  static disposeSessionsForBastion(bastionId: string): string[] {
    const terminalIds: string[] = [];
    for (const terminal of Array.from(TerminalPanel.panels)) {
      if (terminal.asset.bastionId !== bastionId) {
        continue;
      }
      terminalIds.push(terminal.terminalId);
      terminal.panel.dispose();
    }
    return terminalIds;
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
      this.currentTokenId = undefined;
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      this.postStatus(formatError(error), 'disconnected');
    }
  }

  async reconnect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.currentTokenId = undefined;
    try {
      this.postStatus(t('Reconnecting...'), 'connecting');
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
      this.currentTokenId = undefined;
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      this.postStatus(formatError(error), 'disconnected');
    }
  }

  disconnect(reason?: string): void {
    this.connectionGeneration++;
    this.currentTokenId = undefined;
    this.clearIdleDisconnect();
    this.session.dispose();
    this.connected = false;
    this.terminalContext?.markDisconnected(this.terminalId);
    this.postStatus(reason ?? t('Disconnected'), 'disconnected');
    const notice = formatTerminalNotice(reason ?? t('Connection disconnected'));
    this.terminalContext?.appendOutput(this.terminalId, notice);
    this.postWebviewMessage({ type: 'output', payload: notice });
  }


  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      try {
        if (handleTerminalMessage(message, this.session, this)) {
          if (message.type === 'ready' || message.type === 'resize') {
            this.lastSize = { rows: message.rows, cols: message.cols };
          }
          this.markActivity();
        }
      } catch (error) {
        // A session that has lost its peer rejects writes rather than dropping
        // them. Typing into one is a status line, not an exception thrown back
        // into VS Code's message dispatcher.
        const messageText = formatError(error);
        const state: TerminalConnectionState =
          !this.connected || /unavailable/i.test(messageText) ? 'disconnected' : 'connected';
        this.postStatus(messageText, state);
      }
    });

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPanel.active = this;
        this.publishContext();
        void vscode.commands.executeCommand('setContext', 'jumpserverTerminalActive', true);
      } else if (TerminalPanel.active === this) {
        TerminalPanel.active = undefined;
        void vscode.commands.executeCommand('setContext', 'jumpserverTerminalActive', false);
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
      this.currentTokenId = undefined;
      this.session.dispose();
      this.connected = false;
      this.terminalContext?.clearIfActive(this.terminalId);
      TerminalPanel.panels.delete(this);
      if (TerminalPanel.active === this) {
        TerminalPanel.active = undefined;
        void vscode.commands.executeCommand('setContext', 'jumpserverTerminalActive', false);
      }
    });
  }

  private createSession(generation: number): JumpServerSession {
    const session = new JumpServerSession({
      asset: this.asset,
      connectionKind: this.connectionKind,
      client: this.jumpServerClient,
      onTokenReady: (tokenId, info) => {
        if (generation === this.connectionGeneration && info?.reusable) {
          this.currentTokenId = tokenId;
        }
      },
      selectAccount: async (accounts, asset) => {
        const forcePick = this.forceNextAccountPick;
        this.forceNextAccountPick = false;
        const bastionId = asset.bastionId ?? '';
        const rememberedKey = bastionId
          ? TerminalPanel.accountPreferenceStore?.getPreferredAccountKey(bastionId, asset.id)
          : undefined;
        if (!forcePick && rememberedKey) {
          const remembered = accounts.find((candidate) => accountRefKey(candidate) === rememberedKey);
          if (remembered) {
            return remembered;
          }
        }
        const picked = await vscode.window.showQuickPick(
          accounts.map((candidate) => {
            const key = accountRefKey(candidate);
            const label = candidate.kind === 'alias'
              ? (candidate.username ? `${candidate.alias} (${candidate.username})` : candidate.alias)
              : (candidate.username || candidate.alias || candidate.id);
            const tags: string[] = [];
            if (key === rememberedKey) {
              tags.push(t('Last used'));
            }
            if (candidate.kind === 'alias') {
              tags.push(t('Alias account'));
            } else if (candidate.hasSecret === false) {
              tags.push(t('No secret saved'));
            }
            return {
              label,
              description: tags.join(' · ') || undefined,
              account: candidate
            };
          }),
          {
            title: t('Select account for {name}', { name: asset.name }),
            placeHolder: t('Choose the JumpServer account to connect with'),
            ignoreFocusOut: true
          }
        );
        if (!picked) {
          return undefined;
        }
        if (bastionId && TerminalPanel.accountPreferenceStore) {
          await TerminalPanel.accountPreferenceStore.setPreferredAccountKey(
            bastionId,
            asset.id,
            accountRefKey(picked.account)
          );
        }
        return picked.account;
      },
      resolveInputAccount: async (asset) => {
        const username = await vscode.window.showInputBox({
          prompt: t('Enter username for @INPUT account on {name}', { name: asset.name }),
          ignoreFocusOut: true
        });
        if (!username) {
          return undefined;
        }
        const password = await vscode.window.showInputBox({
          prompt: t('Enter password for {username} on {name}', { username, name: asset.name }),
          password: true,
          ignoreFocusOut: true
        });
        return { username, password };
      },
      events: {
        output: (data) => {
          // The context buffer feeds MCP marker detection, so it must never be
          // delayed by the webview's coalescing window.
          this.terminalContext?.appendOutput(this.terminalId, data);
          this.markActivity();
          this.queueOutput(data);
        },
        status: (message, state) => this.handleSessionStatus(message, generation, state),
        error: (error) => this.postStatus(formatError(error), this.connected ? 'connected' : 'disconnected')
      }
    });
    if (this.lastSize) {
      session.resize(this.lastSize.rows, this.lastSize.cols);
    }
    return session;
  }

  private applySettings(settings: TerminalSettings): void {
    this.settings = settings;
    this.postWebviewMessage({
      type: 'settings',
      payload: {
        scrollback: settings.scrollback,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        semanticHighlight: settings.semanticHighlight
      }
    });
    if (this.connected) {
      this.armIdleDisconnect();
    }
  }

  private postStatus(message: string, state: TerminalConnectionState): void {
    this.postWebviewMessage({ type: 'status', state, payload: message });
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
      const message = t('Disconnected after {minutes} minute(s) of inactivity.', {
        minutes: this.settings.idleDisconnectMinutes
      });
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

  private handleSessionStatus(
    message: string,
    generation: number,
    explicitState?: TerminalConnectionState
  ): void {
    const state = explicitState ?? inferTerminalState(message);
    if (state === 'disconnected' && generation === this.connectionGeneration) {
      this.currentTokenId = undefined;
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      const detail = extractDisconnectDetail(message);
      const baseNotice = t('Connection disconnected');
      const notice = formatTerminalNotice(detail ? `${baseNotice} ${detail}` : baseNotice);
      this.terminalContext?.appendOutput(this.terminalId, notice);
      this.postWebviewMessage({ type: 'output', payload: notice });
    }
    this.postStatus(message, state);
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

export function renderTerminalHtml(
  webview: vscode.Webview,
  assets: WebviewAsset,
  settings: TerminalSettings,
  hostLabel?: string
): string {
  return renderWebviewHtml(webview, assets, renderTerminalBody(settings, hostLabel));
}

function inferTerminalState(message: string): TerminalConnectionState {
  if (message === 'Connected' || message === t('Connected') || message === '已连接') {
    return 'connected';
  }
  const lower = message.toLowerCase();
  if (
    lower.includes('disconnect') ||
    lower.includes('failed') ||
    lower.includes('error') ||
    lower.includes('unavailable') ||
    lower.includes('rejected') ||
    message.includes('已断开') ||
    message.includes('断开连接')
  ) {
    return 'disconnected';
  }
  return 'connecting';
}

function extractDisconnectDetail(message: string): string {
  const localizedPrefix = t('Disconnected');
  if (message.startsWith(localizedPrefix)) {
    return message.slice(localizedPrefix.length).trim();
  }
  if (message.startsWith('Disconnected')) {
    return message.slice('Disconnected'.length).trim();
  }
  return '';
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
