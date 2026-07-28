export interface TransferProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}

export interface TransferReporter {
  withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T>;
  notifySuccess(message: string): Promise<void>;
}

const noopProgress: TransferProgress = { report: () => undefined };

export class TransferService {
  constructor(private readonly reporter?: TransferReporter) {}

  async run<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T> {
    const result = this.reporter
      ? await this.reporter.withProgress(label, job)
      : await job(noopProgress);
    await this.reporter?.notifySuccess(`${label} completed.`);
    return result;
  }
}
