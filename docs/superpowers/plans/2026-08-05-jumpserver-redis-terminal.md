# JumpServer Redis Terminal And MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect JumpServer Redis assets through the existing xterm/`db_client` path, add `jumpserver_redis_execute_command`, and converge MCP list/send by deleting `jumpserver_mysql_get_context` / `jumpserver_mysql_send_input`.

**Architecture:** Minimal symmetric extension of the MySQL terminal path: classify Redis in `connectionTypes`, build Redis `db_client` tokens, reuse `TerminalPanel`/`JumpServerSession`, add `RedisSafety` + `RedisCliExecutor`, wire one new MCP execute tool, and delete the MySQL-only context/send tools so list/send stay unified.

**Tech Stack:** TypeScript, VS Code extension API, xterm.js webview, JumpServer REST + KoKo WebSocket, Vitest, AT Series MCP hub bridge.

**Spec:** `docs/superpowers/specs/2026-08-05-jumpserver-redis-terminal-design.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/jumpserver/connectionTypes.ts` | Add `redis` kind/protocol, `isRedisAsset`, labels, routing |
| `src/jumpserver/types.ts` | Add `'redis'` to `JumpServerConnectionProtocol` |
| `src/jumpserver/JumpServerClient.ts` | `DEFAULT_REDIS_CONNECT_OPTIONS`, `buildRedisConnectionTokenPayload`, branch in `buildConnectionTokenPayload` |
| `src/tree/TreeItems.ts` | `jumpserverRedisAsset` contextValue, Redis description/tooltip |
| `package.json` | Connect/copy menus include `jumpserverRedisAsset` |
| `src/agent/RedisSafety.ts` | Read-only / blocking / confirm helpers |
| `src/agent/TerminalExecutors.ts` | `RedisCliExecutor` with ECHO markers |
| `src/agent/JumpServerAgentToolService.ts` | `redisExecuteCommand`; remove `mysqlGetContext` / `mysqlSendInput` |
| `src/mcp/toolCatalog.ts` | Remove MySQL context/send entries; add Redis execute |
| `src/mcp/BridgeProtocol.ts` | Tool name union + request type |
| `src/mcp/bridgeSchemas.ts` | `redisExecuteCommandBridgeSchema` |
| `src/mcp/BridgeServer.ts` | Dispatch Redis execute; drop deleted MySQL tools |
| `skills/at-jumpserver-terminal-mcp/SKILL.md` | Tool table + workflow for Redis / unified list-send |
| Tests under `test/jumpserver`, `test/agent`, `test/mcp`, `test/tree`, `test/package.manifest.test.ts`, `test/docs` | Coverage for all of the above |

`JumpServerSession` / `TerminalPanel` / `extension.ts` already key off `connectionKind`; once kind=`redis` is connectable they should work with little or no structural change (verify titles and unsupported gate).

---

### Task 0: Confirm Redis `db_client` Connection Facts

**Files:**
- Read: `docs/superpowers/specs/2026-08-05-jumpserver-redis-terminal-design.md`
- Read: `src/jumpserver/JumpServerClient.ts` (MySQL `db_client` template)
- Optional write: `docs/superpowers/specs/2026-08-05-jumpserver-redis-terminal-task0-notes.md` (only if probe results differ from the starting payload)

- [ ] **Step 1: Orient on the approved payload**

Confirm the starting token shape from the spec:

```json
{
  "protocol": "redis",
  "connect_method": "db_client",
  "connect_options": {
    "token_reusable": false,
    "disableautohash": false
  }
}
```

Account field should follow MySQL: `account.alias || account.id`.

- [ ] **Step 2: Probe a real JumpServer Redis asset**

Using the same credentials already used for JumpServer manual testing in this repo:

1. Refresh assets and identify a Redis asset (`category`/`type`/`platform`/`protocolNames`).
2. Create a connection token with `protocol: "redis"` and `connect_method: "db_client"` (via temporary debug logging in `createConnectionToken`, JumpServer API client, or web Network tab while connecting in JumpServer UI if it uses the same method).
3. Open the KoKo redis-cli session and run:
   - `PING`
   - `ECHO __JMS_REDIS_START_probe__`
   - `ECHO __JMS_REDIS_END_probe__`
4. Record whether marker strings appear clearly in terminal output.

