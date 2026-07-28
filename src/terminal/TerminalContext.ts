import * as vscode from 'vscode';
import { TerminalOutputBuffer } from '../agent/TerminalOutputBuffer';
import type { CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind, type JumpServerConnectionKind } from '../jumpserver/connectionTypes';

export interface ActiveTerminalContext {
  terminalId: string;
  asset: CachedJumpServerAsset;
  connected: boolean;
  write(data: string): void;
  output?: TerminalOutputBuffer;
}

export interface TerminalContextSummary {
  terminalId: string;
  assetId: string;
  assetName: string;
  address: string;
  connectionKind: JumpServerConnectionKind;
  connected: boolean;
}

export interface TerminalContextSnapshot {
  activeTerminal?: TerminalContextSummary;
  connectedTerminals: TerminalContextSummary[];
  knownTerminals: TerminalContextSummary[];
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
    const existing = this.contexts.get(context.terminalId);
    const next = {
      ...context,
      output: existing?.output ?? context.output ?? new TerminalOutputBuffer()
    };
    this.contexts.set(next.terminalId, next);
    this.active = next;
    this.contextChanged.fire(next);
    this.activeChanged.fire(this.active);
  }

  getActive(): ActiveTerminalContext | undefined {
    return this.active;
  }

  getContext(terminalId: string): ActiveTerminalContext | undefined {
    return this.contexts.get(terminalId);
  }

  appendOutput(terminalId: string, data: Buffer | string): void {
    this.contexts.get(terminalId)?.output?.append(data);
  }

  getOutputBuffer(terminalId: string): TerminalOutputBuffer | undefined {
    return this.contexts.get(terminalId)?.output;
  }

  getSnapshot(): TerminalContextSnapshot {
    const knownTerminals = Array.from(this.contexts.values()).map(toSummary);
    return {
      activeTerminal: this.active ? toSummary(this.active) : undefined,
      connectedTerminals: knownTerminals.filter((terminal) => terminal.connected),
      knownTerminals
    };
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

function toSummary(context: ActiveTerminalContext): TerminalContextSummary {
  return {
    terminalId: context.terminalId,
    assetId: context.asset.id,
    assetName: context.asset.name,
    address: context.asset.address,
    connectionKind: getAssetConnectionKind(context.asset),
    connected: context.connected
  };
}
