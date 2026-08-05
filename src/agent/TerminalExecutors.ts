import { randomUUID } from 'node:crypto';
import type { TerminalOutputBuffer } from './TerminalOutputBuffer';

export interface TerminalExecutionTarget {
  terminalId: string;
  assetId: string;
  assetName: string;
  write(data: string): void;
  output: TerminalOutputBuffer;
}

export interface ShellCommandExecutionInput extends TerminalExecutionTarget {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ShellCommandExecutionResult {
  terminalId: string;
  assetId: string;
  assetName: string;
  command: string;
  cwd?: string;
  stdout: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface MysqlSqlExecutionInput extends TerminalExecutionTarget {
  sql: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface MysqlSqlExecutionResult {
  terminalId: string;
  assetId: string;
  assetName: string;
  sql: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128_000;
const MAX_OUTPUT_BYTES = 512_000;

export class ShellTerminalExecutor {
  constructor(private readonly options: { idFactory?: () => string } = {}) {}

  async execute(input: ShellCommandExecutionInput): Promise<ShellCommandExecutionResult> {
    const id = this.options.idFactory?.() ?? randomUUID().replaceAll('-', '');
    const startMarker = `__JMS_CMD_START_${id}__`;
    const endMarker = `__JMS_CMD_END_${id}__`;
    const timeoutMs = clamp(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clamp(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();

    const command = wrapShellCommand(input.command, input.cwd, id);
    const endWithCode = new RegExp(`${escapeRegExp(endMarker)}\\d+`);
    // Require the real start marker before the end+exit-code terminator so echo of
    // the wrapper line cannot complete collection early.
    const collection = input.output.collectUntil({
      marker: endMarker,
      isComplete: (text) => {
        const start = text.indexOf(startMarker);
        if (start < 0) {
          return false;
        }
        return endWithCode.test(text.slice(start));
      },
      findTerminatorIndex: (text) => {
        const start = text.indexOf(startMarker);
        if (start < 0) {
          return -1;
        }
        const match = endWithCode.exec(text.slice(start));
        return match ? start + match.index : -1;
      },
      timeoutMs,
      maxOutputBytes
    });
    input.write(command);
    const collected = await collection;
    const stdout = stripAnsi(trimBeforeMarker(collected.output, startMarker));
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      command: input.command,
      cwd: input.cwd,
      stdout,
      exitCode: parseExitCode(collected.terminator ?? collected.output, endMarker),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated
    };
  }
}

export class MysqlCliExecutor {
  constructor(private readonly options: { idFactory?: () => string } = {}) {}

  async execute(input: MysqlSqlExecutionInput): Promise<MysqlSqlExecutionResult> {
    const id = this.options.idFactory?.() ?? randomUUID().replaceAll('-', '');
    const startMarker = `__JMS_SQL_START_${id}__`;
    const endMarker = `__JMS_SQL_END_${id}__`;
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
    // Build markers with CONCAT so typed/echoed SQL does not contain the full marker string.
    // Keep on as few lines as possible: start, SQL, end.
    input.write(
      `SELECT CONCAT('__JMS_SQL_START_', '${escapeSqlLiteral(id)}', '__');\n` +
      `${ensureSemicolon(input.sql)}\n` +
      `SELECT CONCAT('__JMS_SQL_END_', '${escapeSqlLiteral(id)}', '__');\n`
    );
    const collected = await collection;
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      sql: input.sql,
      output: stripAnsi(trimBeforeMarker(collected.output, startMarker)),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated
    };
  }
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
        const start = findStandaloneRedisMarker(text, startMarker);
        return start >= 0 && findStandaloneRedisMarker(text, endMarker, start + startMarker.length) >= 0;
      },
      findTerminatorIndex: (text) => {
        const start = findStandaloneRedisMarker(text, startMarker);
        if (start < 0) {
          return -1;
        }
        return findStandaloneRedisMarker(text, endMarker, start + startMarker.length);
      },
      timeoutMs,
      maxOutputBytes
    });
    const command = input.command.trim();
    // redis-cli submits on CR; LF-only writes stick in the edit buffer and never execute.
    input.write(
      `ECHO ${startMarker}\r` +
      `${command}\r` +
      `ECHO ${endMarker}\r`
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

/**
 * One shell prompt entry per MCP confirmation: start marker + command + end marker.
 * Marker fragments stay split across printf args so echo cannot satisfy collectors.
 */
export function wrapShellCommand(command: string, cwd: string | undefined, id: string): string {
  const normalized = normalizeShellCommand(command);
  const script = cwd?.trim()
    ? `cd ${quotePosix(cwd.trim())} && eval ${quotePosix(normalized)}`
    : `eval ${quotePosix(normalized)}`;
  return (
    `printf '\\n%s%s%s\\n' '__JMS_CMD_START_' ${quotePosix(id)} '__'; ` +
    `${script}; ` +
    `printf '\\n%s%s%d\\n' '__JMS_CMD_END_' ${quotePosix(id)}'__' "$?";\n`
  );
}

/** Drop comment-only lines and join onto one shell line (avoids PS2 continuations). */
export function normalizeShellCommand(command: string): string {
  const lines = command
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return lines.join('; ');
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function trimBeforeMarker(text: string, marker: string): string {
  // Prefer the last start marker (executed printf/SELECT output) over an earlier echo.
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

/** Skip markers embedded in typed `ECHO <marker>` lines; match ECHO response lines only. */
function findStandaloneRedisMarker(text: string, marker: string, fromIndex = 0): number {
  let index = text.indexOf(marker, fromIndex);
  while (index >= 0) {
    const lineStart = redisLineStartBefore(text, index);
    const prefix = text.slice(lineStart, index);
    if (!/ECHO\s+$/i.test(prefix)) {
      return index;
    }
    index = text.indexOf(marker, index + marker.length);
  }
  return -1;
}

function redisLineStartBefore(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      return i + 1;
    }
  }
  return 0;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '');
}

function parseExitCode(text: string, marker: string): number | null {
  const match = text.match(new RegExp(`${escapeRegExp(marker)}(\\d+)`));
  return match ? Number(match[1]) : null;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}
