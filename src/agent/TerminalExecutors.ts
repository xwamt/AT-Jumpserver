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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 256_000;

export class ShellTerminalExecutor {
  constructor(private readonly options: { idFactory?: () => string } = {}) {}

  async execute(input: ShellCommandExecutionInput): Promise<ShellCommandExecutionResult> {
    const id = this.options.idFactory?.() ?? randomUUID().replaceAll('-', '');
    const startMarker = `__JMS_CMD_START_${id}__`;
    const endMarker = `__JMS_CMD_END_${id}__`;
    const timeoutMs = clamp(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clamp(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();

    const command = wrapShellCommand(input.command, input.cwd, startMarker, endMarker);
    const collection = input.output.collectUntil({ marker: endMarker, timeoutMs, maxOutputBytes });
    input.write(command);
    const collected = await collection;
    const stdout = trimBeforeMarker(collected.output, startMarker);
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
    const collection = input.output.collectUntil({ marker: endMarker, timeoutMs, maxOutputBytes });
    input.write(`SELECT '${startMarker}';\n${ensureSemicolon(input.sql)}\nSELECT '${endMarker}';\n`);
    const collected = await collection;
    return {
      terminalId: input.terminalId,
      assetId: input.assetId,
      assetName: input.assetName,
      sql: input.sql,
      output: trimBeforeMarker(collected.output, startMarker),
      durationMs: Date.now() - started,
      timedOut: collected.timedOut,
      truncated: collected.truncated
    };
  }
}

function wrapShellCommand(command: string, cwd: string | undefined, startMarker: string, endMarker: string): string {
  const body = cwd?.trim()
    ? `cd ${quotePosix(cwd.trim())} && ${command}`
    : command;
  return `printf '\\n${startMarker}\\n'\n${body}\nprintf '\\n${endMarker}%s\\n' "$?"\n`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ensureSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function trimBeforeMarker(text: string, marker: string): string {
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

function parseExitCode(text: string, marker: string): number | null {
  const match = text.match(new RegExp(`${marker}(\\d+)`));
  return match ? Number(match[1]) : null;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}
