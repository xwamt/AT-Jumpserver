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
  private readonly contexts = new Map<string, ActiveTerminalContext>();
  private readonly activeChanged = new vscode.EventEmitter<ActiveTerminalContext | undefined>();
  private readonly contextChanged = new vscode.EventEmitter<ActiveTerminalContext>();
  private readonly contextRemoved = new vscode.EventEmitter<string>();
  readonly onDidChangeActiveContext = this.activeChanged.event;
  readonly onDidChangeContext = this.contextChanged.event;
  readonly onDidRemoveContext = this.contextRemoved.event;

  setActive(context: ActiveTerminalContext): void {
    this.contexts.set(context.terminalId, context);
    this.active = context;
    this.contextChanged.fire(context);
    this.activeChanged.fire(this.active);
  }

  getActive(): ActiveTerminalContext | undefined {
    return this.active;
  }

  getContext(terminalId: string): ActiveTerminalContext | undefined {
    return this.contexts.get(terminalId);
  }

  clearIfActive(terminalId: string): void {
    const removed = this.contexts.delete(terminalId);
    if (removed) {
      this.contextRemoved.fire(terminalId);
    }
    if (this.active?.terminalId === terminalId) {
      this.active = undefined;
      this.activeChanged.fire(undefined);
    }
  }

  markConnected(terminalId: string): void {
    this.updateConnectionState(terminalId, true);
  }

  markDisconnected(terminalId: string): void {
    this.updateConnectionState(terminalId, false);
  }

  private updateConnectionState(terminalId: string, connected: boolean): void {
    const existing = this.contexts.get(terminalId);
    if (!existing || existing.connected === connected) {
      return;
    }
    const updated = { ...existing, connected };
    this.contexts.set(terminalId, updated);
    this.contextChanged.fire(updated);
    if (this.active?.terminalId === terminalId) {
      this.active = updated;
      this.activeChanged.fire(this.active);
    }
  }
}
