const READ_ONLY_START = /^(select|show|describe|desc|explain)\b/i;
const UNSAFE_KEYWORDS = /\b(insert|update|delete|replace|create|alter|drop|truncate|call|grant|revoke|set|begin|commit|rollback|lock|unlock|load|source)\b/i;

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
