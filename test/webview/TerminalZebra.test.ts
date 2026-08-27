import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyTerminalZebraRows,
  scheduleTerminalZebraRefresh,
  TERMINAL_ROW_EVEN_CLASS,
  TERMINAL_ROW_ODD_CLASS
} from '../../webview/terminal/zebra';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.delete(token);
    }
  }

  has(token: string): boolean {
    return this.values.has(token);
  }
}

function fakeRow() {
  return { classList: new FakeClassList() };
}

describe('terminal zebra striping', () => {
  it('assigns alternating row classes and removes stale stripe classes', () => {
    const rows = [fakeRow(), fakeRow(), fakeRow()];
    rows[0].classList.add(TERMINAL_ROW_ODD_CLASS);
    rows[1].classList.add(TERMINAL_ROW_EVEN_CLASS);

    applyTerminalZebraRows(rows);

    expect(rows[0].classList.has(TERMINAL_ROW_EVEN_CLASS)).toBe(true);
    expect(rows[0].classList.has(TERMINAL_ROW_ODD_CLASS)).toBe(false);
    expect(rows[1].classList.has(TERMINAL_ROW_ODD_CLASS)).toBe(true);
    expect(rows[1].classList.has(TERMINAL_ROW_EVEN_CLASS)).toBe(false);
    expect(rows[2].classList.has(TERMINAL_ROW_EVEN_CLASS)).toBe(true);
  });

  it('coalesces repeated write-parsed notifications into one stripe refresh per frame', () => {
    const refresh = vi.fn();
    let listener!: () => void;
    const terminal = {
      onWriteParsed(callback: () => void) {
        listener = callback;
        return { dispose: vi.fn() };
      }
    };
    const frames: Array<FrameRequestCallback> = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    scheduleTerminalZebraRefresh(terminal, refresh, requestFrame);
    listener();
    listener();

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    frames[0](0);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stripes rows via CSS nth-child so no per-frame JS is needed', () => {
    const css = readFileSync(resolve(__dirname, '../../webview/terminal/index.css'), 'utf8');

    // First visible row (CSS nth-child(odd)) keeps the old JS "even" stripe color.
    expect(css).toMatch(/\.xterm-rows > div:nth-child\(odd\)\s*\{[^}]*rgba\(255, 255, 255, 0\.025\)/);
    expect(css).toMatch(/\.xterm-rows > div:nth-child\(even\)\s*\{[^}]*rgba\(0, 0, 0, 0\.06\)/);
  });
});
