import type { CachedJumpServerAsset } from '../config/schema';

export type JumpServerSftpEntryType = 'file' | 'directory' | 'symlink';

export interface JumpServerSftpEntry {
  name: string;
  path: string;
  type: JumpServerSftpEntryType;
  size?: number;
  modifiedAt?: number;
}

export interface JumpServerSftpFileStat {
  size: number;
  modifiedAt: number;
}

export interface JumpServerSftpSnapshot {
  asset: CachedJumpServerAsset;
  rootPath: string;
  entries: JumpServerSftpEntry[];
}

export interface JumpServerSftpCommandProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}
