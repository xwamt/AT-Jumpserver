import { describe, expect, it } from 'vitest';
import {
  assertTextFileEditable,
  DEFAULT_SFTP_EDIT_MAX_BYTES,
  isLikelyBinary,
  SftpFileGuardError
} from '../../src/sftp/SftpFileGuards';

describe('SftpFileGuards', () => {
  it('allows small text files', () => {
    expect(() => assertTextFileEditable({
      remotePath: '/tmp/app.conf',
      size: 128,
      sample: Buffer.from('PORT=8080\n')
    })).not.toThrow();
  });

  it('blocks files over the 1 MB default edit limit', () => {
    expect(() => assertTextFileEditable({
      remotePath: '/tmp/big.log',
      size: DEFAULT_SFTP_EDIT_MAX_BYTES + 1,
      sample: Buffer.from('text')
    })).toThrow(SftpFileGuardError);
  });

  it('detects null-byte binary content', () => {
    expect(isLikelyBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('blocks binary-like files with a download hint', () => {
    expect(() => assertTextFileEditable({
      remotePath: '/tmp/app.bin',
      size: 3,
      sample: Buffer.from([0x41, 0x00, 0x42])
    })).toThrow('Use Download instead.');
  });
});
