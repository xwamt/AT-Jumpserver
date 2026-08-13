import { afterEach, describe, expect, it } from 'vitest';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from '../../test-fixtures/selfSignedTls';
import { createJumpServerFetch } from '../../src/jumpserver/restTransport';
import { listenHttp, listenHttps, type TestServer } from './testHttpServer';

const selfSignedTls = { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY };

describe('createJumpServerFetch', () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serveHttps(handler: Parameters<typeof listenHttps>[1]): Promise<TestServer> {
    const server = await listenHttps(selfSignedTls, handler);
    servers.push(server);
    return server;
  }

  async function serveHttp(handler: Parameters<typeof listenHttp>[0]): Promise<TestServer> {
    const server = await listenHttp(handler);
    servers.push(server);
    return server;
  }

  it('accepts a self-signed certificate when TLS verification is disabled', async () => {
    const server = await serveHttps((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"token":"bearer-1"}');
    });

    const response = await createJumpServerFetch({ verifyTls: false })(`${server.url}/api/v1/authentication/auth/`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: 'bearer-1' });
  });

  it('rejects a self-signed certificate when TLS verification is enabled', async () => {
    const server = await serveHttps((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });

    await expect(
      createJumpServerFetch({ verifyTls: true })(`${server.url}/api/v1/authentication/auth/`)
    ).rejects.toThrow(/self.signed|self signed/i);
  });

  it('sends the method, headers and body through to the server', async () => {
    const server = await serveHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    await createJumpServerFetch({ verifyTls: true })(`${server.url}/api/v1/authentication/auth/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: 'alan', password: 'secret' })
    });

    expect(server.requests).toEqual([
      {
        method: 'POST',
        url: '/api/v1/authentication/auth/',
        body: '{"username":"alan","password":"secret"}'
      }
    ]);
  });

  it('surfaces a redirect as a response instead of following it', async () => {
    const server = await serveHttp((_req, res) => {
      res.writeHead(302, { location: 'https://evil.example.com/login/' });
      res.end();
    });

    const response = await createJumpServerFetch({ verifyTls: true })(`${server.url}/koko/connect/`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://evil.example.com/login/');
  });

  it('keeps every Set-Cookie header readable on the response', async () => {
    const server = await serveHttp((_req, res) => {
      res.writeHead(200, { 'set-cookie': ['csrftoken=abc; Path=/', 'sessionid=session-1; Path=/'] });
      res.end();
    });

    const response = await createJumpServerFetch({ verifyTls: true })(`${server.url}/core/auth/login/`);

    expect(response.headers.get('set-cookie')).toBe('csrftoken=abc; Path=/, sessionid=session-1; Path=/');
  });

  it('returns a bodyless response for statuses that cannot carry one', async () => {
    const server = await serveHttp((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    const response = await createJumpServerFetch({ verifyTls: true })(`${server.url}/api/v1/ping/`);

    expect(response.status).toBe(204);
  });
});
