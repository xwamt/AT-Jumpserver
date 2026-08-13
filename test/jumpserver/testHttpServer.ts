import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export function listenHttp(handler: Handler): Promise<TestServer> {
  return start(http.createServer(), handler, 'http');
}

export function listenHttps(tls: { cert: string; key: string }, handler: Handler): Promise<TestServer> {
  return start(https.createServer(tls), handler, 'https');
}

async function start(server: http.Server, handler: Handler, scheme: 'http' | 'https'): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8')
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `${scheme}://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
