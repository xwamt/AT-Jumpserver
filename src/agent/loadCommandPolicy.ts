import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface CommandPolicyDecision {
  readonly action: 'allow' | 'review' | 'deny';
  readonly reasonCode: string;
  readonly evidence: readonly { readonly summary: string }[];
}

export interface CommandPolicyRuntime {
  evaluateShell(input: { sourceText: string; cwd?: string }): Promise<CommandPolicyDecision>;
  evaluateMysql(input: { sourceText: string; cwd?: string }): Promise<CommandPolicyDecision>;
  evaluateRedis(input: { sourceText: string; cwd?: string }): Promise<CommandPolicyDecision>;
}

/** 姊妹设计 §6.1 ShellPolicyEvaluate 的正式形状：三个域共用。 */
export type CommandPolicyEvaluate = (input: { command: string; cwd?: string }) => Promise<{
  action: 'allow' | 'review' | 'deny';
  riskSummaries: readonly string[];
  reasonCode: string;
}>;

const MAX_RISK_SUMMARIES = 3;

const INITIALIZATION_FAILED: CommandPolicyDecision = Object.freeze({
  action: 'review',
  reasonCode: 'policy.initialization_failed',
  evidence: Object.freeze([])
});

function createUnavailableRuntime(): CommandPolicyRuntime {
  const evaluate = async () => INITIALIZATION_FAILED;
  return { evaluateShell: evaluate, evaluateMysql: evaluate, evaluateRedis: evaluate };
}

type PolicyRuntimeLoader = () => CommandPolicyRuntime | Promise<CommandPolicyRuntime>;

let testLoader: PolicyRuntimeLoader | undefined;
let cached: Promise<CommandPolicyRuntime> | undefined;

export function setCommandPolicyLoaderForTests(loader: PolicyRuntimeLoader | undefined): void {
  testLoader = loader;
  cached = undefined;
}

export function resetCommandPolicyForTests(): void {
  testLoader = undefined;
  cached = undefined;
}

function loadBundledPolicyRuntime(): CommandPolicyRuntime {
  try {
    // 打进 dist/extension.js 后 __dirname === dist/，与 dist/policy-runtime.js、
    // dist/policy-assets 同级；非字面量路径 esbuild 不会内联。
    const require = createRequire(__filename);
    const runtime = require(join(__dirname, 'policy-runtime.js')) as {
      createJumpServerPolicyRuntime?: (options: { assetDirectory: string }) => CommandPolicyRuntime;
    };
    if (typeof runtime.createJumpServerPolicyRuntime !== 'function') {
      return createUnavailableRuntime();
    }
    return runtime.createJumpServerPolicyRuntime({
      assetDirectory: join(__dirname, 'policy-assets')
    });
  } catch {
    return createUnavailableRuntime();
  }
}

export async function loadCommandPolicyRuntime(): Promise<CommandPolicyRuntime> {
  cached ??= (async () => {
    if (testLoader) {
      return await testLoader();
    }
    return loadBundledPolicyRuntime();
  })();
  try {
    return await cached;
  } catch {
    cached = undefined;
    return createUnavailableRuntime();
  }
}

function isPolicyAction(value: unknown): value is CommandPolicyDecision['action'] {
  return value === 'allow' || value === 'review' || value === 'deny';
}

function toVerdict(decision: CommandPolicyDecision): Awaited<ReturnType<CommandPolicyEvaluate>> {
  if (!isPolicyAction(decision.action)) {
    return { action: 'review', reasonCode: 'policy.initialization_failed', riskSummaries: [] };
  }
  return {
    action: decision.action,
    reasonCode: decision.reasonCode,
    riskSummaries: decision.evidence
      .map((item) => item.summary)
      .filter((summary) => summary.length > 0)
      .slice(0, MAX_RISK_SUMMARIES)
  };
}

function createEvaluate(
  pick: (runtime: CommandPolicyRuntime) => CommandPolicyRuntime['evaluateShell']
): CommandPolicyEvaluate {
  return async (input) => {
    try {
      const runtime = await loadCommandPolicyRuntime();
      return toVerdict(await pick(runtime)({ sourceText: input.command, cwd: input.cwd }));
    } catch {
      return { action: 'review', reasonCode: 'policy.initialization_failed', riskSummaries: [] };
    }
  };
}

export const evaluateShellCommandPolicy: CommandPolicyEvaluate = createEvaluate((r) => r.evaluateShell.bind(r));
export const evaluateMysqlCommandPolicy: CommandPolicyEvaluate = createEvaluate((r) => r.evaluateMysql.bind(r));
export const evaluateRedisCommandPolicy: CommandPolicyEvaluate = createEvaluate((r) => r.evaluateRedis.bind(r));
