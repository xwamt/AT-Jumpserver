import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * REST transport for the JumpServer client.
 *
 * Node's global fetch has no per-request TLS knob, so the `verifyTls` setting
 * only ever reached the WebSocket side. Going through `node:https` lets one
 * setting drive both channels, and it never follows redirects on its own,
 * which keeps every hop visible to the caller's same-origin check.
 */
export function createJumpServerFetch(options: { verifyTls: boolean }): FetchLike {
  return (url, init = {}) => sendRequest(url, init, options.verifyTls);
}

function sendRequest(url: string, init: RequestInit, verifyTls: boolean): Promise<Response> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const body = toRequestBody(init.body);
  const options: RequestOptions = {
    method: init.method ?? 'GET',
    headers: toOutgoingHeaders(init.headers, body),
    rejectUnauthorized: verifyTls
  };
  return new Promise<Response>((resolve, reject) => {
    const send = secure ? httpsRequest : httpRequest;
    const request = send(target, options, (message) => {
      readBody(message).then((buffer) => resolve(toResponse(message, buffer)), reject);
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
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
