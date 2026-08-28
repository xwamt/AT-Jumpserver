const READ_ONLY_START = /^(select|show|describe|desc|explain)\b/i;
const UNSAFE_KEYWORDS = /\b(insert|update|delete|replace|create|alter|drop|truncate|call|grant|revoke|set|begin|commit|rollback|lock|unlock|load|source)\b/i;

/**
 * Confirmation-wording selector only ('Run JumpServer MySQL SQL' vs
 * 'Run state-changing MySQL SQL'). This heuristic no longer grants any
 * auto-approval: the confirmation gate is authorizeAssetCommand
 * (src/agent/assetCommandTrust.ts), which under limited trust defers to
 * the @at-series/command-policy mysql evaluator (spec D8).
 */
export function isReadOnlySql(sql: string): boolean {
  const stripped = stripSqlComments(sql).trim();
  if (!stripped) {
    return false;
  }
  if (UNSAFE_KEYWORDS.test(stripped)) {
    return false;
  }
  return READ_ONLY_START.test(stripped);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/#[^\n\r]*/g, ' ');
}
