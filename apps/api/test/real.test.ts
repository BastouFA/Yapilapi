import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { withTransaction } from '@yapilapi/database';
import { canViewMedia } from '../src/modules/media/access.js';
import {
  CAPTURE_TOKEN_TTL_MS,
  captureSigningKey,
  hashDeviceId,
  runRealReminders,
  setAttestationVerifier,
  signCaptureToken,
  getAttestationVerifier,
} from '../src/modules/real/index.js';
import { Client, createTestApp, signup, type TestApp, type TestUser } from './helpers.js';
import {
  auditCount,
  befriend,
  block,
  follow,
  insertImage,
  notifCount,
  teenBirth,
} from './entity-helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
const deviceOf = (u: TestUser) => `device-${u.username}`;
const setFlag = async (key: string, enabled: boolean) => {
  await sql('UPDATE feature_flags SET enabled = $2 WHERE key = $1', [key, enabled]);
  t.ctx.flags.invalidate();
};

async function media(u: TestUser, over: { staleDays?: number } = {}) {
  const id = await insertImage(t, u.id, { purpose: 'attachment' });
  if (over.staleDays)
    await sql(`UPDATE media SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
      id,
      String(over.staleDays),
    ]);
  return id;
}
const session = async (u: TestUser, extra: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/real/capture-sessions', { deviceId: deviceOf(u), ...extra });
  if (r.status !== 201) throw new Error(`session failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { token: string; expiresAt: string };
};
async function capture(
  u: TestUser,
  over: Record<string, unknown> = {},
  opts: { raw?: boolean } = {},
) {
  const front =
    over.frontMediaId === undefined && over.rearMediaId === undefined ? await media(u) : undefined;
  const rear =
    over.frontMediaId === undefined && over.rearMediaId === undefined ? await media(u) : undefined;
  const s = await session(u);
  const res = await u.client.post('/v1/real/captures', {
    captureToken: s.token,
    deviceId: deviceOf(u),
    frontMediaId: front,
    rearMediaId: rear,
    capturedAt: new Date().toISOString(),
    visibility: 'friends',
    caption: 'hello',
    ...over,
  });
  if (opts.raw) return res;
  if (res.status !== 201)
    throw new Error(`capture failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const seen = async (v: Client, id: string) =>
  (await v.get(`/v1/real/captures/${id}`)).status === 200;

describe('capture sessions and tokens', () => {
  it('requires authentication and validates input', async () => {
    const anon = new Client(t);
    expect(
      (await anon.post('/v1/real/capture-sessions', { deviceId: 'device-12345678' })).status,
    ).toBe(401);
    expect((await anon.post('/v1/real/captures', {})).status).toBe(401);
    const a = await signup(t);
    expect((await a.client.post('/v1/real/capture-sessions', { deviceId: 'short' })).status).toBe(
      400,
    );
    const s = await session(a);
    expect(s).toMatchObject({
      method: 'in_app_token',
      ttlSec: CAPTURE_TOKEN_TTL_MS / 1000,
      attestation: { available: false, provider: 'none' },
    });
  });

  it('accepts a fresh token once, records an honest receipt, and rejects replay', async () => {
    const a = await signup(t);
    const front = await media(a);
    const s = await session(a);
    const body = {
      captureToken: s.token,
      deviceId: deviceOf(a),
      frontMediaId: front,
      capturedAt: new Date().toISOString(),
    };
    const ok = await a.client.post('/v1/real/captures', body);
    expect(ok.status).toBe(201);
    expect(ok.body.authenticity).toMatchObject({
      capture_window_ok: true,
      edited: false,
      device_attested: false,
      method: 'in_app_token',
      assurance: 'in_app',
    });
    expect(ok.body.authenticity.checks.media_fresh).toBe(true);
    const replay = await a.client.post('/v1/real/captures', {
      ...body,
      frontMediaId: await media(a),
    });
    expect(replay.status).toBe(422);
    expect(replay.body.error.details.reason).toBe('capture_token_replayed');
    expect(
      Number(
        (await sql('SELECT count(*)::int AS n FROM real_captures WHERE author_id = $1', [a.id]))
          .rows[0].n,
      ),
    ).toBe(1);
  });

  it('rejects forged, tampered, expired, other-user and other-device tokens', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const reason = async (u: TestUser, token: string, device = deviceOf(u)) => {
      const r = await u.client.post('/v1/real/captures', {
        captureToken: token,
        deviceId: device,
        frontMediaId: await media(u),
        capturedAt: new Date().toISOString(),
      });
      expect(r.status).toBe(422);
      return r.body.error.details.reason;
    };
    const s = await session(a);
    // forged: signed with the wrong key
    const forged = signCaptureToken(captureSigningKey(Buffer.alloc(32, 1)), {
      sid: '11111111-1111-4111-8111-111111111111',
      uid: a.id,
      dev: hashDeviceId(a.id, deviceOf(a)),
      iat: Date.now(),
      exp: Date.now() + 60_000,
      skew: null,
    });
    expect(await reason(a, forged)).toBe('capture_token_bad_signature');
    // tampered: flip a character of the payload
    const [v, body, sig] = s.token.split('.') as [string, string, string];
    expect(await reason(a, `${v}.${body.slice(0, -2)}AA.${sig}`)).toBe(
      'capture_token_bad_signature',
    );
    expect(await reason(a, 'garbage-token-that-is-long-enough')).toBe('capture_token_malformed');
    // another user presents A's valid token
    expect(await reason(b, s.token, deviceOf(a))).toBe('capture_token_wrong_user');
    // another device
    expect(await reason(a, s.token, 'some-other-device')).toBe('capture_token_wrong_device');
    // expired token (validly signed)
    const key = captureSigningKey(t.ctx.config.dataEncryptionKey);
    const exp = signCaptureToken(key, {
      sid: '22222222-2222-4222-8222-222222222222',
      uid: a.id,
      dev: hashDeviceId(a.id, deviceOf(a)),
      iat: Date.now() - 3_600_000,
      exp: Date.now() - 1000,
      skew: null,
    });
    expect(await reason(a, exp)).toBe('capture_token_expired');
    // validly signed but the session does not exist server-side
    const ghost = signCaptureToken(key, {
      sid: '33333333-3333-4333-8333-333333333333',
      uid: a.id,
      dev: hashDeviceId(a.id, deviceOf(a)),
      iat: Date.now(),
      exp: Date.now() + 60_000,
      skew: null,
    });
    expect(await reason(a, ghost)).toBe('capture_token_unknown_session');
    // session expired in the database
    const s2 = await session(a);
    await sql(
      `UPDATE real_capture_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [a.id],
    );
    expect(await reason(a, s2.token)).toBe('capture_token_unknown_session');
    // the untouched valid token still works (none of the failures consumed it)
    const s3 = await session(a);
    expect(
      (
        await a.client.post('/v1/real/captures', {
          captureToken: s3.token,
          deviceId: deviceOf(a),
          frontMediaId: await media(a),
          capturedAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(201);
  });

  it('a failed capture does not burn the token (media problems roll the session back)', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const s = await session(a);
    const bad = await a.client.post('/v1/real/captures', {
      captureToken: s.token,
      deviceId: deviceOf(a),
      frontMediaId: await media(b),
      capturedAt: new Date().toISOString(),
    });
    expect(bad.status).toBe(400);
    const good = await a.client.post('/v1/real/captures', {
      captureToken: s.token,
      deviceId: deviceOf(a),
      frontMediaId: await media(a),
      capturedAt: new Date().toISOString(),
    });
    expect(good.status).toBe(201);
  });

  it('records the clock skew reported at session start and corrects the capture time with it', async () => {
    const a = await signup(t);
    const s = await session(a, { clientTime: Date.now() - 3_600_000 }); // device clock one hour behind
    const claimed = new Date(Date.now() - 3_600_000).toISOString();
    const r = await a.client.post('/v1/real/captures', {
      captureToken: s.token,
      deviceId: deviceOf(a),
      frontMediaId: await media(a),
      capturedAt: claimed,
    });
    expect(r.status).toBe(201);
    expect(r.body.authenticity.clock_skew_ms).toBeGreaterThan(3_500_000);
    expect(r.body.authenticity.capture_window_ok).toBe(true);
  });
});

describe('creating and reading captures', () => {
  it('needs media, validates ownership/kind/reuse and coordinates', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const post = async (over: Record<string, unknown>) =>
      a.client.post('/v1/real/captures', {
        captureToken: (await session(a)).token,
        deviceId: deviceOf(a),
        capturedAt: new Date().toISOString(),
        ...over,
      });
    expect((await post({})).status).toBe(400); // no media
    const m = await media(a);
    expect((await post({ frontMediaId: m, rearMediaId: m })).status).toBe(400); // same file twice
    expect((await post({ frontMediaId: await media(b) })).status).toBe(400); // someone else's media
    expect(
      (await post({ frontMediaId: await insertImage(t, a.id, { purpose: 'public' }) })).status,
    ).toBe(400); // avatar-style public media
    expect(
      (
        await post({
          frontMediaId: await insertImage(t, a.id, { purpose: 'attachment', status: 'pending' }),
        })
      ).status,
    ).toBe(400);
    expect((await post({ frontMediaId: m, latitude: 10 })).status).toBe(400); // lat without lng
    expect((await post({ frontMediaId: m, visibility: 'circle' })).status).toBe(400); // circle without circleId
    expect((await post({ frontMediaId: m, visibility: 'selected' })).status).toBe(400); // selected without audience
    expect((await post({ frontMediaId: m, capturedAt: 'yesterday' })).status).toBe(400);
    expect((await post({ frontMediaId: m })).status).toBe(201);
    expect((await post({ frontMediaId: m })).status).toBe(400); // reusing a file that is already a Real
  });

  it('supports dual capture, rear-only, front-only and video', async () => {
    const a = await signup(t);
    const dual = await capture(a);
    expect(dual.front.id).toBeTruthy();
    expect(dual.rear.id).toBeTruthy();
    const rearOnly = await capture(a, { rearMediaId: await media(a), frontMediaId: undefined });
    expect(rearOnly.front).toBeNull();
    const vid = await insertImage(t, a.id, { purpose: 'attachment', kind: 'video' });
    expect((await capture(a, { frontMediaId: vid }, { raw: true })).status).toBe(201);
    const audio = await insertImage(t, a.id, { purpose: 'attachment', kind: 'audio' });
    expect((await capture(a, { frontMediaId: audio }, { raw: true })).status).toBe(400);
  });

  it('marks stale media, old capture times and declared edits honestly (still saved, never claimed verified)', async () => {
    const a = await signup(t);
    const stale = await capture(a, { frontMediaId: await media(a, { staleDays: 3 }) });
    expect(stale.authenticity.checks.media_fresh).toBe(false);
    expect(stale.authenticity.assurance).toBe('unverified');
    expect(stale.indicators.find((i: any) => i.key === 'captured_in_app').ok).toBe(true);
    const old = await capture(a, {
      frontMediaId: await media(a),
      capturedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    });
    expect(old.authenticity).toMatchObject({ capture_window_ok: false, assurance: 'unverified' });
    const future = await capture(a, {
      frontMediaId: await media(a),
      capturedAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(future.authenticity.checks.not_in_future).toBe(false);
    const edited = await capture(a, { frontMediaId: await media(a), edits: ['crop', 'filter'] });
    expect(edited.authenticity).toMatchObject({ edited: true, declared_edits: ['crop', 'filter'] });
    expect(edited.indicators.find((i: any) => i.key === 'unedited').ok).toBe(false);
    expect(edited.indicators.find((i: any) => i.key === 'device_attested')).toMatchObject({
      ok: false,
    });
  });

  it('never claims device attestation unless a verifier really attests (pluggable interface)', async () => {
    const a = await signup(t);
    expect(getAttestationVerifier(t.ctx).provider).toBe('none');
    setAttestationVerifier(t.ctx, {
      provider: 'test-attest',
      verify: async (i) => ({ attested: i.payload === 'good', provider: 'test-attest' }),
    });
    try {
      expect(((await session(a)) as any).attestation).toEqual({
        available: true,
        provider: 'test-attest',
      });
      const yes = await capture(a, { attestation: 'good' });
      expect(yes.authenticity).toMatchObject({ device_attested: true, assurance: 'attested' });
      const no = await capture(a, { attestation: 'bad' });
      expect(no.authenticity).toMatchObject({ device_attested: false, assurance: 'in_app' });
    } finally {
      setAttestationVerifier(t.ctx, {
        provider: 'none',
        verify: async () => ({ attested: false, provider: 'none' }),
      });
    }
  });

  it('holds captions the classifier flags: only the author sees them, and a case is opened', async () => {
    const a = await signup(t);
    const f = await signup(t);
    await befriend(a, f);
    const r = await capture(a, {
      caption: 'I will kill you and your family, you are going to die tonight',
    });
    expect(r.moderationStatus).not.toBe('approved');
    expect(await seen(a.client, r.id)).toBe(true);
    expect(await seen(f.client, r.id)).toBe(false);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM moderation_cases WHERE target_type = 'real_capture' AND target_id = $1`,
          [r.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('lists my Reals newest first with keyset pagination', async () => {
    const a = await signup(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (await capture(a, { capturedAt: new Date(Date.now() - i * 1000).toISOString() })).id,
      );
    const p1 = (await a.client.get('/v1/real/captures', { limit: '2' })).body;
    expect(p1.items.map((i: any) => i.id)).toEqual(ids.slice(0, 2));
    const p2 = (await a.client.get('/v1/real/captures', { limit: '2', cursor: p1.nextCursor }))
      .body;
    const p3 = (await a.client.get('/v1/real/captures', { limit: '2', cursor: p2.nextCursor }))
      .body;
    expect([...p1.items, ...p2.items, ...p3.items].map((i: any) => i.id)).toEqual(ids);
    expect(p3.nextCursor).toBeNull();
    expect((await new Client(t).get('/v1/real/captures')).status).toBe(401);
  });
});

describe('visibility matrix', () => {
  it('honours every audience: owner, friend, follower, circle member, selected, stranger, blocked, anonymous, teen', async () => {
    const owner = await signup(t);
    const friend = await signup(t);
    const follower = await signup(t);
    const stranger = await signup(t);
    const circleMate = await signup(t);
    const picked = await signup(t);
    const blocked = await signup(t);
    await befriend(owner, friend);
    await follow(follower, owner);
    const circle = (await owner.client.post('/v1/circles', { kind: 'custom', name: 'crew' })).body;
    await befriend(owner, circleMate);
    expect(
      (await owner.client.put(`/v1/circles/${circle.id}/members/${circleMate.id}`)).status,
    ).toBeLessThan(300);
    const anon = new Client(t);
    const who = { owner, friend, follower, stranger, circleMate, picked, blocked };
    const view = async (id: string) =>
      Object.fromEntries(
        await Promise.all([
          ...Object.entries(who).map(async ([k, u]) => [k, await seen(u.client, id)]),
          (async () => ['anon', await seen(anon, id)])(),
        ]),
      );

    const pub = await capture(owner, { visibility: 'public' });
    expect(await view(pub.id)).toEqual({
      owner: true,
      friend: true,
      follower: true,
      stranger: true,
      circleMate: true,
      picked: true,
      blocked: true,
      anon: true,
    });
    const fr = await capture(owner, { visibility: 'friends' });
    expect(await view(fr.id)).toEqual({
      owner: true,
      friend: true,
      follower: false,
      stranger: false,
      circleMate: true,
      picked: false,
      blocked: false,
      anon: false,
    });
    const fo = await capture(owner, { visibility: 'followers' });
    expect(await view(fo.id)).toEqual({
      owner: true,
      friend: false,
      follower: true,
      stranger: false,
      circleMate: false,
      picked: false,
      blocked: false,
      anon: false,
    });
    const ci = await capture(owner, { visibility: 'circle', circleId: circle.id });
    expect(await view(ci.id)).toEqual({
      owner: true,
      friend: false,
      follower: false,
      stranger: false,
      circleMate: true,
      picked: false,
      blocked: false,
      anon: false,
    });
    const se = await capture(owner, { visibility: 'selected', audience: [picked.id] });
    expect(await view(se.id)).toEqual({
      owner: true,
      friend: false,
      follower: false,
      stranger: false,
      circleMate: false,
      picked: true,
      blocked: false,
      anon: false,
    });
    const pr = await capture(owner, { visibility: 'private' });
    expect(await view(pr.id)).toEqual({
      owner: true,
      friend: false,
      follower: false,
      stranger: false,
      circleMate: false,
      picked: false,
      blocked: false,
      anon: false,
    });

    await block(owner, blocked);
    expect((await view(pub.id)).blocked).toBe(false);
    await block(friend, owner); // friend blocks the owner: the block works both ways
    expect((await view(fr.id)).friend).toBe(false);
    expect((await view(pub.id)).friend).toBe(false);

    // A private account's "public" Real is not world-readable (followers only), same as posts.
    const priv = await signup(t);
    await priv.client.patch('/v1/profile', { isPrivate: true });
    const pubOfPriv = await capture(priv, { visibility: 'friends' });
    await sql('UPDATE real_captures SET visibility = $2 WHERE id = $1', [pubOfPriv.id, 'public']);
    expect(await seen(stranger.client, pubOfPriv.id)).toBe(false);
    await follow(stranger, priv); // a private account holds the request until approved
    expect(await seen(stranger.client, pubOfPriv.id)).toBe(false);
    await sql(`UPDATE follows SET status = 'active' WHERE follower_id = $1 AND followee_id = $2`, [
      stranger.id,
      priv.id,
    ]);
    expect(await seen(stranger.client, pubOfPriv.id)).toBe(true);
    // ...and the API refuses to create one in the first place.
    expect((await capture(priv, { visibility: 'public' }, { raw: true })).status).toBe(422);
  });

  it('serves media to exactly the people who may see the Real (media access predicate)', async () => {
    const owner = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(owner, friend);
    const r = await capture(owner, { visibility: 'friends' });
    for (const [u, expected] of [
      [owner, true],
      [friend, true],
      [stranger, false],
    ] as const) {
      expect(await canViewMedia(t.ctx.db, u.id, r.front.id)).toBe(expected);
      expect(await canViewMedia(t.ctx.db, u.id, r.rear.id)).toBe(expected);
    }
    expect(await canViewMedia(t.ctx.db, null, r.front.id)).toBe(false);
    await sql(`UPDATE real_captures SET visibility = 'public' WHERE id = $1`, [r.id]);
    expect(await canViewMedia(t.ctx.db, null, r.front.id)).toBe(true);
    expect(await canViewMedia(t.ctx.db, stranger.id, r.rear.id)).toBe(true);
  });

  it('teens: no public Reals, no location, and they see only what is shared with them', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await capture(teen, { visibility: 'public' }, { raw: true })).status).toBe(422);
    expect((await capture(teen, { latitude: 1, longitude: 2 }, { raw: true })).status).toBe(422);
    const ok = await capture(teen, { visibility: 'friends' });
    expect(ok.location).toBeNull();
    const adult = await signup(t);
    expect(await seen(adult.client, ok.id)).toBe(false);
    const adultPub = await capture(adult, {
      visibility: 'public',
      latitude: 51.5,
      longitude: -0.1,
    });
    expect(await seen(teen.client, adultPub.id)).toBe(true);
    expect((await teen.client.get(`/v1/real/captures/${adultPub.id}`)).body.location).toEqual({
      latitude: 51.5,
      longitude: -0.1,
    });
  });

  it('unknown ids and bad ids are 404 / 400, never 500', async () => {
    const a = await signup(t);
    expect(
      (await a.client.get('/v1/real/captures/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await a.client.get('/v1/real/captures/not-a-uuid')).status).toBe(400);
  });
});

describe('deleting, reacting, sharing', () => {
  it('only the author can delete; deletion removes text, location, media, audience and reactions', async () => {
    const a = await signup(t);
    const f = await signup(t);
    await befriend(a, f);
    const r = await capture(a, {
      caption: 'private thought',
      latitude: 3,
      longitude: 4,
      visibility: 'selected',
      audience: [f.id],
    });
    await f.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'love' });
    expect((await f.client.del(`/v1/real/captures/${r.id}`)).status).toBe(404);
    expect((await new Client(t).del(`/v1/real/captures/${r.id}`)).status).toBe(401);
    expect((await a.client.del(`/v1/real/captures/${r.id}`)).status).toBe(204);
    expect((await a.client.get(`/v1/real/captures/${r.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/real/captures/${r.id}`)).status).toBe(404);
    const row = (
      await sql('SELECT caption, latitude, deleted_at FROM real_captures WHERE id = $1', [r.id])
    ).rows[0];
    expect(row).toMatchObject({ caption: '', latitude: null });
    expect(row.deleted_at).not.toBeNull();
    expect(
      (await sql('SELECT count(*)::int AS n FROM real_reactions WHERE capture_id = $1', [r.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM real_capture_audience WHERE capture_id = $1', [
          r.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM media WHERE id = ANY($1) AND deleted_at IS NULL',
          [[r.front.id, r.rear.id]],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await auditCount(t, 'real.deleted', r.id)).toBe(1);
  });

  it('reactions respect visibility, are idempotent per user, count correctly and notify the author', async () => {
    const a = await signup(t);
    const f = await signup(t);
    const s = await signup(t);
    await befriend(a, f);
    const r = await capture(a, { visibility: 'friends' });
    expect(
      (await s.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'like' })).status,
    ).toBe(404);
    expect(
      (await f.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'like' })).body
        .reactionCount,
    ).toBe(1);
    expect(
      (await f.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'love' })).body
        .reactionCount,
    ).toBe(1);
    expect(
      (await a.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'wow' })).body
        .reactionCount,
    ).toBe(2);
    expect((await f.client.get(`/v1/real/captures/${r.id}`)).body.viewer.reaction).toBe('love');
    expect(
      (await f.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'nope' })).status,
    ).toBe(400);
    expect(await notifCount(t, a.id, 'real_reaction')).toBeGreaterThanOrEqual(1);
    expect((await f.client.del(`/v1/real/captures/${r.id}/reaction`)).status).toBe(204);
    expect((await a.client.get(`/v1/real/captures/${r.id}`)).body.reactionCount).toBe(1);
    expect((await f.client.del(`/v1/real/captures/${r.id}/reaction`)).status).toBe(204); // idempotent
    expect((await a.client.get(`/v1/real/captures/${r.id}`)).body.reactionCount).toBe(1);
  });

  it('shares to the profile only when asked, as a post carrying the authenticity receipt; once', async () => {
    const a = await signup(t);
    const f = await signup(t);
    const s = await signup(t);
    await befriend(a, f);
    const r = await capture(a, { visibility: 'private', caption: 'golden hour', edits: ['crop'] });
    expect((await a.client.get(`/v1/users/${a.username}/posts`)).body.items?.length ?? 0).toBe(0); // capturing never publishes
    expect(
      (await f.client.post(`/v1/real/captures/${r.id}/share`, { visibility: 'friends' })).status,
    ).toBe(404); // not yours
    expect(
      (await new Client(t).post(`/v1/real/captures/${r.id}/share`, { visibility: 'friends' }))
        .status,
    ).toBe(401);
    expect((await a.client.post(`/v1/real/captures/${r.id}/share`, {})).status).toBe(400); // you must choose the audience
    const shared = await a.client.post(`/v1/real/captures/${r.id}/share`, {
      visibility: 'friends',
    });
    expect(shared.status).toBe(201);
    const post = (await f.client.get(`/v1/posts/${shared.body.postId}`)).body;
    expect(post.kind).toBe('carousel'); // dual capture = two photos
    expect(post.body).toBe('golden hour');
    expect(post.media).toHaveLength(2);
    const receipt = (await f.client.get(`/v1/real/posts/${shared.body.postId}`)).body;
    expect(receipt.real.captureId).toBe(r.id);
    expect(receipt.real.authenticity).toMatchObject({
      edited: true,
      method: 'in_app_token',
      device_attested: false,
    });
    expect(receipt.real.indicators).toHaveLength(4);
    expect((await s.client.get(`/v1/real/posts/${shared.body.postId}`)).status).toBe(404); // cannot see the post
    expect((await new Client(t).get(`/v1/real/posts/${shared.body.postId}`)).status).toBe(404);
    expect(
      (await a.client.post(`/v1/real/captures/${r.id}/share`, { visibility: 'friends' })).status,
    ).toBe(409);
    expect((await a.client.get(`/v1/real/captures/${r.id}`)).body.sharedPostId).toBe(
      shared.body.postId,
    );
    // the post's media is now readable to friends through the post, and the Real itself stays private
    expect(await seen(f.client, r.id)).toBe(false);
    expect(await canViewMedia(t.ctx.db, f.id, r.front.id)).toBe(true);
    // deleting the profile post frees the Real to be shared again
    expect((await a.client.del(`/v1/posts/${shared.body.postId}`)).status).toBe(204);
    const again = await a.client.post(`/v1/real/captures/${r.id}/share`, {
      visibility: 'friends',
      include: 'rear',
    });
    expect(again.status).toBe(201);
    expect((await f.client.get(`/v1/posts/${again.body.postId}`)).body.kind).toBe('photo');
    expect(await auditCount(t, 'real.shared_to_profile', r.id)).toBe(2);
  });

  it('teens cannot share publicly; location travels only when asked', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    const r = await capture(teen, { visibility: 'friends' });
    expect(
      (await teen.client.post(`/v1/real/captures/${r.id}/share`, { visibility: 'public' })).status,
    ).toBe(422);
    const adult = await signup(t);
    const ar = await capture(adult, { latitude: 10, longitude: 20 });
    const p1 = await adult.client.post(`/v1/real/captures/${ar.id}/share`, {
      visibility: 'private',
      include: 'front',
    });
    expect((await adult.client.get(`/v1/posts/${p1.body.postId}`)).body.location).toBeNull();
    const ar2 = await capture(adult, { latitude: 10, longitude: 20 });
    const p2 = await adult.client.post(`/v1/real/captures/${ar2.id}/share`, {
      visibility: 'private',
      includeLocation: true,
    });
    expect((await adult.client.get(`/v1/posts/${p2.body.postId}`)).body.location).toEqual({
      latitude: 10,
      longitude: 20,
    });
  });
});

describe('tray', () => {
  it("shows friends' recent Reals only: no strangers, blockers, muted users, private ones or old ones", async () => {
    const me = await signup(t);
    const f1 = await signup(t);
    const f2 = await signup(t);
    const f3 = await signup(t);
    const f4 = await signup(t);
    const stranger = await signup(t);
    for (const f of [f1, f2, f3, f4]) await befriend(me, f);
    const r1a = await capture(f1, { visibility: 'friends' });
    await capture(f1, { visibility: 'friends' });
    await capture(f2, { visibility: 'private' });
    const old = await capture(f3, { visibility: 'friends' });
    await sql(`UPDATE real_captures SET captured_at = now() - interval '3 days' WHERE id = $1`, [
      old.id,
    ]);
    await capture(f4, { visibility: 'friends' });
    await capture(stranger, { visibility: 'public' });
    await me.client.put(`/v1/users/${f4.username}/mute`);
    await capture(me, { visibility: 'friends' });
    const tray = (await me.client.get('/v1/real/tray')).body;
    expect(tray.items.map((g: any) => g.author.username)).toEqual([f1.username]);
    expect(tray.items[0].count).toBe(2);
    expect(tray.items[0].items.map((i: any) => i.id)).toContain(r1a.id);
    expect(JSON.stringify(tray)).not.toMatch(/unread|streak|missed/i);
    await block(f1, me);
    expect((await me.client.get('/v1/real/tray')).body.items).toEqual([]);
    expect((await new Client(t).get('/v1/real/tray')).status).toBe(401);
  });
});

describe('reminders (opt-in, quiet-hours aware, no pressure)', () => {
  const at = (iso: string) => new Date(iso);
  it('are off by default and validate input', async () => {
    const a = await signup(t);
    expect((await a.client.get('/v1/real/reminders')).body).toMatchObject({
      enabled: false,
      days: [],
    });
    expect((await a.client.put('/v1/real/reminders', { enabled: true, days: [7] })).status).toBe(
      400,
    );
    expect(
      (
        await a.client.put('/v1/real/reminders', {
          enabled: true,
          days: [1],
          timezone: 'Mars/Base',
        })
      ).status,
    ).toBe(400);
    expect(
      (await a.client.put('/v1/real/reminders', { enabled: true, days: [1], localMinute: 2000 }))
        .status,
    ).toBe(400);
    expect((await new Client(t).put('/v1/real/reminders', { enabled: false })).status).toBe(401);
  });

  it('send once on the chosen day/time, never to non-opted-in users, and drop late ones', async () => {
    const a = await signup(t);
    const off = await signup(t);
    // 2026-03-02 is a Monday. 18:00 UTC = minute 1080.
    expect(
      (
        await a.client.put('/v1/real/reminders', {
          enabled: true,
          days: [1],
          localMinute: 1080,
          timezone: 'UTC',
        })
      ).status,
    ).toBe(200);
    await off.client.put('/v1/real/reminders', {
      enabled: false,
      days: [1],
      localMinute: 1080,
      timezone: 'UTC',
    });
    const before = await notifCount(t, a.id, 'real_reminder');
    const count = () => notifCount(t, a.id, 'real_reminder');
    await runRealReminders(t.ctx, at('2026-03-02T17:59:00Z')); // too early
    await runRealReminders(t.ctx, at('2026-03-03T18:00:00Z')); // Tuesday: not a chosen day
    await runRealReminders(t.ctx, at('2026-03-02T19:30:00Z')); // an hour and a half late: dropped, not queued
    expect(await count()).toBe(before);
    await runRealReminders(t.ctx, at('2026-03-02T18:05:00Z'));
    expect(await count()).toBe(before + 1);
    await runRealReminders(t.ctx, at('2026-03-02T18:06:00Z')); // once per day
    expect(await count()).toBe(before + 1);
    expect(await notifCount(t, off.id, 'real_reminder')).toBe(0);
    const n = (
      await sql(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'real_reminder'`, [
        a.id,
      ])
    ).rows[0].data;
    expect(JSON.stringify(n)).not.toMatch(/streak|miss|friends|everyone|hurry/i);
  });

  it("respect quiet hours, pause, and a Real captured in the last hours; use the person's time zone", async () => {
    const q = await signup(t);
    await q.client.put('/v1/real/reminders', {
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      localMinute: 1320,
      timezone: 'UTC',
    }); // 22:00
    await sql(
      `INSERT INTO user_preferences (user_id, quiet_hours_start, quiet_hours_end) VALUES ($1, 1260, 420) ON CONFLICT (user_id) DO UPDATE SET quiet_hours_start = 1260, quiet_hours_end = 420`,
      [q.id],
    );
    await runRealReminders(t.ctx, at('2026-03-04T22:10:00Z')); // inside 21:00-07:00
    expect(await notifCount(t, q.id, 'real_reminder')).toBe(0);

    const p = await signup(t);
    await p.client.put('/v1/real/reminders', {
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      localMinute: 600,
      timezone: 'UTC',
    });
    await sql(
      `INSERT INTO user_preferences (user_id, notifications_paused_until) VALUES ($1, '2030-01-01') ON CONFLICT (user_id) DO UPDATE SET notifications_paused_until = '2030-01-01'`,
      [p.id],
    );
    await runRealReminders(t.ctx, at('2026-03-05T10:10:00Z'));
    expect(await notifCount(t, p.id, 'real_reminder')).toBe(0);

    const c = await signup(t);
    await c.client.put('/v1/real/reminders', {
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      localMinute: 600,
      timezone: 'UTC',
    });
    await capture(c);
    await runRealReminders(t.ctx, new Date());
    expect(await notifCount(t, c.id, 'real_reminder')).toBe(0); // just captured: no nudge

    const z = await signup(t);
    await z.client.put('/v1/real/reminders', {
      enabled: true,
      days: [1],
      localMinute: 540,
      timezone: 'Asia/Tokyo',
    }); // Monday 09:00 JST = Monday 00:00 UTC
    await runRealReminders(t.ctx, at('2026-03-02T00:10:00Z'));
    expect(await notifCount(t, z.id, 'real_reminder')).toBe(1);
  });

  it('a user can switch them off again', async () => {
    const a = await signup(t);
    await a.client.put('/v1/real/reminders', {
      enabled: true,
      days: [1],
      localMinute: 1080,
      timezone: 'UTC',
    });
    await a.client.put('/v1/real/reminders', {
      enabled: false,
      days: [1],
      localMinute: 1080,
      timezone: 'UTC',
    });
    await runRealReminders(t.ctx, at('2026-03-09T18:05:00Z'));
    expect(await notifCount(t, a.id, 'real_reminder')).toBe(0);
  });
});

describe('feature flag and account deletion', () => {
  it('REAL off hides every endpoint; on restores them', async () => {
    const a = await signup(t);
    const r = await capture(a);
    await setFlag('REAL', false);
    try {
      for (const [m, url, body] of [
        ['post', '/v1/real/capture-sessions', { deviceId: 'device-12345678' }],
        ['get', '/v1/real/captures', undefined],
        ['get', '/v1/real/tray', undefined],
        ['get', `/v1/real/captures/${r.id}`, undefined],
        ['get', '/v1/real/reminders', undefined],
        ['post', `/v1/real/captures/${r.id}/share`, { visibility: 'private' }],
      ] as const) {
        const res = m === 'post' ? await a.client.post(url, body) : await a.client.get(url);
        expect([res.status, res.body?.error?.code]).toEqual([404, 'feature_disabled']);
      }
      expect((await new Client(t).get(`/v1/real/captures/${r.id}`)).status).toBe(404);
    } finally {
      await setFlag('REAL', true);
    }
    expect((await a.client.get(`/v1/real/captures/${r.id}`)).status).toBe(200);
  });

  it("account deletion removes the person's Reals, reactions, reminders and sessions", async () => {
    const a = await signup(t);
    const f = await signup(t);
    await befriend(a, f);
    const r = await capture(a, { caption: 'secret', latitude: 1, longitude: 2 });
    await f.client.put(`/v1/real/captures/${r.id}/reaction`, { kind: 'like' });
    await a.client.put('/v1/real/reminders', {
      enabled: true,
      days: [1],
      localMinute: 60,
      timezone: 'UTC',
    });
    await withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, a.id);
    });
    const row = (
      await sql('SELECT caption, latitude, deleted_at FROM real_captures WHERE id = $1', [r.id])
    ).rows[0];
    expect(row).toMatchObject({ caption: '', latitude: null });
    expect(row.deleted_at).not.toBeNull();
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM real_reminder_settings WHERE user_id = $1', [
          a.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await sql('SELECT count(*)::int AS n FROM real_capture_sessions WHERE user_id = $1', [a.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await sql('SELECT count(*)::int AS n FROM real_reactions WHERE capture_id = $1', [r.id]))
        .rows[0].n,
    ).toBe(0);
  });
});
