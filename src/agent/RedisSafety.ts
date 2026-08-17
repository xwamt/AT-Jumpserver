const BLOCKING_VERBS = new Set([
  'subscribe', 'psubscribe', 'ssubscribe',
  'unsubscribe', 'punsubscribe', 'sunsubscribe',
  'monitor',
  'blpop', 'brpop', 'brpoplpush', 'blmove', 'brmove',
  'bzpopmin', 'bzpopmax'
]);

const READ_ONLY_VERBS = new Set([
  'get', 'mget', 'exists', 'ttl', 'pttl', 'type', 'strlen', 'dump', 'object',
  'hget', 'hmget', 'hgetall', 'hexists', 'hlen', 'hkeys', 'hvals', 'hstrlen', 'hscan',
  'lrange', 'llen', 'lindex', 'lpos',
  'smembers', 'scard', 'sismember', 'smismember', 'srandmember', 'sscan',
  'zrange', 'zrangebyscore', 'zrangebylex', 'zrevrange', 'zrevrangebyscore',
  'zcard', 'zscore', 'zrank', 'zrevrank', 'zcount', 'zlexcount', 'zscan',
  'xlen', 'xinfo', 'xrange', 'xrevrange',
  'ping', 'echo', 'info', 'dbsize', 'time', 'role', 'lastsave',
  'scan'
]);

export function isBlockingRedisCommand(command: string): boolean {
  if (hasMultiLineRedisPayload(command)) {
    return true;
  }
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    return false;
  }
  const verb = tokens[0]!.toLowerCase();
  if (BLOCKING_VERBS.has(verb)) {
    return true;
  }
  if (verb === 'xread' || verb === 'xreadgroup') {
    return tokens.some((token) => token.toLowerCase() === 'block');
  }
  return false;
}

export function isReadOnlyRedisCommand(command: string): boolean {
  if (hasMultiLineRedisPayload(command)) {
    return false;
  }
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    return false;
  }
  const verb = tokens[0]!.toLowerCase();
  if (verb === 'memory') {
    const sub = tokens[1]?.toLowerCase();
    return sub === 'usage' || sub === 'stats' || sub === 'doctor' || sub === 'malloc-stats';
  }
  return READ_ONLY_VERBS.has(verb);
}

function hasMultiLineRedisPayload(command: string): boolean {
  return /[\r\n]/.test(normalizeRedisCommand(command));
}

function normalizeRedisCommand(command: string): string {
  return command.replace(/\r\n/g, '\n').trim();
}

function tokenize(command: string): string[] {
  return normalizeRedisCommand(command)
    .split(/\s+/)
    .filter(Boolean);
}