Expected: token succeeds; interactive redis-cli works; ECHO markers visible.

If credentials/assets are unavailable: continue unit implementation, but do **not** claim real Redis terminal verification complete, and leave Task 0 notes stating the gap.

If `db_client` is rejected for Redis: **stop** and revise the design before further connection work. Do not fall back to `web_gui`.

- [ ] **Step 3: Commit nothing for Task 0**

```powershell
git status --short
```

Expected: no new Task 0 commits required. Optional notes file may be untracked until you choose to commit it with later work.

---

### Task 1: Redis Connection Kind Detection

**Files:**
- Modify: `src/jumpserver/connectionTypes.ts`
- Modify: `test/jumpserver/connectionTypes.test.ts`

- [ ] **Step 1: Update failing expectations for Redis routing**

In `test/jumpserver/connectionTypes.test.ts`, change the unsupported Redis case and add Redis-specific coverage:

```ts
import { describe, expect, it } from 'vitest';
import {
  connectionKindLabel,
  connectionKindProtocol,
  getAssetConnectionKind,
  isDatabaseAsset,
  isMysqlAsset,
  isRedisAsset
} from '../../src/jumpserver/connectionTypes';

describe('connectionTypes', () => {
  it('detects MySQL assets from protocol and database metadata', () => {
    expect(isMysqlAsset({ protocolNames: ['mysql'] })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: 'mysql', platform: 'MySQL' })).toBe(true);
    expect(isMysqlAsset({ category: 'database', type: '', platform: '', name: 'prod-mariadb-01' })).toBe(true);
  });

  it('does not treat SSH hosts with mysql in their name as MySQL assets', () => {
    expect(isMysqlAsset({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'mysql-backup-host',
      protocolNames: ['ssh']
    })).toBe(false);
  });

  it('detects Redis assets from protocol and database metadata', () => {
    expect(isRedisAsset({ protocolNames: ['redis'] })).toBe(true);
    expect(isRedisAsset({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe(true);
    expect(isRedisAsset({ category: 'database', type: '', platform: '', name: 'cache-redis-01' })).toBe(true);
    expect(isDatabaseAsset({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe(true);
    expect(getAssetConnectionKind({ category: 'database', type: 'redis', platform: 'Redis6+' })).toBe('redis');
  });

  it('keeps non-Redis databases unsupported', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'postgresql',
      platform: 'PostgreSQL',
      protocolNames: ['postgresql']
    })).toBe('unsupported');
  });

  it('does not treat SSH hosts with redis in their name as Redis assets', () => {
    expect(isRedisAsset({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'redis-backup-host',
      protocolNames: ['ssh']
    })).toBe(false);
  });

  it('treats host server assets without cached protocols as SSH candidates', () => {
    expect(getAssetConnectionKind({
      category: 'host',
      type: 'server',
      platform: 'Linux',
      name: 'uat-service',
      protocolNames: []
    })).toBe('ssh');
  });

  it('routes MySQL before Redis/SSH when metadata is mixed', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'mysql',
      platform: 'MySQL',
      protocolNames: ['ssh']
    })).toBe('mysql');
  });

  it('routes Redis before SSH when metadata is mixed', () => {
    expect(getAssetConnectionKind({
      category: 'database',
      type: 'redis',
      platform: 'Redis',
      protocolNames: ['ssh', 'redis']
    })).toBe('redis');
  });

  it('maps supported connection kinds to labels and protocols', () => {
    expect(connectionKindLabel('ssh')).toBe('SSH');
    expect(connectionKindLabel('mysql')).toBe('MySQL');
    expect(connectionKindLabel('redis')).toBe('Redis');
    expect(connectionKindProtocol('ssh')).toBe('ssh');
    expect(connectionKindProtocol('mysql')).toBe('mysql');
    expect(connectionKindProtocol('redis')).toBe('redis');
    expect(() => connectionKindProtocol('unsupported')).toThrow('Unsupported JumpServer asset type.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npx vitest run test/jumpserver/connectionTypes.test.ts
```

Expected: FAIL (`isRedisAsset` missing and/or Redis still `unsupported`).

- [ ] **Step 3: Implement Redis classification**

Update `src/jumpserver/connectionTypes.ts`:

