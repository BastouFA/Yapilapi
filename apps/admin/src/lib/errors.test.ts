import { describe, expect, it } from 'vitest';
import { ApiError } from '@yapilapi/api-client';
import { makeT } from '@/i18n';
import { describeError } from './errors';

const t = makeT('en');
const err = (o: {
  status: number;
  code: string;
  message: string;
  issues?: Array<{ path: string; message: string }>;
  retryAfterSec?: number;
}) =>
  new ApiError(
    o.code,
    o.message,
    o.status,
    'req-123',
    o.issues ? { issues: o.issues } : undefined,
    o.retryAfterSec ?? null,
  );

describe('describeError', () => {
  it('gives unknown throwables a generic message without leaking details', () => {
    const d = describeError(new Error('secret stack detail'), t);
    expect(d.message).toBe(t('error.generic'));
    expect(d.message).not.toContain('secret');
    expect(d.requestId).toBeNull();
  });

  it('keeps the request id so staff can quote it', () => {
    expect(
      describeError(
        err({
          status: 409,
          code: 'conflict',
          message: 'This case is claimed by another moderator',
        }),
        t,
      ),
    ).toMatchObject({
      message: 'This case is claimed by another moderator',
      requestId: 'req-123',
      status: 409,
    });
  });

  it('explains 403s and includes the API reason', () => {
    expect(
      describeError(
        err({ status: 403, code: 'forbidden', message: 'Only admins can ban accounts' }),
        t,
      ).message,
    ).toBe('Not allowed: Only admins can ban accounts');
    expect(describeError(err({ status: 403, code: 'forbidden', message: '' }), t).message).toBe(
      t('error.forbidden'),
    );
  });

  it('never shows raw server errors', () => {
    expect(
      describeError(
        err({ status: 500, code: 'internal', message: 'relation "x" does not exist' }),
        t,
      ).message,
    ).toBe(t('error.server'));
  });

  it('tells staff how long to wait when rate limited', () => {
    expect(
      describeError(
        err({ status: 429, code: 'rate_limited', message: 'slow down', retryAfterSec: 12 }),
        t,
      ).message,
    ).toContain('12');
  });

  it('maps field problems by path', () => {
    const d = describeError(
      err({
        status: 422,
        code: 'validation_failed',
        message: 'Invalid',
        issues: [{ path: 'reason', message: 'Too short' }],
      }),
      t,
    );
    expect(d.fields).toEqual({ reason: 'Too short' });
    expect(d.message).toContain('reason: Too short');
  });
});
