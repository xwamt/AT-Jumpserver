import * as vscode from 'vscode';
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
  static getActive(): TerminalPanel | undefined {
    return undefined;
  }

  static disconnectAll(): void {}

  disconnect(): void {}

  async reconnect(): Promise<void> {}
}

export function renderTerminalHtml(webview: vscode.Webview, assets: WebviewAsset, settings: TerminalSettings): string {
  return renderWebviewHtml(webview, assets, renderTerminalBody(settings));
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
