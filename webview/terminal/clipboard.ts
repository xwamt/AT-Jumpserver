export interface TerminalClipboard {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
  focus(): void;
}

interface PasteTerminal {
  paste(data: string): void;
  focus(): void;
}

interface KeyboardHandlerOptions {
  clipboard: TerminalClipboard;
  sendInput(data: string): void;
}

interface FocusRecoveryOptions {
  container: EventTarget;
  document: EventTarget;
  setTimeout: (callback: () => void, delay?: number) => unknown;
}

const INTERRUPT_BYTE = '\x03';

export function createTerminalKeyboardHandler(
  terminal: ClipboardTerminal,
  options: KeyboardHandlerOptions
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return true;
    }

    const key = event.key.toLowerCase();
    if (key === 'c') {
      if (terminal.hasSelection()) {
        void options.clipboard
          .writeText(terminal.getSelection())
          .then(() => terminal.clearSelection())
          .finally(() => terminal.focus());
        return false;
      }

      options.sendInput(INTERRUPT_BYTE);
      terminal.focus();
      return false;
    }

    if (key === 'v') {
      event.preventDefault();
      event.stopImmediatePropagation();
      void options.clipboard
        .readText()
        .then((text) => {
          if (text) {
            terminal.paste(text);
          }
        })
        .catch(() => undefined)
        .finally(() => terminal.focus());
      return false;
    }

    return true;
  };
}

export function installTerminalFocusRecovery(
  terminal: Pick<ClipboardTerminal, 'focus'>,
  options: FocusRecoveryOptions
): void {
  const scheduleFocus = () => {
    options.setTimeout(() => terminal.focus(), 0);
  };

  options.document.addEventListener('copy', scheduleFocus);
  options.document.addEventListener('paste', scheduleFocus);
}

export function installTerminalClipboardPasteHandler(terminal: PasteTerminal, target: EventTarget): void {
  target.addEventListener(
    'paste',
    (event) => {
      const clipboardEvent = event as ClipboardEvent;
      const text = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
      if (!text) {
        return;
      }

      clipboardEvent.preventDefault();
      clipboardEvent.stopImmediatePropagation();
      terminal.paste(text);
      terminal.focus();
    },
    true
  );
}

export function resolveTerminalStatusClass(
  payload: string,
  state?: string
): 'connected' | 'disconnected' | 'connecting' {
  if (state === 'connected' || state === 'disconnected' || state === 'connecting') {
    return state;
  }
  if (payload === 'Connected' || payload === '已连接') {
    return 'connected';
  }
  const lowerPayload = payload.toLowerCase();
  if (
    lowerPayload.includes('disconnected') ||
    payload.includes('已断开') ||
    payload.includes('断开连接')
  ) {
    return 'disconnected';
  }
  return 'connecting';
}
