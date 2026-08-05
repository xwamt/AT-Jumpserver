import { describe, expect, it } from 'vitest';
import {
  isBlockingRedisCommand,
  isReadOnlyRedisCommand
} from '../../src/agent/RedisSafety';

describe('RedisSafety', () => {
  it.each([
    'GET key',
    'MGET a b',
    'EXISTS k',
    'TTL k',
    'TYPE k',
    'HGETALL hash',
    'LRANGE list 0 -1',
    'SMEMBERS set',
    'ZRANGE z 0 -1',
    'PING',
    'INFO',
    'DBSIZE',
    'SCAN 0',
    'ECHO hello'
  ])('treats read-only command as safe: %s', (command) => {
    expect(isReadOnlyRedisCommand(command)).toBe(true);
    expect(isBlockingRedisCommand(command)).toBe(false);
  });

  it.each([
    'SET k v',
    'DEL k',
    'KEYS *',
    'FLUSHALL',
    'CONFIG GET maxmemory',
    'SELECT 1'
  ])('requires confirm for non-read-only command: %s', (command) => {
    expect(isReadOnlyRedisCommand(command)).toBe(false);
  });

  it.each([
    'SUBSCRIBE channel',
    'PSUBSCRIBE pattern*',
    'MONITOR',
    'BLPOP queue 0',
    'BRPOP queue 0',
    'XREAD BLOCK 1000 STREAMS s 0-0'
  ])('hard-rejects blocking command: %s', (command) => {
    expect(isBlockingRedisCommand(command)).toBe(true);
  });

  it('does not treat plain XREAD without BLOCK as blocking', () => {
    expect(isBlockingRedisCommand('XREAD COUNT 1 STREAMS s 0-0')).toBe(false);
  });
});
