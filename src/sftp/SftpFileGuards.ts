import { t } from '../i18n/t';

export const DEFAULT_SFTP_EDIT_MAX_BYTES = 1024 * 1024;

export class SftpFileGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpFileGuardError';
  }
}

export interface EditableFileCheck {
  remotePath: string;
  size?: number;
  sample?: Buffer;
  maxBytes?: number;
}

export function assertTextFileEditable(input: EditableFileCheck): void {
  const maxBytes = input.maxBytes ?? DEFAULT_SFTP_EDIT_MAX_BYTES;
  if (input.size !== undefined && input.size > maxBytes) {
    throw new SftpFileGuardError(
      t('Remote file is larger than {size}: {path}. Use Download instead.', {
        size: formatBytes(maxBytes),
        path: input.remotePath
      })
    );
  }
  if (input.sample && isLikelyBinary(input.sample)) {
    throw new SftpFileGuardError(
      t('Remote file appears to be binary: {path}. Use Download instead.', {
        path: input.remotePath
      })
    );
  }
}


export function isLikelyBinary(sample: Buffer): boolean {
  if (sample.length === 0) {
    return false;
  }
  if (sample.includes(0)) {
    return true;
  }
  let control = 0;
  for (const byte of sample) {
    const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (byte < 0x20 && !allowedWhitespace) {
      control++;
    }
  }
  return control / sample.length > 0.1;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}