```ts
export type JumpServerConnectionKind = 'ssh' | 'mysql' | 'redis' | 'unsupported';
export type JumpServerConnectionProtocol = 'ssh' | 'mysql' | 'redis';

// keep AssetLikeForConnection and isDatabaseAsset (redis already listed)

export function isMysqlAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  if (hasMysqlMarker(values)) {
    return true;
  }
  return isDatabaseAsset(asset) && hasMysqlMarker([String(asset.name ?? '').toLowerCase()]);
}

export function isRedisAsset(asset: AssetLikeForConnection): boolean {
  const values = lowerValues(asset);
  if (hasRedisMarker(values)) {
    return true;
  }
  return isDatabaseAsset(asset) && hasRedisMarker([String(asset.name ?? '').toLowerCase()]);
}

export function getAssetConnectionKind(asset: AssetLikeForConnection): JumpServerConnectionKind {
  if (isMysqlAsset(asset)) {
    return 'mysql';
  }
  if (isRedisAsset(asset)) {
    return 'redis';
  }
  if (lowerProtocols(asset).includes('ssh') || isSshCandidateAsset(asset)) {
    return 'ssh';
  }
  return 'unsupported';
}

export function connectionKindLabel(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'MySQL';
  }
  if (kind === 'redis') {
    return 'Redis';
  }
  if (kind === 'ssh') {
    return 'SSH';
  }
  return 'Unsupported';
}

export function connectionKindProtocol(kind: JumpServerConnectionKind): JumpServerConnectionProtocol {
  if (kind === 'ssh' || kind === 'mysql' || kind === 'redis') {
    return kind;
  }
  throw new Error('Unsupported JumpServer asset type.');
}

function hasRedisMarker(values: string[]): boolean {
  return values.some((value) => value.includes('redis'));
}

// keep existing helpers: lowerValues, lowerProtocols, isSshCandidateAsset, hasMysqlMarker
```

Also add `'redis'` to `JumpServerConnectionProtocol` in `src/jumpserver/types.ts`:

```ts
export type JumpServerConnectionProtocol = 'ssh' | 'mysql' | 'redis' | 'sftp';
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
npx vitest run test/jumpserver/connectionTypes.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/jumpserver/connectionTypes.ts src/jumpserver/types.ts test/jumpserver/connectionTypes.test.ts
git commit -m "$(cat <<'EOF'
feat: classify JumpServer Redis assets as a connectable kind

EOF
)"
```

On Windows PowerShell without bash HEREDOC, use:

```powershell
git add src/jumpserver/connectionTypes.ts src/jumpserver/types.ts test/jumpserver/connectionTypes.test.ts
git commit -m "feat: classify JumpServer Redis assets as a connectable kind"
```

---

### Task 2: Redis Connection Token Payload

**Files:**
- Modify: `src/jumpserver/JumpServerClient.ts`
- Modify: `test/jumpserver/JumpServerClient.test.ts`
- Modify: `test/jumpserver/JumpServerSession.test.ts` (add Redis case mirroring MySQL)

- [ ] **Step 1: Write failing token tests**

Add to `test/jumpserver/JumpServerClient.test.ts` (import `buildRedisConnectionTokenPayload`):

```ts
it('builds Redis db_client connection-token payload with account alias', () => {
  expect(buildRedisConnectionTokenPayload({
    assetId: 'redis-1',
    account: { id: 'acc-1', alias: '@redis', username: 'redis' }
  })).toEqual({
    asset: 'redis-1',
    account: '@redis',
    protocol: 'redis',
    input_username: 'redis',
    input_secret: '',
    connect_method: 'db_client',
    connect_options: {
      token_reusable: false,
      disableautohash: false
    }
  });
});
```

Also assert `buildConnectionTokenPayload({ ..., protocol: 'redis' })` routes to the Redis builder.

Add a session test mirroring the MySQL db_client case: Redis kind creates token with `protocol: 'redis'` and `connect_method: 'db_client'`.

- [ ] **Step 2: Run failing tests**

```powershell
npx vitest run test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerSession.test.ts
```

Expected: FAIL (`buildRedisConnectionTokenPayload` missing).

- [ ] **Step 3: Implement Redis token builder**

In `JumpServerClient.ts`:

