import { describe, expect, it } from 'vitest';
import { redactSensitiveText, redactSensitiveValue } from '../../src/jumpserver/redaction';

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
});
