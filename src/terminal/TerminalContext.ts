import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../config/schema';

export interface ActiveTerminalContext {
  terminalId: string;
  asset: CachedJumpServerAsset;
  connected: boolean;
  write(data: string): void;
}

export class TerminalContextRegistry {
  private active: ActiveTerminalContext | undefined;
  private readonly changed = new vscode.EventEmitter<ActiveTerminalContext | undefined>();
  readonly onDidChangeActiveContext = this.changed.event;

  setActive(context: ActiveTerminalContext): void {
    this.active = context;
    this.changed.fire(this.active);
  }

  getActive(): ActiveTerminalContext | undefined {
    return this.active;
  }

  clearIfActive(terminalId: string): void {
    if (this.active?.terminalId === terminalId) {
      this.active = undefined;
      this.changed.fire(undefined);
    }
  }

  markConnected(terminalId: string): void {
    if (this.active?.terminalId === terminalId && !this.active.connected) {
      this.active = { ...this.active, connected: true };
      this.changed.fire(this.active);
    }
  }

  markDisconnected(terminalId: string): void {
    if (this.active?.terminalId === terminalId && this.active.connected) {
      this.active = { ...this.active, connected: false };
      this.changed.fire(this.active);
    }
  }
}
