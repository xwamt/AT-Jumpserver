import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // JumpServer command wiring is added in the extension integration task.
}

export function deactivate(): void {
  // Terminal cleanup is added once the JumpServer terminal session is wired.
}
