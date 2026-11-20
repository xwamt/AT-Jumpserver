import { Agent as HttpsAgent } from 'node:https';
import WebSocket from 'ws';
import { log } from '../utils/logger';
import type { JumpServerEndpoint } from './types';
import { buildOrigin } from './urls';

/**
 * `ping`/`terminate`/`bufferedAmount` are here for the session heartbeat and
 * its send backpressure. They are deliberately the RFC 6455 control frame and
 * the transport's own queue depth rather than anything KoKo-specific: a peer
 * that has stopped running its read loop cannot answer a protocol ping, and
 * `close()` on such a peer waits for a close frame that will never arrive.
 */
export type KokoWebSocket = Pick<WebSocket, 'send' | 'close' | 'on' | 'ping' | 'terminate' | 'bufferedAmount'>;
export type WebSocketFactory = (url: string, options: WebSocket.ClientOptions) => Promise<KokoWebSocket>;

export interface JumpServerTimeouts {
  /** Auth, connection tokens, endpoints, KoKo warmup: single lookups. */
  requestMs: number;
  /** Bulk permission listings, which a large deployment answers slowly. */
  listingMs: number;
  /** KoKo WebSocket handshake. */
  webSocketMs: number;
}

/** Which of the three budgets a call is spending. Also the label used in logs. */
export type JumpServerTimeoutBudget = 'request' | 'listing';

/**
 * Without these, a JumpServer that accepts the TCP connection and then stops
 * talking leaves the tree view, the terminal and every MCP tool call pending
 * forever, with no cancel affordance anywhere in the UI.
 */
export const DEFAULT_JUMPSERVER_TIMEOUTS: JumpServerTimeouts = {
  requestMs: 15_000,
  listingMs: 60_000,
  webSocketMs: 15_000
};

/** The path alone. Query strings here carry connection tokens. */
export function logRoute(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(unparsable url)';
  }
}

export function buildKokoConnectUrl(baseUrl: string, tokenId: string, timestamp = Date.now()): string {
  const origin = buildOrigin(baseUrl);
  return `${origin}/koko/connect/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function buildKokoBaseUrl(baseUrl: string, endpoint: JumpServerEndpoint): string {
  const parsed = new URL(baseUrl);
  const protocol = parsed.protocol;
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80))
    ? `${host}:${port}`
    : host;
  return `${protocol}//${authority}`;
}

export function buildKokoWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now(),
  ticket?: string
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  const ticketParam = ticket ? `&ticket=${encodeURIComponent(ticket)}` : '';
  return `${scheme}://${authority}/koko/ws/terminal/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}${ticketParam}`;
}

export function buildKokoSftpWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now(),
  ticket?: string
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  const ticketParam = ticket ? `&ticket=${encodeURIComponent(ticket)}` : '';
  return `${scheme}://${authority}/koko/ws/sftp/?token=${encodeURIComponent(tokenId)}&_=${timestamp}${ticketParam}`;
}

export function parseCsrfMiddlewareToken(html: string): string {
  const match = html.match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/i);
  if (!match) {
    throw new Error('Unable to find csrfmiddlewaretoken in JumpServer login page.');
  }
  return match[1];
}

export function isKokoLoginRedirect(location: string | null): boolean {
  if (!location) {
    return false;
  }
  return /\/(?:core\/)?auth\/login(?:\/|\?|$)/i.test(location);
}

/**
 * The REST keep-alive agent, but only when the KoKo endpoint resolves to the
 * same https authority the REST calls use - that is when the WebSocket
 * handshake can resume the already-warm TLS session. A different host or port
 * must not borrow the agent: its pooled sockets carry the wrong SNI and would
 * pin the handshake to the wrong peer. Plain-http endpoints get nothing
 * either, since an https agent would try to speak TLS to them.
 */
export function kokoWsAgentForEndpoint(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  agent: HttpsAgent | undefined
): HttpsAgent | undefined {
  if (!agent) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') {
    return undefined;
  }
  const wsHost = (endpoint.host || parsed.hostname).toLowerCase();
  if (wsHost !== parsed.hostname.toLowerCase()) {
    return undefined;
  }
  // Mirrors buildKokoWsUrl: no https_port means the default wss port.
  const basePort = parsed.port ? Number(parsed.port) : 443;
  const wsPort = endpoint.https_port ?? 443;
  return wsPort === basePort ? agent : undefined;
}

export async function defaultWebSocketFactory(
  url: string,
  options: WebSocket.ClientOptions,
  timeoutMs = DEFAULT_JUMPSERVER_TIMEOUTS.webSocketMs
): Promise<WebSocket> {
  const socket = new WebSocket(url, ['JMS-KOKO'], options);
  await new Promise<void>((resolve, reject) => {
    // Both handshake listeners have to come off on settle: the session attaches
    // its own 'error' handler afterwards, and a stale one here would keep
    // rejecting a promise that nobody awaits by then. A no-op sink takes
    // their place because ws throws when an 'error' event has no listener at
    // all - including the one terminate() raises below.
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.on('error', () => undefined);
      finish();
    };
    const onOpen = (): void => settle(resolve);
    const onError = (error: Error): void => settle(() => reject(error));
    const timer = setTimeout(() => settle(() => {
      log.warn(`KoKo WebSocket handshake timed out after ${timeoutMs}ms: ${logRoute(url)}`);
      socket.terminate();
      reject(new Error(`JumpServer WebSocket handshake timed out after ${timeoutMs}ms.`));
    }), timeoutMs);
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return socket;
}
