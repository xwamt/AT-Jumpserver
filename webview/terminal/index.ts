import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import {
  createTerminalKeyboardHandler,
  installTerminalClipboardPasteHandler,
  installTerminalFocusRecovery,
  resolveTerminalStatusClass,
  type TerminalClipboard
} from './clipboard';
import { createTerminalOptions } from './options';
import { writeTerminalOutputMessage } from './output';
import { watchTerminalTheme } from './theme';

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const container = document.querySelector<HTMLElement>('#terminal');
const status = document.querySelector<HTMLElement>('#status');
const reconnectBtn = document.querySelector<HTMLButtonElement>('#reconnectBtn');

if (!container) {
  throw new Error('Missing terminal container');
}

const term = new Terminal(
  createTerminalOptions(
    {
      scrollback: Number(container.dataset.scrollback ?? '5000'),
      fontSize: Number(container.dataset.fontSize ?? '14'),
      fontFamily: container.dataset.fontFamily || 'Cascadia Code, Menlo, monospace'
    },
    (name) => getComputedStyle(document.body).getPropertyValue(name)
  )
);

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open(container);
watchTerminalTheme(term);

const clipboard: TerminalClipboard = {
  readText: () => navigator.clipboard?.readText() ?? Promise.resolve(''),
  writeText: (value) => navigator.clipboard?.writeText(value) ?? Promise.resolve()
};

term.attachCustomKeyEventHandler(
  createTerminalKeyboardHandler(term, {
    clipboard,
    sendInput: (data) => vscode.postMessage({ type: 'input', payload: data })
  })
);
if (term.textarea) {
  installTerminalClipboardPasteHandler(term, term.textarea);
}

installTerminalFocusRecovery(term, {
  container,
  document,
  setTimeout: window.setTimeout.bind(window)
});

term.onData((data) => {
  vscode.postMessage({ type: 'input', payload: data });
});

let lastCols = 0;
let lastRows = 0;
let fitFrame = 0;

function fitAndNotify(force = false): void {
  fitAddon.fit();
  if (!force && term.cols === lastCols && term.rows === lastRows) {
    return;
  }
  lastCols = term.cols;
  lastRows = term.rows;
  vscode.postMessage({ type: force ? 'ready' : 'resize', rows: term.rows, cols: term.cols });
}

function scheduleFit(force = false): void {
  if (fitFrame) {
    cancelAnimationFrame(fitFrame);
  }
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    fitAndNotify(force);
  });
}

const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});
resizeObserver.observe(container);
window.addEventListener('resize', () => scheduleFit());

reconnectBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'reconnect' });
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: unknown; state?: unknown };
  writeTerminalOutputMessage(message, term, { semanticHighlight: container.dataset.semanticHighlight === 'true' });
  if (message.type === 'status' && typeof message.payload === 'string' && status) {
    const text = status.querySelector<HTMLElement>('.terminal-status-text');
    if (text) {
      text.textContent = message.payload;
    } else {
      status.textContent = message.payload;
    }
    const explicitState = typeof message.state === 'string' ? message.state : undefined;
    const statusClass = resolveTerminalStatusClass(message.payload, explicitState);
    status.classList.toggle('terminal-status--connected', statusClass === 'connected');
    status.classList.toggle('terminal-status--disconnected', statusClass === 'disconnected');
    status.classList.toggle('terminal-status--connecting', statusClass === 'connecting');
    if (reconnectBtn) {
      reconnectBtn.hidden = statusClass !== 'disconnected';
    }
  }
  if (message.type === 'settings' && message.payload && typeof message.payload === 'object') {
    const settingsPayload = message.payload as {
      scrollback?: unknown;
      fontSize?: unknown;
      fontFamily?: unknown;
      semanticHighlight?: unknown;
    };
    if (typeof settingsPayload.scrollback === 'number') {
      term.options.scrollback = settingsPayload.scrollback;
    }
    if (typeof settingsPayload.fontSize === 'number') {
      term.options.fontSize = settingsPayload.fontSize;
    }
    if (typeof settingsPayload.fontFamily === 'string' && settingsPayload.fontFamily.trim()) {
      term.options.fontFamily = settingsPayload.fontFamily;
    }
    if (typeof settingsPayload.semanticHighlight === 'boolean') {
      container.dataset.semanticHighlight = String(settingsPayload.semanticHighlight);
    }
    scheduleFit();
  }
});

scheduleFit(true);
