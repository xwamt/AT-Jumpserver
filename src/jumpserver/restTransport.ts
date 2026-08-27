import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type Agent as HttpsAgent, type RequestOptions } from 'node:https';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * REST transport for the JumpServer client.
 *
 * Node's global fetch has no per-request TLS knob, so the `verifyTls` setting
 * only ever reached the WebSocket side. Going through `node:https` lets one
 * setting drive both channels, and it never follows redirects on its own,
 * which keeps every hop visible to the caller's same-origin check.
 *
 * A caller-owned keep-alive `agent` lets consecutive REST calls reuse one TLS
 * connection instead of paying a fresh handshake each time. The caller keeps
 * ownership: it must `destroy()` the agent when the client goes away.
 */
export function createJumpServerFetch(options: { verifyTls: boolean; agent?: HttpsAgent }): FetchLike {
  return (url, init = {}) => sendRequest(url, init, options.verifyTls, options.agent);
}

function sendRequest(url: string, init: RequestInit, verifyTls: boolean, agent?: HttpsAgent): Promise<Response> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const body = toRequestBody(init.body);
  const options: RequestOptions = {
    method: init.method ?? 'GET',
    headers: toOutgoingHeaders(init.headers, body),
    rejectUnauthorized: verifyTls,
    // The agent pools TLS sockets; handing it to a plain-http request would
    // make the agent open a TLS connection to an http port.
    agent: secure ? agent : undefined
  };
  const signal = init.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const send = secure ? httpsRequest : httpRequest;
    const request = send(target, options, (message) => {
      readBody(message).then(
        (buffer) => settle(() => resolve(toResponse(message, buffer))),
        (error: unknown) => settle(() => reject(error))
      );
    });
    // A wedged JumpServer can hold an accepted socket open forever, so the
    // caller's deadline has to be able to tear the socket down.
    const onAbort = (): void => {
      request.destroy(abortError(signal));
    };
    const settle = (finish: () => void): void => {
      signal?.removeEventListener('abort', onAbort);
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', (error) => settle(() => reject(error)));
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('JumpServer request was aborted.');
  error.name = 'AbortError';
  return error;
}

function readBody(message: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    message.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Copied out of the Buffer pool: Response only accepts a view backed by a
    // plain ArrayBuffer, and pooled Buffers share a larger backing store.
    message.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    message.on('error', reject);
  });
}

function toResponse(message: IncomingMessage, body: Uint8Array<ArrayBuffer>): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, item);
    }
  }
  const status = message.statusCode ?? 200;
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    statusText: message.statusMessage ?? '',
    headers
  });
}

function toRequestBody(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null || body === '') {
    return undefined;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error('JumpServer requests only support string or byte bodies.');
}

function toOutgoingHeaders(headers: HeadersInit | undefined, body: Buffer | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers ?? {});
  for (const [name, value] of entries) {
    record[name] = value;
  }
  if (body && !Object.keys(record).some((name) => name.toLowerCase() === 'content-length')) {
    record['content-length'] = String(body.byteLength);
  }
  return record;
}
