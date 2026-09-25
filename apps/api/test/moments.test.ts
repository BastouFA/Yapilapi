import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTransaction } from '@yapilapi/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { getMediaRuntime } from '../src/modules/media/index.js';
import { expireMoments } from '../src/modules/moments/index.js';
import { Client, createTestApp, signup, type TestApp, type TestUser } from './helpers.js';
import { pathOf, png, raw, upload, wav } from './media-fixtures.js';

let t: TestApp;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'yl-moments-test-'));
  t = await createTestApp({ MEDIA_LOCAL_DIR: dir });
});
afterAll(async () => {
  await getMediaRuntime(t.ctx).queue.idle();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
const follow = (a: TestUser, b: TestUser) => a.client.put(`/v1/users/${b.username}/follow`);
const befriend = async (a: TestUser, b: TestUser) => {
  await a.client.post('/v1/friends/requests', { username: b.username });
  await b.client.post(`/v1/friends/requests/${a.id}/accept`);
};
const teen = () => signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
const moment = async (u: TestUser, body: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/moments', { kind: 'text', body: 'hello', ...body });
  if (r.status !== 201) throw new Error(`moment failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const expireNow = (id: string) =>
  sql(`UPDATE moments SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
const canSee = async (v: Client, id: string) => (await v.get(`/v1/moments/${id}`)).status === 200;
async function mediaFor(u: TestUser, data: Buffer) {
  const up = await upload(t, u, data);
  if (up.status !== 201) throw new Error(`upload failed ${JSON.stringify(up.body)}`);
  await getMediaRuntime(t.ctx).queue.idle();
  return up.body as { id: string; url: string };
}
const trayAuthors = async (u: TestUser) =>
  (await u.client.get('/v1/moments/tray')).body.items.map((g: any) => g.author.username);

describe('creating moments', () => {
  it('creates text moments with sensible defaults', async () => {
    const a = await signup(t);
    const before = Date.now();
    const m = await moment(a);
    expect(m).toMatchObject({
      kind: 'text',
      body: 'hello',
      visibility: 'friends',
      expiry: '24h',
      media: null,
      viewer: { isAuthor: true },
      counts: { reactions: 0, views: 0 },
    });
    const exp = new Date(m.expiresAt).getTime();
    expect(exp).toBeGreaterThan(before + 24 * 3600_000 - 5000);
    expect(exp).toBeLessThan(Date.now() + 24 * 3600_000 + 5000);
    expect((await moment(a, { expiry: '1h' })).expiresAt).toBeTruthy();
    expect((await moment(a, { expiry: 'permanent' })).expiresAt).toBeNull();
    const custom = new Date(Date.now() + 3 * 3600_000).toISOString();
    expect((await moment(a, { expiry: 'custom', expiresAt: custom })).expiresAt).toBe(custom);
  });

  it('validates expiry bounds', async () => {
    const a = await signup(t);
    const post = (b: Record<string, unknown>) =>
      a.client.post('/v1/moments', { kind: 'text', body: 'x', ...b });
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect((await post({ expiry: 'custom' })).status).toBe(400);
    expect((await post({ expiry: 'custom', expiresAt: at(60_000) })).status).toBe(400); // < 15 minutes
    expect((await post({ expiry: 'custom', expiresAt: at(8 * 86400_000) })).status).toBe(400); // > 7 days
    expect((await post({ expiry: 'custom', expiresAt: at(-3600_000) })).status).toBe(400);
    expect((await post({ expiry: '24h', expiresAt: at(3600_000) })).status).toBe(400);
    expect((await post({ expiry: 'permanent', expiresAt: at(3600_000) })).status).toBe(400);
    expect((await post({ expiry: 'forever' })).status).toBe(400);
    expect((await post({ expiry: 'custom', expiresAt: 'tomorrow' })).status).toBe(400);
    expect((await post({ expiry: 'custom', expiresAt: at(20 * 60_000) })).status).toBe(201);
  });

  it('validates content, audience and visibility rules', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const blocked = await signup(t);
    await a.client.put(`/v1/users/${blocked.username}/block`);
    const post = (body: Record<string, unknown>) => a.client.post('/v1/moments', body);
    expect((await post({ kind: 'text', body: '   ' })).status).toBe(400);
    expect((await post({ kind: 'text', body: 'x'.repeat(2001) })).status).toBe(400);
    expect((await post({ kind: 'photo' })).status).toBe(400);
    expect(
      (await post({ kind: 'text', body: 'x', mediaId: '00000000-0000-4000-8000-000000000000' }))
        .status,
    ).toBe(400);
    expect(
      (await post({ kind: 'photo', mediaId: '00000000-0000-4000-8000-000000000000' })).status,
    ).toBe(400);
    expect((await post({ kind: 'bogus', body: 'x' })).status).toBe(400);
    expect((await post({ kind: 'text', body: 'x', visibility: 'circle' })).status).toBe(400);
    expect((await post({ kind: 'text', body: 'x', visibility: 'selected' })).status).toBe(400);
    expect(
      (await post({ kind: 'text', body: 'x', visibility: 'friends', audience: [b.id] })).status,
    ).toBe(400);
    expect(
      (await post({ kind: 'text', body: 'x', visibility: 'selected', audience: [blocked.id] }))
        .status,
    ).toBe(400);
    expect((await post({ kind: 'text', body: 'x', visibility: 'private' })).status).toBe(400);
    expect(
      (
        await post({
          kind: 'text',
          body: 'x',
          visibility: 'circle',
          circleId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect((await post({ kind: 'text', body: 'x', latitude: 10 })).status).toBe(400);
    expect((await post({ kind: 'text', body: 'x', latitude: 100, longitude: 10 })).status).toBe(
      400,
    );
    expect(
      (await post({ kind: 'text', body: 'x', placeId: '00000000-0000-4000-8000-000000000000' }))
        .status,
    ).toBe(404);
    expect((await post({ kind: 'text', body: 'x', music: { title: '' } })).status).toBe(400);
    expect((await new Client(t).post('/v1/moments', { kind: 'text', body: 'x' })).status).toBe(401);
    // someone else's circle
    const circle = (await b.client.post('/v1/circles', { kind: 'close_friends', name: 'B-CF' }))
      .body;
    expect(
      (await post({ kind: 'text', body: 'x', visibility: 'circle', circleId: circle.id })).status,
    ).toBe(404);
  });

  it('accepts music metadata, location (rounded for other viewers) and a place', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    await befriend(a, friend);
    const m = await moment(a, {
      body: 'sunset',
      music: {
        title: 'Golden Hour',
        artist: 'Someone',
        provider: 'manual',
        startMs: 12000,
        durationMs: 15000,
      },
      latitude: 51.507351,
      longitude: -0.127758,
    });
    expect(m.music).toMatchObject({ title: 'Golden Hour', artist: 'Someone', startMs: 12000 });
    expect(m.location).toEqual({ latitude: 51.507351, longitude: -0.127758 }); // author sees exact
    const seen = (await friend.client.get(`/v1/moments/${m.id}`)).body;
    expect(seen.location).toEqual({ latitude: 51.507, longitude: -0.128 }); // ~110 m for everyone else
    expect(seen.moderationStatus).toBeUndefined();
    expect(seen.counts.views).toBeUndefined();
    expect(seen.circleId).toBeNull();
  });

  it('attaches owned, unused media of the matching kind', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const img = await mediaFor(a, await png());
    const theirs = await mediaFor(b, await png('blue'));
    const audio = await mediaFor(a, wav());
    expect((await a.client.post('/v1/moments', { kind: 'photo', mediaId: theirs.id })).status).toBe(
      400,
    ); // not yours
    expect((await a.client.post('/v1/moments', { kind: 'video', mediaId: img.id })).status).toBe(
      400,
    ); // wrong kind
    expect((await a.client.post('/v1/moments', { kind: 'photo', mediaId: audio.id })).status).toBe(
      400,
    );
    const ok = await moment(a, { kind: 'photo', mediaId: img.id, body: 'look' });
    expect(ok).toMatchObject({ kind: 'photo', media: { id: img.id, kind: 'image', url: img.url } });
    expect((await a.client.post('/v1/moments', { kind: 'photo', mediaId: img.id })).status).toBe(
      400,
    ); // already used
    expect((await moment(a, { kind: 'audio', mediaId: audio.id })).media.kind).toBe('audio');
    const pub = await mediaFor(a, await png('green'));
    await sql(`UPDATE media SET purpose = 'public' WHERE id = $1`, [pub.id]);
    expect((await a.client.post('/v1/moments', { kind: 'photo', mediaId: pub.id })).status).toBe(
      400,
    ); // public profile media stays out
    const deleted = await mediaFor(a, await png('red'));
    await a.client.del(`/v1/media/${deleted.id}`);
    expect(
      (await a.client.post('/v1/moments', { kind: 'photo', mediaId: deleted.id })).status,
    ).toBe(400);
  });

  it('enforces teen rules: no public moments, no location; friends by default', async () => {
    const k = await teen();
    expect(
      (await k.client.post('/v1/moments', { kind: 'text', body: 'hi', visibility: 'public' }))
        .status,
    ).toBe(422);
    expect(
      (await k.client.post('/v1/moments', { kind: 'text', body: 'hi', latitude: 1, longitude: 2 }))
        .status,
    ).toBe(422);
    const ok = await k.client.post('/v1/moments', { kind: 'text', body: 'hi' });
    expect(ok.status).toBe(201);
    expect(ok.body.visibility).toBe('friends');
    expect(
      (await k.client.post('/v1/moments', { kind: 'text', body: 'hi', visibility: 'followers' }))
        .status,
    ).toBe(201);
  });

  it('private accounts cannot create public moments', async () => {
    const a = await signup(t);
    await a.client.patch('/v1/profile', { isPrivate: true });
    expect(
      (await a.client.post('/v1/moments', { kind: 'text', body: 'x', visibility: 'public' }))
        .status,
    ).toBe(422);
    expect(
      (await a.client.post('/v1/moments', { kind: 'text', body: 'x', visibility: 'followers' }))
        .status,
    ).toBe(201);
  });

  it('screens text: risky moments are held for review and invisible to others', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    await befriend(a, friend);
    const m = await moment(a, { body: "I'm going to kill you", visibility: 'friends' });
    expect(m.moderationStatus).not.toBe('approved');
    expect(await canSee(friend.client, m.id)).toBe(false);
    expect(
      (
        await sql(
          `SELECT 1 FROM moderation_cases WHERE target_type = 'moment' AND target_id = $1`,
          [m.id],
        )
      ).rowCount,
    ).toBe(1);
  });
});

describe('visibility matrix', () => {
  it('enforces every audience rule for every kind of viewer, for reads, lists and reactions', async () => {
    const author = await signup(t);
    const follower = await signup(t);
    const friend = await signup(t);
    const circleMember = await signup(t);
    const selected = await signup(t);
    const stranger = await signup(t);
    const blocked = await signup(t);
    const anon = new Client(t);
    await follow(follower, author);
    await befriend(author, friend);
    const circle = (await author.client.post('/v1/circles', { kind: 'close_friends', name: 'CF' }))
      .body;
    await author.client.put(`/v1/circles/${circle.id}/members/${circleMember.id}`);
    await author.client.put(`/v1/users/${blocked.username}/block`);

    const ms = [
      await moment(author, { body: 'public', visibility: 'public' }),
      await moment(author, { body: 'followers', visibility: 'followers' }),
      await moment(author, { body: 'friends', visibility: 'friends' }),
      await moment(author, { body: 'circle', visibility: 'circle', circleId: circle.id }),
      await moment(author, { body: 'selected', visibility: 'selected', audience: [selected.id] }),
    ];
    const matrix: Array<[string, Client, boolean[]]> = [
      //                      pub    fol    fri    cir    sel
      ['author', author.client, [true, true, true, true, true]],
      ['follower', follower.client, [true, true, false, false, false]],
      ['friend', friend.client, [true, false, true, false, false]],
      ['circle member', circleMember.client, [true, false, false, true, false]],
      ['selected', selected.client, [true, false, false, false, true]],
      ['stranger', stranger.client, [true, false, false, false, false]],
      ['blocked', blocked.client, [false, false, false, false, false]],
      ['anonymous', anon, [true, false, false, false, false]],
    ];
    for (const [who, client, expected] of matrix) {
      const actual = await Promise.all(ms.map((m) => canSee(client, m.id)));
      expect({ who, actual }).toEqual({ who, actual: expected });
    }
    // Profile list obeys the same rules.
    const listed = async (c: Client) => {
      const items = (await c.get(`/v1/users/${author.username}/moments`)).body.items as
        Array<{ body: string }> | undefined;
      return items ? items.map((m) => m.body).sort() : null;
    };
    expect(await listed(stranger.client)).toEqual(['public']);
    expect(await listed(friend.client)).toEqual(['friends', 'public']);
    expect(await listed(anon)).toEqual(['public']);
    expect(await listed(selected.client)).toEqual(['public', 'selected']);
    expect(await listed(blocked.client)).toBeNull(); // 404
    // Interacting requires visibility too.
    expect(
      (await stranger.client.put(`/v1/moments/${ms[2].id}/reaction`, { kind: 'love' })).status,
    ).toBe(404);
    expect((await stranger.client.post(`/v1/moments/${ms[2].id}/view`)).status).toBe(404);
    expect(
      (await friend.client.put(`/v1/moments/${ms[2].id}/reaction`, { kind: 'love' })).status,
    ).toBe(200);
    expect((await anon.post(`/v1/moments/${ms[0].id}/view`)).status).toBe(401);
  });

  it('a private account\'s "public" moments are only visible to followers', async () => {
    const a = await signup(t);
    const fol = await signup(t);
    const stranger = await signup(t);
    const m = await moment(a, { body: 'quiet', visibility: 'public' });
    await follow(fol, a);
    expect(await canSee(stranger.client, m.id)).toBe(true);
    await a.client.patch('/v1/profile', { isPrivate: true });
    expect(await canSee(stranger.client, m.id)).toBe(false);
    expect(await canSee(new Client(t), m.id)).toBe(false);
    expect(await canSee(fol.client, m.id)).toBe(true);
  });

  it("serves a moment's media only to its audience (real upload path)", async () => {
    const a = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(a, friend);
    const img = await mediaFor(a, await png('teal'));
    const m = await moment(a, { kind: 'photo', mediaId: img.id, visibility: 'friends' });
    const get = (u: TestUser | null) => raw(t, u, 'GET', pathOf(m.media.url)).then((r) => r.status);
    expect(await get(friend)).toBe(200);
    expect(await get(a)).toBe(200);
    expect(await get(stranger)).toBe(404);
    expect(await get(null)).toBe(404);
  });
});

describe('expiry', () => {
  it('expired moments are invisible immediately, everywhere, without waiting for cleanup', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    await befriend(a, friend);
    const m = await moment(a, { body: 'ephemeral', expiry: '1h' });
    expect(await canSee(friend.client, m.id)).toBe(true);
    expect(await trayAuthors(friend)).toContain(a.username);
    await expireNow(m.id);
    expect(await canSee(friend.client, m.id)).toBe(false);
    expect(await canSee(a.client, m.id)).toBe(false);
    expect(await trayAuthors(friend)).not.toContain(a.username);
    expect((await friend.client.get(`/v1/users/${a.username}/moments`)).body.items).toEqual([]);
    expect((await friend.client.post(`/v1/moments/${m.id}/view`)).status).toBe(404);
    expect((await friend.client.put(`/v1/moments/${m.id}/reaction`, {})).status).toBe(404);
    expect((await a.client.get(`/v1/moments/${m.id}/viewers`)).status).toBe(404);
  });

  it('permanent moments never expire', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    await befriend(a, friend);
    const m = await moment(a, { expiry: 'permanent' });
    await sql(`UPDATE moments SET created_at = now() - interval '400 days' WHERE id = $1`, [m.id]);
    expect(await canSee(friend.client, m.id)).toBe(true);
    await expireMoments(t.ctx);
    expect(await canSee(friend.client, m.id)).toBe(true);
  });

  it('expireMoments deletes media and minimises data of expired moments only, and is idempotent', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    await befriend(a, friend);
    const adapter = getMediaRuntime(t.ctx).adapter;

    const img = await mediaFor(a, await png('olive'));
    const expiring = await moment(a, {
      kind: 'photo',
      mediaId: img.id,
      body: 'secret text',
      latitude: 1,
      longitude: 2,
      music: { title: 'Song' },
      expiry: '1h',
    });
    await friend.client.post(`/v1/moments/${expiring.id}/view`);
    await friend.client.put(`/v1/moments/${expiring.id}/reaction`, { kind: 'like' });
    const key = pathOf(expiring.media.url).replace('/media/', '');
    expect(await adapter.stat(key)).not.toBeNull();

    const liveImg = await mediaFor(a, await png('lime'));
    const live = await moment(a, { kind: 'photo', mediaId: liveImg.id, expiry: '24h' });
    const permImg = await mediaFor(a, await png('pink'));
    const perm = await moment(a, { kind: 'photo', mediaId: permImg.id, expiry: 'permanent' });

    // A moment whose media has since been used by something else keeps the file.
    const sharedImg = await mediaFor(a, await png('gold'));
    const shared = await moment(a, { kind: 'photo', mediaId: sharedImg.id, expiry: '1h' });
    const conv = (await a.client.post('/v1/conversations/direct', { userId: friend.id })).body.id;
    const msgId = (
      await sql<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_id, kind) VALUES ($1,$2,'media') RETURNING id`,
        [conv, a.id],
      )
    ).rows[0]!.id;
    await sql('INSERT INTO message_attachments (message_id, media_id) VALUES ($1,$2)', [
      msgId,
      sharedImg.id,
    ]);

    await expireNow(expiring.id);
    await expireNow(shared.id);
    const r = await expireMoments(t.ctx);
    expect(r).toMatchObject({ moments: 2, media: 1 });

    expect(await adapter.stat(key)).toBeNull(); // bytes gone
    expect(
      (await sql('SELECT deleted_at, purged_at FROM media WHERE id = $1', [img.id])).rows[0],
    ).toMatchObject({ deleted_at: expect.any(Date), purged_at: expect.any(Date) });
    expect(
      (await sql('SELECT deleted_at FROM media WHERE id = $1', [sharedImg.id])).rows[0].deleted_at,
    ).toBeNull();
    expect(
      (
        await sql(
          'SELECT body, music, latitude, longitude, deleted_at FROM moments WHERE id = $1',
          [expiring.id],
        )
      ).rows[0],
    ).toMatchObject({
      body: '',
      music: null,
      latitude: null,
      longitude: null,
      deleted_at: expect.any(Date),
    });
    expect(
      (await sql('SELECT count(*)::int AS n FROM moment_views WHERE moment_id = $1', [expiring.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM reactions WHERE target_type = 'moment' AND target_id = $1`,
          [expiring.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // live and permanent moments are untouched
    expect(await canSee(friend.client, live.id)).toBe(true);
    expect(await canSee(friend.client, perm.id)).toBe(true);
    expect((await raw(t, friend, 'GET', pathOf(live.media.url))).status).toBe(200);
    expect((await raw(t, friend, 'GET', pathOf(perm.media.url))).status).toBe(200);
    // idempotent
    expect(await expireMoments(t.ctx)).toEqual({ moments: 0, media: 0 });
  });

  it('processes more than one batch', async () => {
    const a = await signup(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await moment(a, { expiry: '1h' })).id);
    await sql(
      `UPDATE moments SET expires_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const r = await expireMoments(t.ctx, { batchSize: 2 });
    expect(r.moments).toBeGreaterThanOrEqual(5);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM moments WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [ids],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('can be run from scripts/expire-moments.ts', async () => {
    const a = await signup(t);
    const m = await moment(a, { expiry: '1h', body: 'from the script' });
    await expireNow(m.id);
    const out = execFileSync('npx', ['tsx', 'scripts/expire-moments.ts'], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        MEDIA_LOCAL_DIR: dir,
        LOG_LEVEL: 'silent',
        RATE_LIMIT_ENABLED: 'false',
        REDIS_URL: '',
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out).toMatch(/expired moments: \d+, media deleted: \d+/);
    expect(
      (await sql('SELECT deleted_at, body FROM moments WHERE id = $1', [m.id])).rows[0],
    ).toMatchObject({ body: '', deleted_at: expect.any(Date) });
  }, 90_000);
});

describe('moment tray', () => {
  it('groups by author, unseen first, and honours follows, friends, mutes and blocks', async () => {
    const me = await signup(t);
    const [fol, fri, both, muted, blockedByMe, blocksMe, stranger, followsMeOnly] =
      await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    await follow(me, fol!);
    await befriend(me, fri!);
    await follow(me, both!);
    await befriend(me, both!);
    await follow(me, muted!);
    await follow(me, blockedByMe!);
    await follow(me, blocksMe!);
    await follow(followsMeOnly!, me);
    await me.client.put(`/v1/users/${muted!.username}/mute`);
    await me.client.put(`/v1/users/${blockedByMe!.username}/block`);
    await blocksMe!.client.put(`/v1/users/${me.username}/block`);

    const seedOrder: Array<[TestUser, string, Record<string, unknown>]> = [
      [fol!, 'fol-1', { visibility: 'followers' }],
      [fri!, 'fri-1', { visibility: 'friends' }],
      [both!, 'both-1', { visibility: 'public' }],
      [muted!, 'muted-1', { visibility: 'followers' }],
      [stranger!, 'stranger-1', { visibility: 'public' }], // public, but I do not follow them
      [fol!, 'fol-2', { visibility: 'followers' }],
      [fol!, 'fol-private-to-friends', { visibility: 'friends' }], // fol is only followed, so not visible
      [me, 'mine', { visibility: 'public' }],
    ];
    for (const [u, body, extra] of seedOrder) await moment(u, { body, ...extra });
    await moment(blockedByMe!, { body: 'bbm', visibility: 'public' });
    await moment(blocksMe!, { body: 'bm', visibility: 'public' });
    await moment(followsMeOnly!, { body: 'fmo', visibility: 'public' });

    const tray = (await me.client.get('/v1/moments/tray')).body;
    const names = tray.items.map((g: any) => g.author.username);
    expect(new Set(names)).toEqual(new Set([fol!.username, fri!.username, both!.username]));
    expect(names).toHaveLength(3);
    expect(tray.hasMore).toBe(false);
    const folGroup = tray.items.find((g: any) => g.author.username === fol!.username);
    expect(folGroup.moments.map((m: any) => m.body)).toEqual(['fol-1', 'fol-2']); // play order: oldest first
    expect(folGroup).toMatchObject({ hasUnseen: true, unseenCount: 2 });
    // Unauthenticated / other validation
    expect((await new Client(t).get('/v1/moments/tray')).status).toBe(401);
    expect((await me.client.get('/v1/moments/tray', { limit: '0' })).status).toBe(400);
    // Muted people are hidden from the tray but still reachable on their profile.
    expect((await me.client.get(`/v1/users/${muted!.username}/moments`)).body.items).toHaveLength(
      1,
    );
    // And nothing is leaked about a block in either direction.
    expect((await me.client.get(`/v1/users/${blocksMe!.username}/moments`)).status).toBe(404);
  });

  it('puts authors with unseen moments first (newest first) and moves fully-seen authors to the back', async () => {
    const me = await signup(t);
    const x = await signup(t);
    const y = await signup(t);
    const z = await signup(t);
    for (const u of [x, y, z]) await follow(me, u);
    const mx = await moment(x, { body: 'x1', visibility: 'followers' });
    const my = await moment(y, { body: 'y1', visibility: 'followers' });
    await new Promise((r) => setTimeout(r, 15));
    const mz = await moment(z, { body: 'z1', visibility: 'followers' });
    expect(await trayAuthors(me)).toEqual([z.username, y.username, x.username]); // all unseen: newest first

    expect((await me.client.post(`/v1/moments/${mz.id}/view`)).status).toBe(204);
    expect(await trayAuthors(me)).toEqual([y.username, x.username, z.username]); // z fully seen -> back
    expect((await me.client.post(`/v1/moments/${mz.id}/view`)).status).toBe(204); // idempotent
    expect(
      (await sql('SELECT count(*)::int AS n FROM moment_views WHERE moment_id = $1', [mz.id]))
        .rows[0].n,
    ).toBe(1);

    // A new moment from z flips z back to the front.
    await new Promise((r) => setTimeout(r, 15));
    await moment(z, { body: 'z2', visibility: 'followers' });
    const tray = (await me.client.get('/v1/moments/tray')).body;
    expect(tray.items.map((g: any) => g.author.username)).toEqual([
      z.username,
      y.username,
      x.username,
    ]);
    const zg = tray.items[0];
    expect(zg).toMatchObject({ hasUnseen: true, unseenCount: 1 });
    expect(zg.moments.map((m: any) => [m.body, m.viewer.seen])).toEqual([
      ['z1', true],
      ['z2', false],
    ]);
    expect(mx.id && my.id).toBeTruthy();
    // Group limit + hasMore
    const limited = (await me.client.get('/v1/moments/tray', { limit: '2' })).body;
    expect(limited.items).toHaveLength(2);
    expect(limited.hasMore).toBe(true);
  });

  it('includes media and does not count your own views', async () => {
    const me = await signup(t);
    const a = await signup(t);
    await follow(me, a);
    const img = await mediaFor(a, await png('brown'));
    const m = await moment(a, { kind: 'photo', mediaId: img.id, visibility: 'followers' });
    const tray = (await me.client.get('/v1/moments/tray')).body;
    expect(tray.items[0].moments[0].media).toMatchObject({
      id: img.id,
      kind: 'image',
      url: img.url,
    });
    expect((await a.client.post(`/v1/moments/${m.id}/view`)).status).toBe(204);
    expect(
      (await sql('SELECT count(*)::int AS n FROM moment_views WHERE moment_id = $1', [m.id]))
        .rows[0].n,
    ).toBe(0);
  });
});

describe('views, viewers and reactions', () => {
  it('only the author sees who viewed, with reactions and pagination; blocked viewers vanish', async () => {
    const a = await signup(t);
    const v1 = await signup(t);
    const v2 = await signup(t);
    const v3 = await signup(t);
    for (const v of [v1, v2, v3]) await follow(v, a);
    const m = await moment(a, { visibility: 'followers' });
    for (const v of [v1, v2, v3]) {
      expect((await v.client.post(`/v1/moments/${m.id}/view`)).status).toBe(204);
      await new Promise((r) => setTimeout(r, 5));
    }
    await v2.client.put(`/v1/moments/${m.id}/reaction`, { kind: 'love' });

    const p1 = await a.client.get(`/v1/moments/${m.id}/viewers`, { limit: '2' });
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i: any) => i.user.username)).toEqual([v3.username, v2.username]); // newest first
    expect(p1.body.items[1].reaction).toBe('love');
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await a.client.get(`/v1/moments/${m.id}/viewers`, {
      limit: '2',
      cursor: p1.body.nextCursor,
    });
    expect(p2.body.items.map((i: any) => i.user.username)).toEqual([v1.username]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await a.client.get(`/v1/moments/${m.id}`)).body.counts).toEqual({
      reactions: 1,
      views: 3,
    });

    // Not for viewers, strangers or anonymous.
    expect((await v1.client.get(`/v1/moments/${m.id}/viewers`)).status).toBe(404);
    expect((await new Client(t).get(`/v1/moments/${m.id}/viewers`)).status).toBe(401);
    expect((await v1.client.get(`/v1/moments/${m.id}`)).body.counts).toEqual({ reactions: 1 }); // views hidden from others

    await a.client.put(`/v1/users/${v1.username}/block`);
    const after = await a.client.get(`/v1/moments/${m.id}/viewers`);
    expect(after.body.items.map((i: any) => i.user.username)).not.toContain(v1.username);
  });

  it('reactions: set, change, remove; counted; notify the author once', async () => {
    const a = await signup(t);
    const f = await signup(t);
    await follow(f, a);
    const m = await moment(a, { visibility: 'followers' });
    expect((await f.client.put(`/v1/moments/${m.id}/reaction`, { kind: 'love' })).body).toEqual({
      reaction: 'love',
    });
    expect((await f.client.put(`/v1/moments/${m.id}/reaction`, { kind: 'wow' })).status).toBe(200);
    const view = (await f.client.get(`/v1/moments/${m.id}`)).body;
    expect(view.viewer.reaction).toBe('wow');
    expect(view.counts.reactions).toBe(1);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'moment_reaction' AND target_id = $2`,
          [a.id, m.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await f.client.put(`/v1/moments/${m.id}/reaction`, { kind: 'bogus' })).status).toBe(
      400,
    );
    expect((await new Client(t).put(`/v1/moments/${m.id}/reaction`, {})).status).toBe(401);
    expect((await f.client.del(`/v1/moments/${m.id}/reaction`)).status).toBe(204);
    expect((await f.client.get(`/v1/moments/${m.id}`)).body.counts.reactions).toBe(0);
    expect(
      (await f.client.del('/v1/moments/00000000-0000-4000-8000-000000000000/reaction')).status,
    ).toBe(404);
  });
});

describe('deleting', () => {
  it('lets only the author delete, removing the media and side data', async () => {
    const a = await signup(t);
    const f = await signup(t);
    const other = await signup(t);
    await follow(f, a);
    const img = await mediaFor(a, await png('indigo'));
    const m = await moment(a, { kind: 'photo', mediaId: img.id, visibility: 'followers' });
    await f.client.post(`/v1/moments/${m.id}/view`);
    await f.client.put(`/v1/moments/${m.id}/reaction`, {});
    const key = pathOf(m.media.url).replace('/media/', '');
    const adapter = getMediaRuntime(t.ctx).adapter;

    expect((await f.client.del(`/v1/moments/${m.id}`)).status).toBe(404);
    expect((await other.client.del(`/v1/moments/${m.id}`)).status).toBe(404);
    expect((await new Client(t).del(`/v1/moments/${m.id}`)).status).toBe(401);
    expect(await adapter.stat(key)).not.toBeNull();
    expect((await a.client.del(`/v1/moments/${m.id}`)).status).toBe(204);
    expect(await canSee(f.client, m.id)).toBe(false);
    expect(await canSee(a.client, m.id)).toBe(false);
    expect(await adapter.stat(key)).toBeNull();
    expect(
      (await sql('SELECT deleted_at FROM media WHERE id = $1', [img.id])).rows[0].deleted_at,
    ).toBeInstanceOf(Date);
    expect(
      (await sql('SELECT count(*)::int AS n FROM moment_views WHERE moment_id = $1', [m.id]))
        .rows[0].n,
    ).toBe(0);
    expect((await a.client.del(`/v1/moments/${m.id}`)).status).toBe(404);
    expect(
      (
        await sql(`SELECT 1 FROM audit_logs WHERE action = 'moment.deleted' AND target_id = $1`, [
          m.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('account deletion hooks remove moments, views and audience entries', async () => {
    const a = await signup(t);
    const v = await signup(t);
    await follow(v, a);
    const m = await moment(a, {
      visibility: 'followers',
      body: 'to be erased',
      latitude: 3,
      longitude: 4,
    });
    const mine = await moment(v, { visibility: 'selected', audience: [a.id] });
    await v.client.post(`/v1/moments/${m.id}/view`);
    await withTransaction(t.ctx.db, async (tx) => {
      for (const hook of getDeletionHooks()) await hook(t.ctx, tx, a.id);
    });
    expect(
      (await sql('SELECT body, latitude, deleted_at FROM moments WHERE id = $1', [m.id])).rows[0],
    ).toMatchObject({ body: '', latitude: null, deleted_at: expect.any(Date) });
    expect(await canSee(v.client, m.id)).toBe(false);
    expect(
      (await sql('SELECT count(*)::int AS n FROM moment_audience WHERE user_id = $1', [a.id]))
        .rows[0].n,
    ).toBe(0);
    expect(mine.id).toBeTruthy();
  });
});

describe('profile listing', () => {
  it('paginates with keyset cursors, newest first', async () => {
    const a = await signup(t);
    const f = await signup(t);
    await follow(f, a);
    const bodies = ['one', 'two', 'three', 'four', 'five'];
    for (const b of bodies) {
      await moment(a, { body: b, visibility: 'followers' });
      await new Promise((r) => setTimeout(r, 4));
    }
    const p1 = (await f.client.get(`/v1/users/${a.username}/moments`, { limit: '2' })).body;
    expect(p1.items.map((m: any) => m.body)).toEqual(['five', 'four']);
    const p2 = (
      await f.client.get(`/v1/users/${a.username}/moments`, { limit: '2', cursor: p1.nextCursor })
    ).body;
    expect(p2.items.map((m: any) => m.body)).toEqual(['three', 'two']);
    const p3 = (
      await f.client.get(`/v1/users/${a.username}/moments`, { limit: '2', cursor: p2.nextCursor })
    ).body;
    expect(p3.items.map((m: any) => m.body)).toEqual(['one']);
    expect(p3.nextCursor).toBeNull();
    expect((await f.client.get(`/v1/users/nobody-here-xyz/moments`)).status).toBe(404);
  });
});
