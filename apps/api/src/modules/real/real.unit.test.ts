import { describe, expect, it } from 'vitest';
import {
  CLOCK_TOLERANCE_MS,
  MAX_UPLOAD_DELAY_MS,
  authenticityIndicators,
  computeAuthenticity,
  noneAttestationVerifier,
  type AuthenticityInput,
} from './authenticity.js';
import {
  CAPTURE_TOKEN_TTL_MS,
  captureSigningKey,
  hashDeviceId,
  signCaptureToken,
  verifyCaptureToken,
  type CaptureTokenPayload,
} from './token.js';
import { localDay } from './service.js';

const key = captureSigningKey(Buffer.alloc(32, 7));
const U = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const dev = hashDeviceId(U, 'device-abcdef');
const NOW = 1_800_000_000_000;
const payload = (over: Partial<CaptureTokenPayload> = {}): CaptureTokenPayload => ({
  sid: '33333333-3333-4333-8333-333333333333',
  uid: U,
  dev,
  iat: NOW,
  exp: NOW + CAPTURE_TOKEN_TTL_MS,
  skew: null,
  ...over,
});

describe('capture tokens', () => {
  it('round-trips and binds user and device', () => {
    const t = signCaptureToken(key, payload());
    const ok = verifyCaptureToken(key, t, { userId: U, deviceHash: dev }, NOW + 1000);
    expect(ok).toMatchObject({ ok: true, payload: { uid: U } });
  });
  it('rejects a token that is forged, tampered, expired, for another user or another device', () => {
    const t = signCaptureToken(key, payload());
    const [v, body, sig] = t.split('.') as [string, string, string];
    const other = captureSigningKey(Buffer.alloc(32, 9));
    expect(verifyCaptureToken(other, t, { userId: U, deviceHash: dev }, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const forgedBody = Buffer.from(JSON.stringify(payload({ uid: V }))).toString('base64url');
    expect(
      verifyCaptureToken(key, `${v}.${forgedBody}.${sig}`, { userId: V, deviceHash: dev }, NOW),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      verifyCaptureToken(
        key,
        `${v}.${body}.${sig.slice(0, -2)}xx`,
        { userId: U, deviceHash: dev },
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      verifyCaptureToken(key, t, { userId: U, deviceHash: dev }, NOW + CAPTURE_TOKEN_TTL_MS),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(verifyCaptureToken(key, t, { userId: V, deviceHash: dev }, NOW)).toEqual({
      ok: false,
      reason: 'wrong_user',
    });
    expect(
      verifyCaptureToken(key, t, { userId: U, deviceHash: hashDeviceId(U, 'other-device-1') }, NOW),
    ).toEqual({ ok: false, reason: 'wrong_device' });
  });
  it('rejects malformed input without throwing', () => {
    for (const bad of [
      '',
      'x',
      'v1.a',
      'v2.a.b',
      'v1.!!!.???',
      `v1.${Buffer.from('{}').toString('base64url')}.abc`,
      'x'.repeat(2000),
    ]) {
      expect(verifyCaptureToken(key, bad, { userId: U, deviceHash: dev }, NOW).ok).toBe(false);
    }
  });
  it('a validly signed payload with the wrong shape is malformed', () => {
    const body = Buffer.from(JSON.stringify({ sid: 1 })).toString('base64url');
    const sig = signCaptureToken(key, payload()).split('.')[2]!;
    expect(
      verifyCaptureToken(key, `v1.${body}.${sig}`, { userId: U, deviceHash: dev }, NOW).ok,
    ).toBe(false);
  });
  it('device ids are hashed per user (never the raw id, and not comparable across users)', () => {
    expect(hashDeviceId(U, 'same')).not.toBe(hashDeviceId(V, 'same'));
    expect(hashDeviceId(U, 'same')).not.toContain('same');
  });
});

const base = (over: Partial<AuthenticityInput> = {}): AuthenticityInput => ({
  capturedAtMs: NOW + 30_000,
  receivedAtMs: NOW + 60_000,
  sessionIssuedAtMs: NOW,
  clockSkewMs: 0,
  mediaCreatedAtMs: [NOW + 40_000],
  declaredEdits: [],
  serverEditOps: [],
  attested: false,
  tokenVerified: true,
  ...over,
});

describe('computeAuthenticity', () => {
  it('a prompt in-app capture passes every server check but is never "attested" without attestation', () => {
    const a = computeAuthenticity(base());
    expect(a).toMatchObject({
      capture_window_ok: true,
      edited: false,
      device_attested: false,
      method: 'in_app_token',
      assurance: 'in_app',
      clock_skew_ms: 0,
    });
    expect(a.checks).toEqual({
      token_verified: true,
      window_after_session_start: true,
      within_upload_delay: true,
      not_in_future: true,
      media_fresh: true,
    });
  });
  it('attestation raises assurance only when every other check also passes', () => {
    expect(computeAuthenticity(base({ attested: true })).assurance).toBe('attested');
    expect(
      computeAuthenticity(base({ attested: true, capturedAtMs: NOW - 3_600_000 })).assurance,
    ).toBe('unverified');
  });
  it('a capture time before the session started is not within the window (with clock tolerance)', () => {
    expect(
      computeAuthenticity(base({ capturedAtMs: NOW - CLOCK_TOLERANCE_MS + 1000 }))
        .capture_window_ok,
    ).toBe(true);
    expect(
      computeAuthenticity(base({ capturedAtMs: NOW - CLOCK_TOLERANCE_MS - 1000 }))
        .capture_window_ok,
    ).toBe(false);
  });
  it('a capture time in the future is rejected beyond the tolerance', () => {
    expect(
      computeAuthenticity(base({ capturedAtMs: NOW + 60_000 + CLOCK_TOLERANCE_MS - 1 })).checks
        .not_in_future,
    ).toBe(true);
    expect(
      computeAuthenticity(base({ capturedAtMs: NOW + 60_000 + CLOCK_TOLERANCE_MS + 5000 })).checks
        .not_in_future,
    ).toBe(false);
  });
  it('an upload much later than the capture fails the upload-delay check', () => {
    const a = computeAuthenticity(
      base({ capturedAtMs: NOW, receivedAtMs: NOW + MAX_UPLOAD_DELAY_MS + 1000 }),
    );
    expect(a.checks.within_upload_delay).toBe(false);
    expect(a.capture_window_ok).toBe(false);
  });
  it('a known device clock offset is corrected before judging the window', () => {
    // The device clock runs 1 hour behind the server: raw claim looks ancient, corrected claim is fine.
    const raw = NOW + 30_000 - 3_600_000;
    expect(computeAuthenticity(base({ capturedAtMs: raw, clockSkewMs: 0 })).capture_window_ok).toBe(
      false,
    );
    const fixed = computeAuthenticity(base({ capturedAtMs: raw, clockSkewMs: 3_600_000 }));
    expect(fixed.capture_window_ok).toBe(true);
    expect(fixed.clock_skew_ms).toBe(3_600_000);
  });
  it('unknown skew is recorded as null, not guessed', () => {
    expect(computeAuthenticity(base({ clockSkewMs: null })).clock_skew_ms).toBeNull();
  });
  it('media created before the session started is not fresh (an old gallery file)', () => {
    const a = computeAuthenticity(base({ mediaCreatedAtMs: [NOW - 86_400_000] }));
    expect(a.checks.media_fresh).toBe(false);
    expect(a.assurance).toBe('unverified');
    expect(
      computeAuthenticity(base({ mediaCreatedAtMs: [NOW + 1000, NOW - 86_400_000] })).checks
        .media_fresh,
    ).toBe(false);
    expect(computeAuthenticity(base({ mediaCreatedAtMs: [] })).checks.media_fresh).toBe(false);
  });
  it('declared or server-known edits flip edited', () => {
    expect(computeAuthenticity(base({ declaredEdits: ['crop'] })).edited).toBe(true);
    expect(computeAuthenticity(base({ serverEditOps: ['resize'] })).edited).toBe(true);
    expect(computeAuthenticity(base({ declaredEdits: ['crop'] })).declared_edits).toEqual(['crop']);
  });
  it('without a verified token nothing counts as in-app', () => {
    const a = computeAuthenticity(base({ tokenVerified: false }));
    expect(a).toMatchObject({ capture_window_ok: false, method: 'none', assurance: 'unverified' });
  });
});

describe('indicators and attestation', () => {
  it('states what was checked and never overclaims', () => {
    const ind = authenticityIndicators(computeAuthenticity(base()));
    expect(Object.fromEntries(ind.map((i) => [i.key, i.ok]))).toEqual({
      captured_in_app: true,
      capture_window: true,
      unedited: true,
      device_attested: false,
    });
    expect(ind.find((i) => i.key === 'device_attested')!.label).toMatch(/not attested/i);
  });
  it('handles missing data', () => {
    expect(authenticityIndicators(null).every((i) => !i.ok)).toBe(true);
    expect(authenticityIndicators({}).find((i) => i.key === 'unedited')!.ok).toBe(false);
  });
  it('the shipped verifier is `none` and attests nothing', async () => {
    expect(noneAttestationVerifier.provider).toBe('none');
    expect(await noneAttestationVerifier.verify({ userId: U, deviceId: 'x' })).toEqual({
      attested: false,
      provider: 'none',
    });
  });
});

describe('localDay', () => {
  it('resolves date and weekday in the given zone', () => {
    const d = new Date('2026-03-01T23:30:00Z'); // Sunday in UTC, Monday in Auckland
    expect(localDay(d, 'UTC')).toEqual({ date: '2026-03-01', dow: 0 });
    expect(localDay(d, 'Pacific/Auckland')).toEqual({ date: '2026-03-02', dow: 1 });
  });
});
