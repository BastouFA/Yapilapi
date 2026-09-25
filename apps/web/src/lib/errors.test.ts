import { describe, expect, it } from 'vitest';
import { ApiError } from '@yapilapi/api-client';
import { makeT } from '@/i18n/make';
import { describeError } from './errors';

const t = makeT('en');

describe('describeError', () => {
  it('shows a friendly offline message for network errors', () => {
    const d = describeError(new ApiError('network_error', 'fetch failed', 0), t);
    expect(d.message).toContain('offline');
    expect(d.requestId).toBeNull();
  });
  it('mentions the wait for rate limits', () => {
    expect(
      describeError(new ApiError('rate_limited', 'x', 429, 'r1', undefined, 30), t).message,
    ).toContain('30 seconds');
    expect(describeError(new ApiError('rate_limited', 'x', 429), t).message).toBe(
      t('error.rateLimited'),
    );
  });
  it('keeps specific 4xx messages and field issues, hides 5xx details but keeps the reference', () => {
    const conflict = new ApiError('conflict', 'That username is already taken', 409, 'req-1', {
      issues: [{ path: 'username', message: 'taken' }],
    });
    const c = describeError(conflict, t);
    expect(c.message).toBe('That username is already taken');
    expect(c.fields).toEqual({ username: 'taken' });
    expect(c.requestId).toBeNull();
    const boom = describeError(new ApiError('internal', 'stack trace here', 500, 'req-9'), t);
    expect(boom.message).toBe(t('error.server'));
    expect(boom.requestId).toBe('req-9');
  });
  it('flags 401 so callers can redirect to sign-in', () => {
    expect(describeError(new ApiError('unauthenticated', 'x', 401), t).unauthenticated).toBe(true);
    expect(describeError(new ApiError('forbidden', 'x', 403), t).unauthenticated).toBe(false);
  });
  it('handles unknown thrown values', () => {
    expect(describeError(new Error('boom'), t).message).toBe(t('error.generic'));
    expect(describeError('nope', t).code).toBe('unknown');
  });
});
