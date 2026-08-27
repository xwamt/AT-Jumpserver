import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsBridgePublisher } from '@at-series/mcp-hub';
import {
  BRIDGE_HEARTBEAT_FORCE_WRITE_INTERVAL_MS,
  BridgeServer,
  gcStaleBridgeRecords
} from '../../src/mcp/BridgeServer';
import { AT_JUMPSERVER_PLUGIN_ID } from '../../src/mcp/toolCatalog';

const tempRoots: string[] = [];
const servers: BridgeServer[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'at-jumpserver-bridge-publish-'));
  tempRoots.push(root);
  return root;
}

function createService(connectedTargets = 0) {
  return {
    listAssets: async () => ({ assets: [] }),
    getTerminalContext: vi.fn(async () => ({
      connectedTerminals: Array.from({ length: connectedTargets }, (_, i) => ({
        terminalId: `t${i}`
      })),
      knownTerminals: []
    })),
    sendTerminalInput: vi.fn(),
    runTerminalCommand: vi.fn(),
    sftpListDirectory: vi.fn(),
    sftpStatPath: vi.fn(),
    sftpReadFile: vi.fn(),
    sftpWriteFile: vi.fn(),
    sftpCreateFile: vi.fn(),
    sftpCreateDirectory: vi.fn(),
    sftpRename: vi.fn(),
    sftpDelete: vi.fn(),
    mysqlExecuteSql: vi.fn(),
    redisExecuteCommand: vi.fn()
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.dispose();
    }
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('BridgeServer FsBridgePublisher', () => {
  it('publishes registry under ~/.at-series/bridges/<hostApp>/ and removes on dispose', async () => {
    const home = await tempHome();
    const hostApp = 'cursor';
    const server = new BridgeServer({
      service: createService(2) as never,
      home,
      hostApp,
      pluginVersion: '0.3.0'
    });
    servers.push(server);

    await server.start();

    const bridgesDir = join(home, '.at-series', 'bridges', hostApp);
    const files = (await readdir(bridgesDir)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);

    const recordPath = join(bridgesDir, files[0]!);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      protocolVersion: number;
      bridgeId: string;
      pluginId: string;
      hostApp: string;
      port: number;
      token: string;
      pid: number;
      updatedAt: number;
      tools: unknown[];
      capabilities?: { connectedTargets?: number };
    };

    expect(record.protocolVersion).toBe(1);
    expect(record.pluginId).toBe(AT_JUMPSERVER_PLUGIN_ID);
    expect(record.hostApp).toBe(hostApp);
    expect(record.bridgeId).toBe(files[0]!.replace(/\.json$/, ''));
    expect(record.port).toBeGreaterThan(0);
    expect(record.token.length).toBeGreaterThan(0);
    expect(record.pid).toBe(process.pid);
    expect(record.updatedAt).toEqual(expect.any(Number));
    expect(record.tools.length).toBeGreaterThan(0);
    expect(record.capabilities?.connectedTargets).toBe(2);

    await server.dispose();
    servers.pop();

    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips heartbeat writes while connectedTargets is unchanged', async () => {
    vi.useFakeTimers();
    try {
      const home = await tempHome();
      const service = createService(1);
      const heartbeat = vi.fn(async () => {});
      const server = new BridgeServer({
        service: service as never,
        home,
        hostApp: 'cursor',
        pluginVersion: '0.3.0',
        createPublisher: () =>
          ({
            publish: vi.fn(async () => {}),
            unpublish: vi.fn(async () => {}),
            heartbeat
          }) as unknown as FsBridgePublisher
      });
      servers.push(server);
      await server.start();

      // Idle intervals with the same connectedTargets must not touch disk:
      // the hub's fs.watch would fire on every rewrite of an unchanged record.
      await vi.advanceTimersByTimeAsync(3 * 30_000);
      expect(heartbeat).not.toHaveBeenCalled();

      // A target change is written on the very next tick.
      service.getTerminalContext.mockImplementation(async () => ({
        connectedTerminals: [{ terminalId: 't0' }, { terminalId: 't1' }],
        knownTerminals: []
      }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(heartbeat).toHaveBeenCalledWith({ capabilities: { connectedTargets: 2 } });

      // Unchanged again: silent until the forced-write interval elapses, then
      // exactly one safety write goes out even though nothing changed.
      await vi.advanceTimersByTimeAsync(2 * 30_000);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(BRIDGE_HEARTBEAT_FORCE_WRITE_INTERVAL_MS);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back when publish fails so start() can be retried', async () => {
    const home = await tempHome();
    let publishCalls = 0;
    const server = new BridgeServer({
      service: createService() as never,
      home,
      hostApp: 'cursor',
      pluginVersion: '0.3.0',
      createPublisher: () =>
        ({
          publish: vi.fn(async () => {
            publishCalls += 1;
            if (publishCalls === 1) {
              throw new Error('publish failed');
            }
          }),
          unpublish: vi.fn(async () => {}),
          heartbeat: vi.fn(async () => {})
        }) as unknown as FsBridgePublisher
    });
    servers.push(server);

    await expect(server.start()).rejects.toThrow('publish failed');
    await expect(server.start()).resolves.toBeUndefined();
    expect(publishCalls).toBe(2);
  });
});

describe('gcStaleBridgeRecords', () => {
  function bridgeRecord(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      protocolVersion: 1,
      bridgeId: 'stale-bridge',
      pluginId: AT_JUMPSERVER_PLUGIN_ID,
      pluginDisplayName: 'AT JumpServer Terminal',
      pluginVersion: '0.1.9',
      hostApp: 'cursor',
      port: 43210,
      token: 'irrelevant',
      pid: 1,
      updatedAt: 1,
      tools: [],
      ...overrides
    });
  }

  it('unlinks only this plugin records whose pid is dead', async () => {
    const home = await tempHome();
    const dir = join(home, '.at-series', 'bridges', 'cursor');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ours-dead.json'), bridgeRecord({ pid: 111 }), 'utf8');
    await writeFile(join(dir, 'ours-alive.json'), bridgeRecord({ pid: process.pid }), 'utf8');
    await writeFile(
      join(dir, 'other-dead.json'),
      bridgeRecord({ pluginId: 'at.someother', pid: 111 }),
      'utf8'
    );
    await writeFile(join(dir, 'not-a-record.txt'), 'ignored', 'utf8');
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8');

    const removed = await gcStaleBridgeRecords({
      hostApp: 'cursor',
      home,
      isPidAlive: (pid) => pid === process.pid
    });

    expect(removed).toEqual(['ours-dead.json']);
    expect((await readdir(dir)).sort()).toEqual([
      'broken.json',
      'not-a-record.txt',
      'other-dead.json',
      'ours-alive.json'
    ]);
  });

  it('returns empty when the registry directory does not exist', async () => {
    const home = await tempHome();
    await expect(gcStaleBridgeRecords({ hostApp: 'cursor', home })).resolves.toEqual([]);
  });

  it('start() sweeps a crashed window record using the real pid probe', async () => {
    const home = await tempHome();
    const dir = join(home, '.at-series', 'bridges', 'cursor');
    await mkdir(dir, { recursive: true });
    // A process that has already exited: its pid is dead by the time we GC
    // (instant pid reuse would only make the record survive one more sweep).
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeFile(join(dir, 'crashed.json'), bridgeRecord({ pid: deadPid }), 'utf8');

    const server = new BridgeServer({
      service: createService() as never,
      home,
      hostApp: 'cursor',
      pluginVersion: '0.3.0'
    });
    servers.push(server);
    await server.start();

    const files = await readdir(dir);
    expect(files).not.toContain('crashed.json');
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });
});