```ts
export const DEFAULT_REDIS_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export function buildConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  protocol: JumpServerConnectionProtocol;
}): Record<string, unknown> {
  if (input.protocol === 'mysql') {
    return buildMysqlConnectionTokenPayload(input);
  }
  if (input.protocol === 'redis') {
    return buildRedisConnectionTokenPayload(input);
  }
  if (input.protocol === 'sftp') {
    return buildSftpConnectionTokenPayload(input);
  }
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: input.protocol,
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'web_cli',
    connect_options: DEFAULT_CONNECT_OPTIONS
  };
}

export function buildRedisConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.alias || input.account.id,
    protocol: 'redis',
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'db_client',
    connect_options: DEFAULT_REDIS_CONNECT_OPTIONS
  };
}
```

If Task 0 proved different `connect_options`, use the verified set and keep tests aligned.

- [ ] **Step 4: Pass tests**

```powershell
npx vitest run test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerSession.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/jumpserver/JumpServerClient.ts test/jumpserver/JumpServerClient.test.ts test/jumpserver/JumpServerSession.test.ts
git commit -m "feat: build JumpServer Redis db_client connection tokens"
```

---

### Task 3: Tree UI And Connect Menus

**Files:**
- Modify: `src/tree/TreeItems.ts`
- Modify: `package.json` (connect + copyHostIp `when` clauses)
- Modify: `test/tree/JumpServerTreeProvider.test.ts` (and/or dedicated TreeItems expectations)
- Modify: `test/package.manifest.test.ts`
- Modify: `test/extension/ExtensionCommands.test.ts` if it still expects Redis connect to be blocked as unsupported

- [ ] **Step 1: Write failing UI/manifest expectations**

Assert Redis assets get:

- `contextValue === 'jumpserverRedisAsset'`
- description/tooltip include `Redis`
- `package.json` connect/copy menus include `viewItem == jumpserverRedisAsset`

Update any test that expected Redis connect to show "not supported yet" so Redis now opens like MySQL (only true unsupported DBs stay blocked).

- [ ] **Step 2: Run failing tests**

```powershell
npx vitest run test/package.manifest.test.ts test/tree test/extension/ExtensionCommands.test.ts
```

Expected: FAIL on Redis contextValue / menu / unsupported assumptions.

- [ ] **Step 3: Implement tree + menus**

`TreeItems.ts`:

```ts
this.tooltip = `${asset.name}${asset.address ? ` (${asset.address})` : ''}${
  kind === 'mysql' ? ' - MySQL' : kind === 'redis' ? ' - Redis' : ''
}`;

function contextValueForKind(kind: JumpServerConnectionKind): string {
  if (kind === 'mysql') {
    return 'jumpserverMysqlAsset';
  }
  if (kind === 'redis') {
    return 'jumpserverRedisAsset';
  }
  if (kind === 'ssh') {
    return 'jumpserverAsset';
  }
  return 'jumpserverUnsupportedAsset';
}

function assetDescription(asset: CachedJumpServerAsset, kind: JumpServerConnectionKind): string {
  const base = asset.address || asset.platform || (isDatabaseAsset(asset) ? asset.type : '');
  if (kind === 'mysql') {
    return base ? `${base} - MySQL` : 'MySQL';
  }
  if (kind === 'redis') {
    return base ? `${base} - Redis` : 'Redis';
  }
  return base;
}
```

`package.json` `when` clauses (connect + copyHostIp): add `|| viewItem == jumpserverRedisAsset`.

Confirm `TerminalPanel` titles use `connectionKindLabel` (already should become `JumpServer Redis: …`). Confirm `extension.ts` only blocks `unsupported` (Redis will pass through).

- [ ] **Step 4: Pass tests**

```powershell
npx vitest run test/package.manifest.test.ts test/tree test/extension/ExtensionCommands.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/tree/TreeItems.ts package.json test/package.manifest.test.ts test/tree test/extension/ExtensionCommands.test.ts
git commit -m "feat: expose Redis assets in JumpServer tree connect UI"
```

---

### Task 4: RedisSafety

**Files:**
- Create: `src/agent/RedisSafety.ts`
- Create: `test/agent/RedisSafety.test.ts`

- [ ] **Step 1: Write failing safety tests**

```ts
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
```

- [ ] **Step 2: Run failing test**

