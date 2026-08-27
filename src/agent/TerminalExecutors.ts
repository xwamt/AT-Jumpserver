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
  /** Set when collection gave up early because the start marker never appeared. */
  error?: string;
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
  /** Set when collection gave up early because the start marker never appeared. */
  error?: string;
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
  /** Set when collection gave up early because the start marker never appeared. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The hub invoke times out at 120 s and then fails over to another window,
 * re-executing the command. Cap executor timeouts below that so a long command
 * finishes (or fails) here first instead of being run twice.
 */
export const MAX_TIMEOUT_MS = 110_000;
/**
 * How long to wait for the start marker before giving up on the whole
 * collection. If the terminal is parked in `less`/`vim`/a password prompt the
 * wrapper never runs, and without this the user waits out the full timeout.
 */
export const START_MARKER_GRACE_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 256_000;

function startMarkerMissingError(): string {
  return (
    `The terminal did not start executing the command within ${START_MARKER_GRACE_MS / 1000}s. ` +
    'It may be stuck in an interactive program (e.g. less/vim) or waiting at a prompt; ' +
    'any captured output may be unrelated or partial.'
  );
}

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
      // Completion can only flip when a start marker or an end marker + exit
      // code just arrived; both fit inside the tail overlap, so anything else
      // skips the full-window re-check.
      isCompleteTail: (tail) => tail.includes(startMarker) || endWithCode.test(tail),
      findTerminatorIndex: (text) => {
        const start = text.indexOf(startMarker);
        if (start < 0) {
          return -1;
        }
        const match = endWithCode.exec(text.slice(start));
        return match ? start + match.index : -1;
      },
      // The printf wrapper splits the marker across arguments, so echo can
      // never produce it: seeing these bytes means the wrapper really ran.
      startMarker,
      startMarkerGraceMs: START_MARKER_GRACE_MS,
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
      truncated: collected.truncated,
      ...(collected.startMarkerMissing ? { error: startMarkerMissingError() } : {})
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
      isCompleteTail: (tail) => tail.includes(startMarker) || tail.includes(endMarker),
      findTerminatorIndex: (text) => {
        const start = text.indexOf(startMarker);
        if (start < 0) {
          return -1;
        }
        return text.indexOf(endMarker, start + startMarker.length);
      },
      // CONCAT keeps the marker out of the echoed SQL, so these bytes only
      // appear once the SELECT actually executed.
      startMarker,
      startMarkerGraceMs: START_MARKER_GRACE_MS,
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
      truncated: collected.truncated,
      ...(collected.startMarkerMissing ? { error: startMarkerMissingError() } : {})
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
      // Cheap substring gate; the full standalone-line validation above only
      // reruns when marker text actually landed in the new tail, instead of
      // rescanning the whole window for every output chunk.
      isCompleteTail: (tail) => tail.includes(startMarker) || tail.includes(endMarker),
      findTerminatorIndex: (text) => {
        const start = findStandaloneRedisMarker(text, startMarker);
        if (start < 0) {
          return -1;
        }
        return findStandaloneRedisMarker(text, endMarker, start + startMarker.length);
      },
      // Weaker guarantee than shell/mysql: the typed `ECHO <marker>` line is
      // echoed verbatim, so these bytes can appear even if redis-cli never
      // executed it. Still useful — a pager or password prompt suppresses echo
      // entirely, which is exactly the stuck case the grace should catch.
      startMarker,
      startMarkerGraceMs: START_MARKER_GRACE_MS,
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
    // collectUntil keeps the end marker in `terminator`, not `output`.
    const captured = `${collected.output}${collected.terminator ?? ''}`;
    const between = extractBetweenRedisMarkers(captured, startMarker, endMarker);
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      command,
      output: cleanRedisCliCapture(between, command),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated,
      ...(collected.startMarkerMissing ? { error: startMarkerMissingError() } : {})
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

function extractBetweenRedisMarkers(text: string, startMarker: string, endMarker: string): string {
  const start = findStandaloneRedisMarker(text, startMarker);
  if (start < 0) {
    return text;
  }
  const end = findStandaloneRedisMarker(text, endMarker, start + startMarker.length);
  if (end >= 0) {
    return text.slice(start + startMarker.length, end);
  }
  return text.slice(start + startMarker.length);
}

/**
 * Accept only a line whose sole content is the marker (ECHO response).
 * Rejects typed lines like `127.0.0.1:44563> ECHO __JMS_REDIS_END_…__`.
 */
function findStandaloneRedisMarker(text: string, marker: string, fromIndex = 0): number {
  let index = text.indexOf(marker, fromIndex);
  while (index >= 0) {
    const lineStart = redisLineStartBefore(text, index);
    let lineEnd = index + marker.length;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      lineEnd += 1;
    }
    const line = text.slice(lineStart, lineEnd).trim();
    if (line === marker) {
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

/** Drop redis-cli prompt redraws and echoed command/ECHO lines from captured body. */
function cleanRedisCliCapture(text: string, command: string): string {
  // Normalize CR before stripAnsi — stripAnsi deletes `\r` and would glue lines together.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const withoutAnsi = stripAnsi(normalized);
  const commandNorm = command.trim();
  const kept: string[] = [];
  for (const line of withoutAnsi.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\d+\.\d+\.\d+\.\d+:\d+>/.test(trimmed)) {
      continue;
    }
    if (trimmed === commandNorm) {
      continue;
    }
    if (/^ECHO\s+/i.test(trimmed)) {
      continue;
    }
    if (/^__JMS_REDIS_(START|END)_[a-z0-9]+__$/i.test(trimmed)) {
      continue;
    }
    kept.push(trimmed);
  }
  return kept.join('\n');
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
