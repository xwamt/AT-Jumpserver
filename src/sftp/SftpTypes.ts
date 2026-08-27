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

export interface SftpListDirectoryOptions {
  /**
   * UI listings navigate: the listed directory becomes the session's working
   * directory. Programmatic lookups (MCP tools, stat) pass false so a
   * background listing never moves the Files view.
   */
  updateCurrentPath?: boolean;
  /** An explicit refresh must re-fetch even inside the short list-cache TTL. */
  bypassCache?: boolean;
}

export type SftpUploadProgress = (transferredBytes: number, totalBytes: number) => void;