```powershell
npx vitest run test/agent/RedisSafety.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `RedisSafety.ts`**

```ts
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

function tokenize(command: string): string[] {
  return command
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
```

Expand the read-only set if unit tests from the spec whitelist need more verbs; keep `KEYS` off the whitelist.

- [ ] **Step 4: Pass tests**

```powershell
npx vitest run test/agent/RedisSafety.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/agent/RedisSafety.ts test/agent/RedisSafety.test.ts
git commit -m "feat: add Redis command safety heuristics for MCP execute"
```

---

### Task 5: RedisCliExecutor

**Files:**
- Modify: `src/agent/TerminalExecutors.ts`
- Modify: `test/agent/TerminalExecutors.test.ts`

- [ ] **Step 1: Write failing executor test**

```ts
it('wraps Redis commands with ECHO markers and returns inner output', async () => {
  const output = new TerminalOutputBuffer();
  const write = vi.fn((input: string) => {
    expect(input).toContain("ECHO __JMS_REDIS_START_abc__");
    expect(input).toContain('PING');
    expect(input).toContain("ECHO __JMS_REDIS_END_abc__");
    output.append(input);
    output.append('__JMS_REDIS_START_abc__\n');
    output.append('PONG\n');
    output.append('__JMS_REDIS_END_abc__\n');
  });
  const executor = new RedisCliExecutor({ idFactory: () => 'abc' });

  await expect(executor.execute({
    terminalId: 'terminal-1',
    assetId: 'redis-1',
    assetName: 'redis-1',
    command: 'PING',
    write,
    output,
    timeoutMs: 1000,
    maxOutputBytes: 1024
  })).resolves.toMatchObject({
    terminalId: 'terminal-1',
    command: 'PING',
    output: expect.stringContaining('PONG'),
    timedOut: false,
    truncated: false
  });
});
```

- [ ] **Step 2: Run failing test**

```powershell
npx vitest run test/agent/TerminalExecutors.test.ts
```

Expected: FAIL (`RedisCliExecutor` missing).

- [ ] **Step 3: Implement executor**

Add types + class to `TerminalExecutors.ts` (reuse existing `clamp`, `stripAnsi`, `trimBeforeMarker`):

```ts
export interface RedisCommandExecutionInput extends TerminalExecutionTarget {
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RedisCommandExecutionResult {
  terminalId: string;
  assetId: string;
  assetName: string;
  command: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export class RedisCliExecutor {
  constructor(private readonly options: { idFactory?: () => string } = {}) {}

  async execute(input: RedisCommandExecutionInput): Promise<RedisCommandExecutionResult> {
    const id = this.options.idFactory?.() ?? randomUUID().replaceAll('-', '');
    const startMarker = `__JMS_REDIS_START_${id}__`;
    const endMarker = `__JMS_REDIS_END_${id}__`;
    const timeoutMs = clamp(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clamp(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();
    const collection = input.output.collectUntil({
      marker: endMarker,
      isComplete: (text) => {
        const start = text.indexOf(startMarker);
        return start >= 0 && text.indexOf(endMarker, start + startMarker.length) >= 0;
      },
      findTerminatorIndex: (text) => {
        const start = text.indexOf(startMarker);
        if (start < 0) {
          return -1;
        }
        return text.indexOf(endMarker, start + startMarker.length);
      },
      timeoutMs,
      maxOutputBytes
    });
    const command = input.command.trim();
    input.write(
      `ECHO ${startMarker}\n` +
      `${command}\n` +
      `ECHO ${endMarker}\n`
    );
    const collected = await collection;
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      command,
      output: stripAnsi(trimBeforeMarker(collected.output, startMarker)),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated
    };
  }
}
```

If Task 0 required a different marker command, substitute it here without changing MCP tool names/args.

- [ ] **Step 4: Pass tests**

```powershell
npx vitest run test/agent/TerminalExecutors.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/agent/TerminalExecutors.ts test/agent/TerminalExecutors.test.ts
git commit -m "feat: add RedisCliExecutor with ECHO output markers"
```

---

### Task 6: Agent Tool Service — Redis Execute + Delete MySQL List/Send

**Files:**
- Modify: `src/agent/JumpServerAgentToolService.ts`
- Modify: `test/agent/JumpServerAgentToolService.test.ts`

- [ ] **Step 1: Write failing agent tests**

1. Remove/replace tests for `mysqlGetContext` / `mysqlSendInput`.
2. Add Redis execute tests:
   - read-only `PING` skips confirm
   - `SET` requires confirm
   - `SUBSCRIBE` throws before write / confirm
   - wrong kind (SSH active) throws "Redis terminal is required"
3. Keep `sendTerminalInput` covering Redis terminals (confirm + write) to prove unified send-input.

Example assertions:

```ts
it('executes read-only Redis commands without confirmation', async () => {
  // active redis terminal + output buffer
  // confirm should not be called for PING
});

it('rejects blocking Redis commands before writing', async () => {
  await expect(service.redisExecuteCommand({ command: 'SUBSCRIBE ch' }))
    .rejects.toThrow(/blocking|SUBSCRIBE|send_terminal_input/i);
  expect(write).not.toHaveBeenCalled();
});

it('does not expose mysqlGetContext/mysqlSendInput', () => {
  expect('mysqlGetContext' in service).toBe(false);
  expect('mysqlSendInput' in service).toBe(false);
});
```

- [ ] **Step 2: Run failing tests**

```powershell
npx vitest run test/agent/JumpServerAgentToolService.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement service changes**

In `JumpServerAgentToolService.ts`:

- Import `RedisCliExecutor`, `isBlockingRedisCommand`, `isReadOnlyRedisCommand`.
- Add `private readonly redisExecutor = new RedisCliExecutor()`.
- Delete `mysqlGetContext` and `mysqlSendInput` methods entirely.
- Add:

```ts
async redisExecuteCommand(input: {
  terminalId?: string;
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}) {
  const command = input.command?.trim();
  if (!command) {
    throw new Error('Redis command cannot be empty.');
  }
  if (isBlockingRedisCommand(command)) {
    throw new Error(
      'Blocking Redis commands are not supported via jumpserver_redis_execute_command. ' +
      'Use the open Redis terminal with jumpserver_send_terminal_input instead.'
    );
  }
  const target = this.resolveTerminal(input.terminalId);
  if (getAssetConnectionKind(target.asset) !== 'redis') {
    throw new Error('A connected JumpServer Redis terminal is required.');
  }
  if (!isReadOnlyRedisCommand(command)) {
    const ok = await this.dependencies.confirm(
      `Run state-changing Redis command on ${target.asset.name}?\n\n${command}`
    );
    if (!ok) {
      throw new Error('Redis command execution was cancelled.');
    }
  }
  return await this.enqueueTerminal(target.terminalId, async () => {
    const liveTarget = this.resolveTerminal(target.terminalId);
    const output = this.requireOutput(liveTarget.terminalId);
    return await this.redisExecutor.execute({
      terminalId: liveTarget.terminalId,
      assetId: liveTarget.asset.id,
      assetName: liveTarget.asset.name,
      command,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      write: liveTarget.write,
      output
    });
  });
}
```

- [ ] **Step 4: Pass tests**

```powershell
npx vitest run test/agent/JumpServerAgentToolService.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/agent/JumpServerAgentToolService.ts test/agent/JumpServerAgentToolService.test.ts
git commit -m "feat: add redis execute MCP path and drop MySQL-only list/send helpers"
```

---

### Task 7: MCP Catalog, Protocol, Schemas, Bridge

**Files:**
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/mcp/BridgeProtocol.ts`
- Modify: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/BridgeServer.ts`
- Modify: `test/mcp/toolCatalog.test.ts`
- Modify: `test/mcp/BridgeServer.test.ts`
- Modify: `test/mcp/bridgePublish.test.ts`
- Modify: `test/mcp/p0c.functional.e2e.test.ts` if it references deleted tools

- [ ] **Step 1: Write failing catalog/bridge expectations**

- `JUMPSERVER_MCP_TOOL_NAMES` / catalog must include `jumpserver_redis_execute_command`
- must **not** include `jumpserver_mysql_get_context` or `jumpserver_mysql_send_input`
- Bridge mocks/services drop `mysqlGetContext` / `mysqlSendInput`, add `redisExecuteCommand`
- Risk: Redis execute = `exec`

- [ ] **Step 2: Run failing MCP tests**

```powershell
npx vitest run test/mcp
```

Expected: FAIL on old tool names / missing redis tool.

- [ ] **Step 3: Wire MCP surface**

`BridgeProtocol.ts` tool list becomes:

```ts
export const JUMPSERVER_MCP_TOOL_NAMES = [
  'jumpserver_list_assets',
  'jumpserver_get_terminal_context',
  'jumpserver_send_terminal_input',
  'jumpserver_run_terminal_command',
  'jumpserver_sftp_list_directory',
  'jumpserver_sftp_stat_path',
  'jumpserver_sftp_read_file',
  'jumpserver_sftp_write_file',
  'jumpserver_sftp_create_file',
  'jumpserver_sftp_create_directory',
  'jumpserver_sftp_rename',
  'jumpserver_sftp_delete',
  'jumpserver_mysql_execute_sql',
  'jumpserver_redis_execute_command'
] as const;
```

Add request type:

```ts
export interface RedisExecuteCommandBridgeRequest {
  terminalId?: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
```

`bridgeSchemas.ts`:

```ts
export const redisExecuteCommandBridgeSchema = z
  .object({
    ...terminalTargetFields,
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional()
  })
  .strict();
```

Remove `mysqlSendInputBridgeSchema` if unused, keep `mysqlExecuteSqlBridgeSchema`.

`toolCatalog.ts`: delete MySQL get-context/send-input entries; append:

```ts
{
  name: 'jumpserver_redis_execute_command',
  title: 'JumpServer Redis Execute Command',
  description:
    'Execute one non-blocking Redis command through an existing connected JumpServer Redis CLI terminal. ' +
    'Prefer narrow keys and SCAN over KEYS. Output defaults to 64KB (hard max 256KB). ' +
    'Blocking commands (SUBSCRIBE/MONITOR/BLPOP/…) are rejected; use jumpserver_send_terminal_input for those.',
  risk: 'exec',
  inputSchema: {
    type: 'object',
    properties: {
      ...terminalIdProperty,
      command: {
        type: 'string',
        description: 'Single Redis command, e.g. GET mykey or HGETALL user:1'
      },
      timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
      maxOutputBytes: {
        type: 'number',
        description: 'Optional max bytes of output to capture (default 64KB, hard max 256KB).'
      }
    },
    required: ['command']
  }
}
```

Also tighten `jumpserver_get_terminal_context` / `jumpserver_send_terminal_input` descriptions to mention SSH/MySQL/Redis if they currently sound SSH-only.

`BridgeServer.ts`: remove mysql get/send cases; add:

```ts
case 'jumpserver_redis_execute_command': {
  const parsed = parseArgsWithSchema(args, redisExecuteCommandBridgeSchema);
  if (!parsed.ok) {
    return { ok: false, response: bridgeError(422, 'VALIDATION_ERROR', parsed.error) };
  }
  return { ok: true, value: await service.redisExecuteCommand(parsed.data) };
}
```

Update bridge test service stubs accordingly.

- [ ] **Step 4: Pass MCP tests**

```powershell
npx vitest run test/mcp
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/mcp test/mcp
git commit -m "feat: publish Redis execute MCP tool and remove MySQL list/send tools"
```

---

### Task 8: Skill And Docs Contract

**Files:**
- Modify: `skills/at-jumpserver-terminal-mcp/SKILL.md`
- Modify: `test/docs/JumpServerMcpDocs.test.ts`
- Modify: `README.md` only if it documents MySQL-only MCP tools that must change
- If `scripts/copy-hub.mjs` copies the skill into a hub package, update that path too when present

- [ ] **Step 1: Write failing docs assertions**

```ts
it('documents JumpServer-specific MCP tool workflow in the skill', async () => {
  const text = await readFile('skills/at-jumpserver-terminal-mcp/SKILL.md', 'utf8');
  expect(text).toContain('jumpserver_get_terminal_context');
  expect(text).toContain('jumpserver_send_terminal_input');
  expect(text).toContain('jumpserver_mysql_execute_sql');
  expect(text).toContain('jumpserver_redis_execute_command');
  expect(text).not.toContain('jumpserver_mysql_get_context');
  expect(text).not.toContain('jumpserver_mysql_send_input');
});
```

- [ ] **Step 2: Run failing test**

```powershell
npx vitest run test/docs/JumpServerMcpDocs.test.ts
```

Expected: FAIL until skill updated.

- [ ] **Step 3: Update skill**

Tool selection table should look like:

| Need | Use |
| --- | --- |
| List JumpServer assets | `jumpserver_list_assets` |
| Resolve terminals (SSH/MySQL/Redis) | `jumpserver_get_terminal_context` |
| Send interactive terminal input | `jumpserver_send_terminal_input` |
| Run non-interactive SSH command | `jumpserver_run_terminal_command` |
| … SFTP … | … |
| Execute SQL | `jumpserver_mysql_execute_sql` |
| Execute Redis command | `jumpserver_redis_execute_command` |

Workflow notes:

- Prefer `jumpserver_redis_execute_command` for single non-blocking commands; use send-input for interactive/blocking cases.
- Filter `connectionKind === "mysql"` / `"redis"` from `get_terminal_context` when targeting DB sessions.
- Payload discipline: Redis commands default 64KB / max 256KB; avoid `KEYS *`.

Description frontmatter: mention Redis CLI as well as MySQL.

- [ ] **Step 4: Pass docs tests + full unit suite**

```powershell
npx vitest run test/docs/JumpServerMcpDocs.test.ts
npx vitest run
```

Expected: PASS (fix any stragglers referencing deleted tools).

- [ ] **Step 5: Commit**

```powershell
git add skills/at-jumpserver-terminal-mcp/SKILL.md test/docs/JumpServerMcpDocs.test.ts README.md
git commit -m "docs: document Redis MCP execute and unified terminal list/send"
```

---

### Task 9: Manual Acceptance (after unit green)

**Files:** none required (optional Task 0 notes update)

- [ ] **Step 1: Manual Redis terminal**

1. Launch extension against real JumpServer.
2. Confirm Redis asset shows Redis label and connects.
3. Panel title `JumpServer Redis: …`.
4. Run `PING`, `SET`/`GET`, resize, disconnect, reconnect.
5. Confirm PostgreSQL/other unsupported DB still blocked.

- [ ] **Step 2: Manual MCP**

1. `at_select_tools` → `at.jumpserver`.
2. `tools/list`: has `jumpserver_redis_execute_command`; lacks mysql get-context/send-input.
3. Connect Redis in IDE; `get_terminal_context` shows `connectionKind: "redis"`.
4. `redis_execute_command` with `PING` succeeds.
5. Write command prompts confirm.
6. `SUBSCRIBE` rejected without poisoning the session.
7. `send_terminal_input` still works on Redis after confirm.
8. SSH + MySQL smoke still pass.

- [ ] **Step 3: No commit unless notes changed**

If Task 0 notes were written/updated, commit them:

```powershell
git add docs/superpowers/specs/2026-08-05-jumpserver-redis-terminal-task0-notes.md
git commit -m "docs: record Redis db_client Task 0 probe results"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
| --- | --- |
| Redis xterm + `db_client`, no GUI | 0, 2, 3, 9 |
| Asset recognition MySQL-symmetric | 1 |
| Tree `jumpserverRedisAsset` + title | 3 |
| Account/DB no picker | 2 (alias path), 9 |
| Unified `get_terminal_context` | already true; 6–8 remove mysql filter tool |
| Unified `send_terminal_input`; delete mysql send | 6, 7, 8 |
| Delete `mysql_get_context` | 6, 7, 8 |
| `jumpserver_redis_execute_command` | 5, 6, 7 |
| Read-only confirm policy + `KEYS` not read-only | 4, 6 |
| Blocking hard reject | 4, 6 |
| ECHO markers | 0, 5 |
| Same delivery / skill update | 7, 8, 9 |
| No SFTP for Redis | 3 (menus/connect only; SFTP gate remains SSH) |
| Capture limits 64KB/30s | 5 (shared clamps) |

## Placeholder / Consistency Review

- No TBD implementation steps; Task 0 may produce optional notes if payload differs.
- Method name locked: `redisExecuteCommand` / tool `jumpserver_redis_execute_command`.
- Markers locked: `__JMS_REDIS_START_<id>__` / `__JMS_REDIS_END_<id>__` unless Task 0 substitutes the carrier command only.
- Context value locked: `jumpserverRedisAsset`.
