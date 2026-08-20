import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSelfAssetListPath,
  pageSignature,
  rewritePaginationRef,
  throttleWaitMs
} from '../../src/jumpserver/pagination';

describe('buildSelfAssetListPath', () => {
  it('asks JumpServer for the full effective asset list like the official skill', () => {
    expect(buildSelfAssetListPath(200, 0)).toBe(
      '/api/v1/perms/users/self/assets/?all=1&display=1&limit=200&offset=0'
    );
  });
});

describe('rewritePaginationRef', () => {
  it('rewrites a DRF next URL onto the configured origin', () => {
    expect(
      rewritePaginationRef(
        'https://jumpserver.example.com',
        'https://internal.example.com/api/v1/perms/users/self/assets/?all=1&limit=200&offset=200'
      )
    ).toBe('https://jumpserver.example.com/api/v1/perms/users/self/assets/?all=1&limit=200&offset=200');
  });

  it('keeps same-origin next URLs and relative paths', () => {
    expect(
      rewritePaginationRef(
        'https://jumpserver.example.com',
        '/api/v1/perms/users/self/assets/?offset=200'
      )
    ).toBe('https://jumpserver.example.com/api/v1/perms/users/self/assets/?offset=200');
  });
});

describe('pageSignature', () => {
  it('is stable for the same records and changes when an id changes', () => {
    const first = pageSignature([{ id: 'a' }, { id: 'b' }]);
    const second = pageSignature([{ id: 'a' }, { id: 'b' }]);
    const third = pageSignature([{ id: 'a' }, { id: 'c' }]);
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toBe(createHash('sha1').update(JSON.stringify([{ id: 'a' }, { id: 'b' }])).digest('hex'));
  });
});

describe('throttleWaitMs', () => {
  it('reads JumpServer retry hints and falls back to 5 seconds', () => {
    expect(throttleWaitMs('Expected available in 9 seconds.')).toBe(9000);
    expect(throttleWaitMs('slow down', { detail: 'Expected available in 3 second' })).toBe(3000);
    expect(throttleWaitMs('nope')).toBe(5000);
  });
});
