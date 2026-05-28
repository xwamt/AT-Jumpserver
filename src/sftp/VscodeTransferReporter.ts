import * as vscode from 'vscode';
import { showTimedNotification } from '../utils/notifications';
import type { TransferProgress, TransferReporter } from './TransferService';

export class VscodeTransferReporter implements TransferReporter {
  async withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: label,
      cancellable: false
    }, async (progress) => {
      return await job({
        report(event) {
          const increment = event.totalBytes > 0 ? (event.transferredBytes / event.totalBytes) * 100 : 0;
          progress.report({ increment, message: `${event.transferredBytes}/${event.totalBytes} bytes` });
        }
      });
    });
  }

  async notifySuccess(message: string): Promise<void> {
    await showTimedNotification(message);
  }
}
