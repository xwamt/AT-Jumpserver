import { describe, expect, it } from 'vitest';
import { dirname, joinRemotePath, remoteBasename } from '../../src/sftp/RemotePath';

describe('RemotePath', () => {
  it('joins POSIX paths without duplicate separators', () => {
    expect(joinRemotePath('/', 'app.txt')).toBe('/app.txt');
    expect(joinRemotePath('/home/deploy/', '/app.txt')).toBe('/home/deploy/app.txt');
  });

  it('returns parent directories', () => {
    expect(dirname('/home/deploy/app.txt')).toBe('/home/deploy');
    expect(dirname('/home')).toBe('/');
    expect(dirname('/')).toBe('/');
  });

  it('returns a safe basename fallback', () => {
    expect(remoteBasename('/home/deploy/app.txt')).toBe('app.txt');
    expect(remoteBasename('/')).toBe('remote-file');
  });
});
