import { describe, expect, it } from 'vitest';
import { decodeSftpRaw, normalizeSftpEntries, parseSftpMessage } from '../../src/sftp/SftpProtocol';

describe('SftpProtocol', () => {
  it('parses JSON websocket messages', () => {
    expect(parseSftpMessage(Buffer.from('{"id":"1","type":"PING","data":"ping"}'))).toEqual({
      id: '1',
      type: 'PING',
      data: 'ping'
    });
  });

  it('decodes raw payloads from base64 strings and byte arrays', () => {
    expect(decodeSftpRaw(Buffer.from('hello').toString('base64')).equals(Buffer.from('hello'))).toBe(true);
    expect(decodeSftpRaw([104, 105]).equals(Buffer.from('hi'))).toBe(true);
    expect(decodeSftpRaw({ type: 'Buffer', data: [111, 107] }).equals(Buffer.from('ok'))).toBe(true);
  });

  it('normalizes KoKo SFTP file entries', () => {
    expect(normalizeSftpEntries('/home/deploy', [
      { name: 'app', is_dir: true, size: '', mod_time: '1714280000' },
      { name: 'readme.txt', is_dir: false, size: '12', mod_time: '1714280001' },
      { name: 'link', type: 'symlink', size: 1 }
    ])).toEqual([
      { name: 'app', path: '/home/deploy/app', type: 'directory', modifiedAt: 1714280000 },
      { name: 'readme.txt', path: '/home/deploy/readme.txt', type: 'file', size: 12, modifiedAt: 1714280001 },
      { name: 'link', path: '/home/deploy/link', type: 'symlink', size: 1 }
    ]);
  });
});
