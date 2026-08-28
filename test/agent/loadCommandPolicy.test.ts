import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateMysqlCommandPolicy,
  evaluateShellCommandPolicy,
  loadCommandPolicyRuntime,
  resetCommandPolicyForTests,
  setCommandPolicyLoaderForTests
} from '../../src/agent/loadCommandPolicy';

afterEach(() => resetCommandPolicyForTests());

const decision = (overrides: object = {}) => ({
  action: 'allow' as const,
  reasonCode: 'x',
  evidence: [],
  ...overrides
});

const runtimeWith = (result: unknown) => ({
  evaluateShell: vi.fn().mockResolvedValue(result),
  evaluateMysql: vi.fn().mockResolvedValue(result),
  evaluateRedis: vi.fn().mockResolvedValue(result)
});

describe('loadCommandPolicyRuntime', () => {
  it('caches the loader across calls', async () => {
    const loader = vi.fn(() => runtimeWith(decision()));
    setCommandPolicyLoaderForTests(loader);
    await loadCommandPolicyRuntime();
    await loadCommandPolicyRuntime();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('fails closed to review when the loader throws', async () => {
    setCommandPolicyLoaderForTests(() => {
      throw new Error('boom');
    });
    const runtime = await loadCommandPolicyRuntime();
    const result = await runtime.evaluateShell({ sourceText: 'uptime' });
    expect(result.action).toBe('review');
    expect(result.reasonCode).toBe('policy.initialization_failed');
  });

  it('fails closed when the bundled runtime is missing (vitest has no dist/)', async () => {
    const runtime = await loadCommandPolicyRuntime();
    expect((await runtime.evaluateRedis({ sourceText: 'GET k' })).action).toBe('review');
  });
});

describe('evaluate*CommandPolicy adapters', () => {
  it('maps command to sourceText and flattens evidence into riskSummaries', async () => {
    const runtime = runtimeWith(decision({
      action: 'review',
      reasonCode: 'policy.unknown_semantics',
      evidence: [{ summary: 'a' }, { summary: '' }, { summary: 'b' }, { summary: 'c' }, { summary: 'd' }]
    }));
    setCommandPolicyLoaderForTests(() => runtime);
    const verdict = await evaluateShellCommandPolicy({ command: 'tee /etc/x', cwd: '/srv' });
    expect(runtime.evaluateShell).toHaveBeenCalledWith({ sourceText: 'tee /etc/x', cwd: '/srv' });
    expect(verdict).toEqual({
      action: 'review',
      reasonCode: 'policy.unknown_semantics',
      riskSummaries: ['a', 'b', 'c']   // 去空串、截 3 条
    });
  });

  it('fails closed on malformed actions', async () => {
    setCommandPolicyLoaderForTests(() => runtimeWith(decision({ action: 'yolo' })));
    const verdict = await evaluateMysqlCommandPolicy({ command: 'SELECT 1;' });
    expect(verdict.action).toBe('review');
    expect(verdict.reasonCode).toBe('policy.initialization_failed');
  });
});
