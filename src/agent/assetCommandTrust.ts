import type { AssetCommandTrust } from '../config/schema';
import type { CommandPolicyEvaluate } from './loadCommandPolicy';

/** 授权门结论（spec §4.2）：autoApprove=false 一律走确认弹窗，deny 也不静默拒绝。 */
export interface AssetCommandAuthorization {
  readonly autoApprove: boolean;
  readonly reasonCode?: string;
  readonly riskSummaries: readonly string[];
  readonly action?: 'allow' | 'review' | 'deny';
}

export function shouldAutoApproveSftpWrite(trust: AssetCommandTrust): boolean {
  return trust === 'full';
}

function isPolicyAction(value: unknown): value is 'allow' | 'review' | 'deny' {
  return value === 'allow' || value === 'review' || value === 'deny';
}

export async function authorizeAssetCommand(options: {
  trust: AssetCommandTrust;
  kind: 'ssh' | 'mysql' | 'redis';
  /** 将要执行的精确文本（spec §4.1）：ssh 传 normalizeShellCommand 结果、mysql 传 ensureSemicolon 结果、redis 传 trim 结果。 */
  command: string;
  cwd?: string;
  evaluateShellPolicy: CommandPolicyEvaluate;
  evaluateMysqlPolicy: CommandPolicyEvaluate;
  evaluateRedisPolicy: CommandPolicyEvaluate;
}): Promise<AssetCommandAuthorization> {
  if (options.trust === 'full') {
    return { autoApprove: true, riskSummaries: [] };
  }
  if (options.trust !== 'policy') {
    return { autoApprove: false, riskSummaries: [] };
  }

  const evaluate =
    options.kind === 'ssh'
      ? options.evaluateShellPolicy
      : options.kind === 'mysql'
        ? options.evaluateMysqlPolicy
        : options.evaluateRedisPolicy;

  try {
    const verdict = await evaluate({ command: options.command, cwd: options.cwd });
    if (!isPolicyAction(verdict.action)) {
      return {
        autoApprove: false,
        reasonCode: 'policy.initialization_failed',
        riskSummaries: [],
        action: 'review'
      };
    }
    return {
      autoApprove: verdict.action === 'allow',
      reasonCode: verdict.reasonCode,
      riskSummaries: verdict.riskSummaries,
      action: verdict.action
    };
  } catch {
    // 评估异常视同 review（spec §4.2），fail closed 到确认弹窗。
    return {
      autoApprove: false,
      reasonCode: 'policy.initialization_failed',
      riskSummaries: [],
      action: 'review'
    };
  }
}
