import { describe, expect, it } from 'vitest';
import {
  JumpServerApiError,
  apiErrorMessageFromPayload,
  classifyRestFailure
} from '../../src/jumpserver/apiError';

describe('classifyRestFailure', () => {
  it('treats 401 as expired credentials and 403 as forbidden', () => {
    expect(classifyRestFailure(401)).toBe('auth-rejected');
    expect(classifyRestFailure(403)).toBe('forbidden');
    expect(classifyRestFailure(404)).toBe('not-found');
    expect(classifyRestFailure(429)).toBe('throttled');
    expect(classifyRestFailure(502)).toBe('server-error');
    expect(classifyRestFailure(418)).toBe('client-error');
  });
});

describe('apiErrorMessageFromPayload', () => {
  it('prefers detail, then msg, error, message', () => {
    expect(apiErrorMessageFromPayload({ detail: 'token expired' }, 'fallback')).toBe('token expired');
    expect(apiErrorMessageFromPayload({ msg: 'nope' }, 'fallback')).toBe('nope');
    expect(apiErrorMessageFromPayload('plain', 'fallback')).toBe('plain');
    expect(apiErrorMessageFromPayload(null, 'fallback')).toBe('fallback');
  });
});

describe('JumpServerApiError', () => {
  it('keeps HTTP status in the user message and omits query strings from path', () => {
    const error = new JumpServerApiError('token expired', {
      statusCode: 401,
      method: 'GET',
      path: '/api/v1/users/profile/',
      reason: 'auth-rejected'
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).toContain('token expired');
    expect(error.path).toBe('/api/v1/users/profile/');
    expect(error.reason).toBe('auth-rejected');
  });
});
