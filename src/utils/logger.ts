import { redactSensitiveText } from './redaction';

/**
 * The methods of `vscode.LogOutputChannel`, which is what this is normally
 * pointed at. Naming them identically means the channel can be handed to
 * `setLogSink` directly, and tests can hand over an array instead.
 */
export interface LogSink {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type Level = keyof LogSink;

const LEVELS: Level[] = ['trace', 'debug', 'info', 'warn', 'error'];

let sink: LogSink | undefined;

/**
 * Attaches the output channel, or detaches it with `undefined`. Until the
 * extension activates - and in every unit test that does not opt in - lines go
 * nowhere, so no module needs to know whether logging is wired up yet.
 */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

/**
 * Every line is redacted on the way out rather than at the call sites. This
 * extension holds a JumpServer password, a session cookie jar, a bridge token
 * and KoKo URLs with a connection token in the query string; an output channel
 * is a file users attach to bug reports, so the mask cannot be something a
 * caller has to remember to apply.
 */
export const log: LogSink = Object.fromEntries(
  LEVELS.map((level) => [level, (message: string) => sink?.[level](redactSensitiveText(message))])
) as unknown as LogSink;
