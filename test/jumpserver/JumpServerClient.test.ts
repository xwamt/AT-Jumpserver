import { describe, expect, it } from 'vitest';
import {
  buildConnectionTokenPayload,
  buildKokoConnectUrl,
  buildKokoWsUrl,
  buildOrigin,
  DEFAULT_CONNECT_OPTIONS,
  normalizeJumpServerAsset,
  parseCsrfMiddlewareToken,
  resolveFirstUsableAccount
} from '../../src/jumpserver/JumpServerClient';

describe('JumpServerClient pure helpers', () => {
  it('builds browser origin from baseUrl', () => {
    expect(buildOrigin('https://jumpserver.example.com/root')).toBe('https://jumpserver.example.com');
  });

  it('builds KoKo connect page URL', () => {
    expect(buildKokoConnectUrl('https://jumpserver.example.com/', 'token-1', 1000)).toBe(
      'https://jumpserver.example.com/koko/connect/?disableautohash=false&token=token-1&_=1000'
    );
  });

  it('builds KoKo websocket URL from smart endpoint', () => {
    expect(
      buildKokoWsUrl('https://jumpserver.example.com', { host: 'koko.example.com', https_port: 8443 }, 'token-1', 1000)
    ).toBe('wss://koko.example.com:8443/koko/ws/terminal/?disableautohash=false&token=token-1&_=1000');
  });

  it('parses csrfmiddlewaretoken from JumpServer login HTML', () => {
    expect(parseCsrfMiddlewareToken('<input name="csrfmiddlewaretoken" value="csrf-1">')).toBe('csrf-1');
  });

  it('normalizes JumpServer assets like Ahell', () => {
    expect(
      normalizeJumpServerAsset({
        id: 'asset-1',
        name: 'web-1',
        address: '10.0.0.10',
        platform: { name: 'Linux' },
        category: { value: 'host' },
        type: { value: 'server' },
        nodes: [{ name: 'Production' }, { name: 'Web' }],
        zone: { name: 'zone-a' },
        protocols: [{ name: 'ssh' }]
      })
    ).toMatchObject({
      id: 'asset-1',
      name: 'web-1',
      nodePath: ['Production', 'Web'],
      zoneName: 'zone-a',
      protocolNames: ['ssh']
    });
  });

  it('selects the first usable account without exposing account choice to users', () => {
    expect(
      resolveFirstUsableAccount({
        permed_accounts: [
          { id: 'account-1', username: 'root' },
          { id: 'account-2', name: 'deploy' }
        ]
      })
    ).toEqual({ id: 'account-1', username: 'root' });
  });

  it('builds Ahell-compatible connection-token payload', () => {
    expect(
      buildConnectionTokenPayload({
        assetId: 'asset-1',
        account: { id: 'account-1', username: 'root' },
        protocol: 'ssh'
      })
    ).toEqual({
      asset: 'asset-1',
      account: 'account-1',
      protocol: 'ssh',
      input_username: 'root',
      input_secret: '',
      connect_method: 'web_cli',
      connect_options: DEFAULT_CONNECT_OPTIONS
    });
  });
});
