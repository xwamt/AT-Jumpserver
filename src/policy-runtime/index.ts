import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PolicyAssetResolver,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyEvaluator
} from '@at-series/command-policy';
import { createShellPolicyEvaluator, warmupShellPolicyEvaluator } from '@at-series/command-policy/shell';
import { createMysqlPolicyEvaluator } from '@at-series/command-policy/mysql';
import { createRedisPolicyEvaluator } from '@at-series/command-policy/redis';

export interface JumpServerPolicyRuntimeOptions {
  readonly assetDirectory: string;
}

export interface JumpServerPolicyRuntime {
  evaluateShell(input: PolicyEvaluationInput): Promise<PolicyDecision>;
  evaluateMysql(input: PolicyEvaluationInput): Promise<PolicyDecision>;
  evaluateRedis(input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

export function createJumpServerPolicyRuntime(
  options: JumpServerPolicyRuntimeOptions
): JumpServerPolicyRuntime {
  const assetResolver: PolicyAssetResolver = (asset) =>
    readFile(join(options.assetDirectory, asset.fileName));
  // 首次 evaluate 的 Tree-sitter 冷启动约 18–20ms；warmup 失败可忽略，
  // evaluate 自身 fail closed 到 review。
  void warmupShellPolicyEvaluator({ assetResolver }).catch(() => {});
  let shell: PolicyEvaluator | undefined;
  let mysql: PolicyEvaluator | undefined;
  let redis: PolicyEvaluator | undefined;
  return {
    evaluateShell: (input) => (shell ??= createShellPolicyEvaluator({ assetResolver })).evaluate(input),
    evaluateMysql: (input) => (mysql ??= createMysqlPolicyEvaluator()).evaluate(input),
    evaluateRedis: (input) => (redis ??= createRedisPolicyEvaluator()).evaluate(input)
  };
}
