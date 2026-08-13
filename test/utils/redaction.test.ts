import { describe, expect, it } from 'vitest';
import { errorMessage, redactSensitiveText, redactSensitiveValue, toUserMessage } from '../../src/utils/redaction';
import { formatError } from '../../src/utils/errors';

const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU',
  '-----END OPENSSH PRIVATE KEY-----'
].join('\n');

describe('JumpServer redaction', () => {
  it('redacts credential-bearing strings', () => {
    expect(
      redactSensitiveText('Authorization: Bearer abc123; Cookie: sessionid=xyz; token=connection-token')
    ).toBe('Authorization: Bearer [REDACTED]; Cookie: [REDACTED]; token=[REDACTED]');
  });

  it('redacts nested object fields by key', () => {
    expect(
      redactSensitiveValue({
        username: 'alan',
        password: 'secret',
        nested: {
          cookie: 'session',
          keep: 'value'
        }
      })
    ).toEqual({
      username: 'alan',
      password: '[REDACTED]',
      nested: {
        cookie: '[REDACTED]',
        keep: 'value'
      }
    });
  });

  it('redacts PEM private keys, which only the utils copy used to catch', () => {
    expect(redactSensitiveText(`ssh failed for key ${PRIVATE_KEY}`)).toBe(
      'ssh failed for key [REDACTED_PRIVATE_KEY]'
    );
  });

  it('redacts spaced password assignments, which only the utils copy used to catch', () => {
    expect(redactSensitiveText('login rejected: password = hunter2')).toBe(
      'login rejected: password=[REDACTED]'
    );
  });

  it('redacts secret assignments', () => {
    expect(redactSensitiveText('input_secret=top-secret was rejected')).toBe(
      'input_secret=top-secret was rejected'
    );
    expect(redactSensitiveText('secret=top-secret was rejected')).toBe(
      'secret=[REDACTED] was rejected'
    );
  });

  it('keeps the KoKo query string readable while dropping the connection token', () => {
    expect(
      redactSensitiveText('wss://koko.example.com/koko/ws/terminal/?disableautohash=false&token=jms-abc.123&_=1699')
    ).toBe('wss://koko.example.com/koko/ws/terminal/?disableautohash=false&token=[REDACTED]&_=1699');
  });

  it('redacts JumpServer session cookies presented as a bare cookie string', () => {
    expect(redactSensitiveText('sessionid=abc123; csrftoken=def456')).toBe(
      'sessionid=[REDACTED]; csrftoken=[REDACTED]'
    );
  });

  it('formatError redacts tokens and cookies, not only passwords', () => {
    const message = [
      'bridge call failed',
      'Authorization: Bearer at-series-bridge-token',
      'Cookie: sessionid=jms-session-cookie',
      'token=koko-connection-token'
    ].join(' | ');

    const formatted = formatError(new Error(message));

    expect(formatted).not.toContain('at-series-bridge-token');
    expect(formatted).not.toContain('jms-session-cookie');
    expect(formatted).not.toContain('koko-connection-token');
  });

  it('reports thrown strings and unknown throwables through one shared shape', () => {
    expect(errorMessage(new Error('password=hunter2'))).toBe('password=[REDACTED]');
    expect(errorMessage('token=abc')).toBe('token=[REDACTED]');
    expect(toUserMessage({ message: 'Cookie: sessionid=abc' })).toBe('Cookie: [REDACTED]');
    expect(toUserMessage(undefined)).toBe('Unexpected error');
    expect(errorMessage({ nope: true })).toBe('Unexpected error');
  });
});
