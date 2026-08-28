import { describe, expect, it, vi } from 'vitest';
import { authorizeAssetCommand, shouldAutoApproveSftpWrite } from '../../src/agent/assetCommandTrust';
import type { AssetCommandTrust } from '../../src/config/schema';

const verdict = (overrides: object = {}) => ({
  action: 'allow' as const,
  riskSummaries: [] as readonly string[],
  reasonCode: 'ok',
  ...overrides
});

function evaluatorSpies() {
  return {
    evaluateShellPolicy: vi.fn().mockResolvedValue(verdict()),
    evaluateMysqlPolicy: vi.fn().mockResolvedValue(verdict()),
    evaluateRedisPolicy: vi.fn().mockResolvedValue(verdict())
  };
}

const base = () => ({
  trust: 'policy' as AssetCommandTrust,
  kind: 'ssh' as const,
  command: 'uptime',
  ...evaluatorSpies()
});

describe('shouldAutoApproveSftpWrite', () => {
  it('auto-approves only under full trust', () => {
    expect(shouldAutoApproveSftpWrite('full')).toBe(true);
    expect(shouldAutoApproveSftpWrite('policy')).toBe(false);
    expect(shouldAutoApproveSftpWrite('none')).toBe(false);
  });
});

describe('authorizeAssetCommand', () => {
  it('full trust auto-approves without calling any evaluator', async () => {
    const options = { ...base(), trust: 'full' as const };
    await expect(authorizeAssetCommand(options)).resolves.toEqual({
      autoApprove: true,
      riskSummaries: []
    });
    expect(options.evaluateShellPolicy).not.toHaveBeenCalled();
    expect(options.evaluateMysqlPolicy).not.toHaveBeenCalled();
    expect(options.evaluateRedisPolicy).not.toHaveBeenCalled();
  });

  it('none trust requires confirmation without calling any evaluator', async () => {
    const options = { ...base(), trust: 'none' as const };
    await expect(authorizeAssetCommand(options)).resolves.toEqual({
      autoApprove: false,
      riskSummaries: []
    });
    expect(options.evaluateShellPolicy).not.toHaveBeenCalled();
    expect(options.evaluateMysqlPolicy).not.toHaveBeenCalled();
    expect(options.evaluateRedisPolicy).not.toHaveBeenCalled();
  });

  it('unknown trust values behave like none and never reach an evaluator', async () => {
    const options = { ...base(), trust: 'yolo' as AssetCommandTrust };
    await expect(authorizeAssetCommand(options)).resolves.toEqual({
      autoApprove: false,
      riskSummaries: []
    });
    expect(options.evaluateShellPolicy).not.toHaveBeenCalled();
    expect(options.evaluateMysqlPolicy).not.toHaveBeenCalled();
    expect(options.evaluateRedisPolicy).not.toHaveBeenCalled();
  });

  it('policy trust routes ssh through the shell evaluator with command and cwd unchanged', async () => {
    const options = { ...base(), kind: 'ssh' as const, command: 'uptime; df -h', cwd: '/srv' };
    await expect(authorizeAssetCommand(options)).resolves.toMatchObject({
      autoApprove: true,
      action: 'allow'
    });
    expect(options.evaluateShellPolicy).toHaveBeenCalledWith({ command: 'uptime; df -h', cwd: '/srv' });
    expect(options.evaluateMysqlPolicy).not.toHaveBeenCalled();
    expect(options.evaluateRedisPolicy).not.toHaveBeenCalled();
  });

  it('policy trust maps mysql onto the mysql policy evaluator', async () => {
    const allow = vi.fn().mockResolvedValue(verdict());
    const review = vi.fn().mockResolvedValue(
      verdict({
        action: 'review',
        riskSummaries: ['statement writes data'],
        reasonCode: 'policy.unknown_semantics'
      })
    );
    await expect(
      authorizeAssetCommand({ ...base(), evaluateMysqlPolicy: allow, kind: 'mysql', command: 'SELECT 1;' })
    ).resolves.toMatchObject({ autoApprove: true, action: 'allow' });
    expect(allow).toHaveBeenCalledWith({ command: 'SELECT 1;', cwd: undefined });

    await expect(
      authorizeAssetCommand({ ...base(), evaluateMysqlPolicy: review, kind: 'mysql', command: 'DROP TABLE t;' })
    ).resolves.toMatchObject({
      autoApprove: false,
      action: 'review',
      reasonCode: 'policy.unknown_semantics',
      riskSummaries: ['statement writes data']
    });
    expect(review).toHaveBeenCalledWith({ command: 'DROP TABLE t;', cwd: undefined });
  });

  it('policy trust maps redis onto the redis policy evaluator', async () => {
    const allow = vi.fn().mockResolvedValue(verdict());
    const review = vi.fn().mockResolvedValue(
      verdict({ action: 'review', riskSummaries: ['command mutates keys'], reasonCode: 'policy.unknown_semantics' })
    );
    const allowOptions = { ...base(), evaluateRedisPolicy: allow, kind: 'redis' as const, command: 'GET k' };
    await expect(authorizeAssetCommand(allowOptions)).resolves.toMatchObject({ autoApprove: true, action: 'allow' });
    expect(allow).toHaveBeenCalledWith({ command: 'GET k', cwd: undefined });
    expect(allowOptions.evaluateShellPolicy).not.toHaveBeenCalled();
    expect(allowOptions.evaluateMysqlPolicy).not.toHaveBeenCalled();

    await expect(
      authorizeAssetCommand({ ...base(), evaluateRedisPolicy: review, kind: 'redis', command: 'DEL k' })
    ).resolves.toMatchObject({
      autoApprove: false,
      action: 'review',
      riskSummaries: ['command mutates keys']
    });
  });

  it('deny verdicts are not auto-approved but still resolve so the caller can confirm', async () => {
    const deny = vi.fn().mockResolvedValue(
      verdict({ action: 'deny', riskSummaries: ['flushes the whole keyspace'], reasonCode: 'policy.destructive' })
    );
    await expect(
      authorizeAssetCommand({ ...base(), evaluateRedisPolicy: deny, kind: 'redis', command: 'FLUSHALL' })
    ).resolves.toEqual({
      autoApprove: false,
      action: 'deny',
      reasonCode: 'policy.destructive',
      riskSummaries: ['flushes the whole keyspace']
    });
  });

  it('evaluator failures degrade to review, never to allow', async () => {
    const broken = vi.fn().mockRejectedValue(new Error('module missing'));
    await expect(
      authorizeAssetCommand({ ...base(), evaluateRedisPolicy: broken, kind: 'redis', command: 'GET k' })
    ).resolves.toEqual({
      autoApprove: false,
      action: 'review',
      reasonCode: 'policy.initialization_failed',
      riskSummaries: []
    });
  });

  it('malformed evaluator actions are never auto-approved', async () => {
    const malformed = vi.fn().mockResolvedValue(verdict({ action: 'yolo', reasonCode: 'weird' }));
    await expect(
      authorizeAssetCommand({ ...base(), evaluateShellPolicy: malformed, command: 'uptime' })
    ).resolves.toEqual({
      autoApprove: false,
      reasonCode: 'policy.initialization_failed',
      riskSummaries: [],
      action: 'review'
    });
  });
});
