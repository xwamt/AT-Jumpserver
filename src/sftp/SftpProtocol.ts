import { joinRemotePath } from './RemotePath';
import type { JumpServerSftpEntry, JumpServerSftpEntryType } from './SftpTypes';

export type SftpMessageType = 'CONNECT' | 'CLOSE' | 'ERROR' | 'PING' | 'PONG' | 'SFTP_DATA' | 'SFTP_BINARY';
export type SftpCommand = 'list' | 'download' | 'upload' | 'rm' | 'rename' | 'mkdir';

export interface KokoSftpMessage {
  id?: string;
  type?: SftpMessageType | string;
  cmd?: SftpCommand | string;
  data?: string;
  raw?: unknown;
  err?: string;
  current_path?: string;
}

export function parseSftpMessage(input: Buffer | string): KokoSftpMessage {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('KoKo SFTP message is not an object.');
  }
  return parsed as KokoSftpMessage;
}

export function decodeSftpRaw(raw: unknown): Buffer {
  if (!raw) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'base64');
  }
  if (Array.isArray(raw)) {
    return Buffer.from(raw);
  }
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as { type?: unknown; data?: unknown };
    if (record.type === 'Buffer' && Array.isArray(record.data)) {
      return Buffer.from(record.data);
    }
  }
  return Buffer.from(String(raw), 'base64');
}

export function encodeSftpRaw(bytes: Buffer): string {
  return bytes.toString('base64');
}

export function normalizeSftpEntries(parentPath: string, value: unknown): JumpServerSftpEntry[] {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    .map((row) => normalizeSftpEntry(parentPath, row));
}

function normalizeSftpEntry(parentPath: string, row: Record<string, unknown>): JumpServerSftpEntry {
  const name = String(row.name || row.filename || '');
  const size = optionalNumber(row.size);
  const modifiedAt = optionalNumber(row.mod_time ?? row.modifiedAt ?? row.mtime);
  const type = entryType(row);
  return {
    name,
    path: joinRemotePath(parentPath || '/', name),
    type,
    ...(size === undefined ? {} : { size }),
    ...(modifiedAt === undefined ? {} : { modifiedAt })
  };
}

function entryType(row: Record<string, unknown>): JumpServerSftpEntryType {
  const rawType = String(row.type || '').toLowerCase();
  if (row.is_dir === true || rawType === 'dir' || rawType === 'directory') {
    return 'directory';
  }
  if (rawType === 'symlink' || rawType === 'link') {
    return 'symlink';
  }
  return 'file';
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
