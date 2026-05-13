import * as vscode from 'vscode';
import { TerminalPanel } from './webview/TerminalPanel';

export function activate(_context: vscode.ExtensionContext): void {
  // JumpServer command wiring is added in the extension integration task.
}

export function deactivate(): void {
  TerminalPanel.disconnectAll();
}
