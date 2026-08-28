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

/**
 * Hard reject for commands that would park the CLI collector forever
 * (SUBSCRIBE/MONITOR/BLPOP/…). Runs BEFORE any trust or policy evaluation
 * and at every trust level, including full: this is an execution-domain
 * contract, not a policy question (spec D8).
 */
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

/**
 * Confirmation-wording selector only ('Run JumpServer Redis command' vs
 * 'Run state-changing Redis command'). This heuristic no longer grants any
 * auto-approval: the confirmation gate is authorizeAssetCommand
 * (src/agent/assetCommandTrust.ts), which under limited trust defers to
 * the @at-series/command-policy redis evaluator (spec D8).
 */
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
