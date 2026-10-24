import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StashCard } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { sweepStashNearby, sweepStashSamples } from '../src/lib/stash.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'STASH'`);
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });
async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

// Somewhere in Lagos (Victoria Island), with digits that would stand out in any answer.
const SPOT = { lat: 6.4281937, lng: 3.4219463 };
const EXACT = [String(SPOT.lat), String(SPOT.lng)];
/** A point `m` metres north of the spot. */
const north = (m: number, from = SPOT) => ({ lat: from.lat + m / 111_320, lng: from.lng });
/** A point about `m` metres north-east of the spot (sharing neither of its numbers). */
const northEast = (m: number) => ({ lat: SPOT.lat + m / 1.414 / 111_320, lng: SPOT.lng + m / 1.414 / 110_620 });
const at = (p: { lat: number; lng: number }, accuracy = 10) => ({ ...p, accuracy });
/** A fresh spot for each test, about a kilometre apart, so they don't see each other's stashes. */
let spots = 0;
const freshSpot = () => ({ lat: SPOT.lat + 0.01 * ++spots, lng: SPOT.lng + 0.013 * spots });

/** Forget a person's recent positions (as if time passed), so a new spot isn't an impossible jump. */
const later = (u: TestUser) => db().query(`UPDATE stash_location_samples SET created_at = now() - interval '2 hours' WHERE user_id = $1`, [u.id]);

async function hide(u: TestUser, body: Record<string, unknown> = {}, where = SPOT) {
  // Each test hides at its own spot: as if the hider walked there.
  await later(u);
  return as(t.app, u).post('/v1/stashes', {
    kind: 'text',
    body: '[Dev data] A note under the bench',
    title: 'Bench note',
    hint: 'Under the big tree',
    audience: 'everyone',
    duration: '7d',
    position: at(where),
    ...body,
  });
}
async function hidden(u: TestUser, body: Record<string, unknown> = {}, where = SPOT): Promise<StashCard> {
  const r = await hide(u, body, where);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.stash;
}
const sees = async (u: TestUser, id: string) => (await as(t.app, u).get(`/v1/stashes/${id}`)).status === 200;
const leaks = (body: unknown) => EXACT.some((d) => JSON.stringify(body).includes(d));

describe('hiding a stash', () => {
  it('needs an accurate position, and keeps the point for its owner only', async () => {
    const a = await adult();
    const blurry = await as(t.app, a).post('/v1/stashes', { kind: 'text', body: 'Hi', audience: 'everyone', duration: '24h', position: at(SPOT, 150) });
    expect(blurry.status).toBe(422);
    expect(blurry.body.error.code).toBe('location_inaccurate');
    expect(blurry.body.error.message).toContain('Move outside or wait for a better GPS signal');

    const s = await hidden(a);
    expect(s.point).toEqual(SPOT);
    expect(s.mine).toBe(true);
    expect(s.content?.body).toContain('under the bench');
    expect(s.area.metres).toBe(100);
    // The area's middle is near the point but not on it.
    expect(s.area.center).not.toEqual(SPOT);
    const off = Math.hypot((s.area.center.lat - SPOT.lat) * 111_320, (s.area.center.lng - SPOT.lng) * 111_320 * Math.cos((SPOT.lat * Math.PI) / 180));
    expect(off).toBeLessThanOrEqual(36);
    expect(s.city).toBe('Lagos');
    expect(s.expiresAt).not.toBeNull();
  });

  it('checks what goes in for each kind', async () => {
    const a = await adult();
    expect((await hide(a, { kind: 'gift', body: undefined })).status).toBe(400);
    const gift = await hidden(a, { kind: 'gift', giftCode: 'LAGOS10', body: undefined }, freshSpot());
    expect(gift.content?.giftCode).toBe('LAGOS10');
    expect((await hide(a, { kind: 'photo', body: undefined })).status).toBe(400);
    expect((await hide(a, { kind: 'song', body: undefined })).status).toBe(400);

    const photo = (
      await db().query(
        `INSERT INTO media (owner_id, kind, url, status, moderation, variants) VALUES ($1, 'image', '/media/dev-stash.jpg', 'ready', 'ok', '{"thumb":"/media/dev-stash-t.jpg"}') RETURNING id`,
        [a.id],
      )
    ).rows[0].id;
    const withPhoto = await hidden(a, { kind: 'photo', mediaId: photo }, freshSpot());
    expect(withPhoto.content?.media?.kind).toBe('image');

    // Someone else's photo can't go in, and a long video is refused.
    const b = await adult();
    expect((await hide(b, { kind: 'photo', mediaId: photo }, freshSpot())).status).toBe(404);
    const long = (
      await db().query(
        `INSERT INTO media (owner_id, kind, url, status, moderation, duration_ms, poster_url, variants) VALUES ($1, 'video', '/media/dev-long.mp4', 'ready', 'ok', 90000, '/media/p.jpg', '{"mp4":"/media/dev-long.mp4"}') RETURNING id`,
        [a.id],
      )
    ).rows[0].id;
    expect((await hide(a, { kind: 'video', mediaId: long }, freshSpot())).status).toBe(400);

    // A voice note: a clip recorded for a Yap, used once.
    const clip = (
      await db().query(`INSERT INTO media (owner_id, kind, url, status) VALUES ($1, 'audio', '/media/dev-voice.m4a', 'ready') RETURNING id`, [a.id])
    ).rows[0].id;
    await db().query(`INSERT INTO voice_clips (media_id, owner_id, purpose, duration_ms) VALUES ($1, $2, 'yap', 4000)`, [clip, a.id]);
    const voice = await hidden(a, { kind: 'voice', voiceId: clip }, freshSpot());
    expect(voice.content?.voice?.id).toBe(clip);
    expect((await hide(a, { kind: 'voice', voiceId: clip }, freshSpot())).status).toBe(409);
    // Words that don't pass hold it: nobody else can find it.
    await db().query(`UPDATE voice_clips SET screened = 'held' WHERE media_id = $1`, [clip]);
    expect(await sees(b, voice.id)).toBe(false);
  });

  it('holds words that need a look, and caps a day at 20', async () => {
    const a = await adult();
    const b = await adult();
    const rude = await hidden(a, { body: 'You are a loser' }, freshSpot());
    expect(rude.moderation).toBe('review');
    expect(await sees(b, rude.id)).toBe(false);
    const cases = await db().query(`SELECT 1 FROM moderation_cases WHERE target_type = 'stash' AND target_id = $1`, [rude.id]);
    expect(cases.rowCount).toBe(1);

    await db().query(
      `INSERT INTO stashes (owner_id, kind, body, lat, lng, area_lat, area_lng, audience) SELECT $1, 'text', 'x', 1, 1, 1, 1, 'everyone' FROM generate_series(1, 19)`,
      [a.id],
    );
    const capped = await hide(a, {}, freshSpot());
    expect(capped.status).toBe(429);
  });
});

describe('where a stash is', () => {
  it('is never sent to anyone else: map, list, page, opening, notifications, export, search', async () => {
    const a = await adult();
    const b = await adult();
    const s = await hidden(a);
    const page = await as(t.app, b).get(`/v1/stashes/${s.id}`);
    expect(page.status).toBe(200);
    expect(page.body.stash.point).toBeUndefined();
    expect(page.body.stash.content).toBeNull();
    expect(leaks(page.body)).toBe(false);

    const box = `south=${SPOT.lat - 0.01}&west=${SPOT.lng - 0.01}&north=${SPOT.lat + 0.01}&east=${SPOT.lng + 0.01}`;
    const map = await as(t.app, b).get(`/v1/map?${box}&layers=stashes`);
    expect(map.status).toBe(200);
    const item = map.body.items.find((i: { key: string }) => i.key === `stashes:${s.id}`);
    expect(item.approximate).toBe(true);
    expect(item.point).toEqual(s.area.center);
    expect(leaks(map.body)).toBe(false);
    // Signed out: no stashes at all.
    const out = await as(t.app, null).get(`/v1/map?${box}&layers=stashes`);
    expect(out.body.items).toEqual([]);

    const near = await as(t.app, b).get(`/v1/stashes/near?lat=${northEast(400).lat}&lng=${northEast(400).lng}`);
    expect(near.body.items.map((x: { stash: { id: string } }) => x.stash.id)).toContain(s.id);
    expect(leaks(near.body)).toBe(false);

    const far = await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(northEast(400)));
    expect(far.status).toBe(200);
    expect(far.body.opened).toBe(false);
    expect(far.body.toGoMetres).toBeGreaterThan(300);
    expect(leaks(far.body)).toBe(false);

    const opened = await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(northEast(20)));
    expect(opened.body.opened).toBe(true);
    expect(opened.body.stash.content.body).toContain('under the bench');
    expect(leaks(opened.body)).toBe(false);

    const mine = await as(t.app, b).get('/v1/stashes/mine');
    expect(mine.body.found.map((x: StashCard) => x.id)).toEqual([s.id]);
    expect(leaks(mine.body)).toBe(false);

    const notes = await as(t.app, a).get('/v1/notifications');
    expect(notes.body.items.some((n: { type: string }) => n.type === 'stash_found')).toBe(true);
    expect(leaks(notes.body)).toBe(false);

    const exported = await as(t.app, b).get('/v1/me/export');
    expect(exported.status).toBe(200);
    expect(exported.body.stash.found).toHaveLength(1);
    expect(leaks(exported.body)).toBe(false);
    // The owner's own export has the point: it's theirs.
    const own = await as(t.app, a).get('/v1/me/export');
    expect(own.body.stash.hidden[0].lat).toBe(SPOT.lat);

    const search = await as(t.app, b).get(`/v1/search?q=${encodeURIComponent('Bench note')}`);
    expect(leaks(search.body)).toBe(false);
  });
});

describe('who can find a stash', () => {
  it('follows its audience: one person, friends, a squad, everyone', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    await befriend(a, b);
    const where = freshSpot();
    const forB = await hidden(a, { audience: 'person', recipientId: b.id }, where);
    expect(forB.recipient?.id).toBe(b.id);
    expect(await sees(b, forB.id)).toBe(true);
    expect(await sees(c, forB.id)).toBe(false);
    // One person: a friend or someone who follows you back.
    expect((await hide(a, { audience: 'person', recipientId: c.id }, where)).status).toBe(403);

    const friends = await hidden(a, { audience: 'friends' }, where);
    expect(await sees(b, friends.id)).toBe(true);
    expect(await sees(c, friends.id)).toBe(false);

    const squad = (await db().query(`INSERT INTO squads (owner_id, name) VALUES ($1, '[Dev data] Stash crew') RETURNING id`, [a.id])).rows[0].id;
    await db().query(`INSERT INTO squad_members (squad_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`, [
      squad,
      a.id,
      c.id,
    ]);
    const crew = await hidden(a, { audience: 'squad', squadId: squad }, where);
    expect(await sees(c, crew.id)).toBe(true);
    expect(await sees(b, crew.id)).toBe(false);
    // Not in it: can't hide one for it.
    expect((await hide(b, { audience: 'squad', squadId: squad }, where)).status).toBe(404);

    // Private stashes don't even show their area to people outside them.
    const box = `south=${where.lat - 0.01}&west=${where.lng - 0.01}&north=${where.lat + 0.01}&east=${where.lng + 0.01}`;
    const keys = (await as(t.app, b).get(`/v1/map?${box}&layers=stashes`)).body.items.map((i: { key: string }) => i.key);
    expect(keys).toContain(`stashes:${friends.id}`);
    expect(keys).not.toContain(`stashes:${crew.id}`);
  });

  it('keeps under-18s and adults apart unless friends or family, and lets the team’s stashes reach everyone', async () => {
    const [grown, kid, kid2, friendOfKid] = [await adult(), await teen(), await teen(), await adult()];
    await befriend(kid, friendOfKid);
    const where = freshSpot();
    const adults = await hidden(grown, {}, where);
    expect(await sees(kid, adults.id)).toBe(false);
    const teens = await hidden(kid2, {}, where);
    expect(await sees(kid, teens.id)).toBe(true);
    expect(await sees(grown, teens.id)).toBe(false);
    const friendly = await hidden(friendOfKid, {}, where);
    expect(await sees(kid, friendly.id)).toBe(true);
    // An adult can't hide one for an under-18 they aren't friends with (even a mutual follow).
    await db().query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2), ($2,$1) ON CONFLICT DO NOTHING`, [grown.id, kid.id]);
    const blocked = await hide(grown, { audience: 'person', recipientId: kid.id }, where);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('minor_protection');
    // A guardian through a family link can.
    await db().query(`INSERT INTO family_links (guardian_id, teen_id, status, accepted_at) VALUES ($1, $2, 'active', now())`, [grown.id, kid.id]);
    expect((await hide(grown, { audience: 'person', recipientId: kid.id }, where)).status).toBe(201);

    // The team's launch stashes are for everyone.
    const admin = await adult();
    await db().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const seed = await as(t.app, admin).post('/v1/admin/stashes', { kind: 'text', body: '[Dev data] Welcome to Lagos', duration: 'none', point: where });
    expect(seed.status, JSON.stringify(seed.body)).toBe(201);
    expect(await sees(kid, seed.body.stash.id)).toBe(true);
  });

  it('hides everything both ways when someone blocks', async () => {
    const [a, b] = [await adult(), await adult()];
    const s = await hidden(a, {}, freshSpot());
    expect(await sees(b, s.id)).toBe(true);
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [b.id, a.id]);
    expect(await sees(b, s.id)).toBe(false);
    const theirs = await hidden(b, {}, freshSpot());
    expect(await sees(a, theirs.id)).toBe(false);
  });
});

describe('opening a stash', () => {
  it('opens within 50 m, with some of the accuracy counting, and says how far there is to go', async () => {
    const [a, b] = [await adult(), await adult()];
    const where = freshSpot();
    const s = await hidden(a, {}, where);
    const near = await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(north(90, where), 5));
    expect(near.body).toMatchObject({ opened: false, toGoMetres: 40 });
    const blurry = await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(north(60, where), 150));
    expect(blurry.status).toBe(422);
    // 75 m away, accurate to 30 m: 75 - 30 = 45, inside 50.
    const ok = await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(north(75, where), 30));
    expect(ok.body.opened).toBe(true);
    // Opening again just shows it.
    expect((await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(north(500, where)))).body.opened).toBe(true);
  });

  it('refuses an impossible jump, and forgets positions after an hour', async () => {
    const [a, b] = [await adult(), await adult()];
    const s = await hidden(a, {}, freshSpot());
    expect((await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at({ lat: 48.8566, lng: 2.3522 }))).status).toBe(200);
    const jump = await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(SPOT));
    expect(jump.status).toBe(422);
    expect(jump.body.error.code).toBe('impossible_travel');
    await later(b);
    expect(await sweepStashSamples(db())).toBeGreaterThan(0);
    const left = await db().query(`SELECT 1 FROM stash_location_samples WHERE user_id = $1`, [b.id]);
    expect(left.rowCount).toBe(0);
  });

  it('limits attempts', async () => {
    // Limits are off in tests (one address makes every user); this app keeps them on.
    const strict = await testApp({ APP_ENV: 'development' });
    const [a, b] = [await signUp(strict.app), await signUp(strict.app)];
    const where = freshSpot();
    const s = await hidden(a, {}, where);
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await as(strict.app, b).post(`/v1/stashes/${s.id}/open`, at(north(300, where)))).status);
    await strict.close();
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true);
    expect(codes).toContain(429);
  });

  it('gives a first-finder stash to one person only, even at the same moment', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const where = freshSpot();
    const s = await hidden(a, { firstOnly: true }, where);
    const [x, y] = await Promise.all([
      as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(north(10, where))),
      as(t.app, c).post(`/v1/stashes/${s.id}/open`, at(north(10, where))),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 409]);
    const finds = await db().query(`SELECT count(*)::int AS n FROM stash_finds WHERE stash_id = $1`, [s.id]);
    expect(finds.rows[0].n).toBe(1);
    // Taken: it leaves the map for everyone else.
    const loser = x.status === 409 ? b : c;
    expect((await as(t.app, loser).get(`/v1/stashes/${s.id}`)).body.stash.taken).toBe(true);
  });

  it('ends when its time is up or it’s taken back', async () => {
    const [a, b] = [await adult(), await adult()];
    const where = freshSpot();
    const s = await hidden(a, { duration: '24h' }, where);
    await db().query(`UPDATE stashes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
    expect(await sees(b, s.id)).toBe(false);
    expect((await as(t.app, a).get(`/v1/stashes/${s.id}`)).body.stash.ended).toBe(true);
    const other = await hidden(a, {}, where);
    expect((await as(t.app, a).del(`/v1/stashes/${other.id}`)).status).toBe(200);
    expect(await sees(b, other.id)).toBe(false);
  });

  it('tells the owner who found it, grouped, and lets the finder say thanks', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const where = freshSpot();
    const s = await hidden(a, {}, where);
    await as(t.app, b).post(`/v1/stashes/${s.id}/open`, at(north(5, where)));
    await as(t.app, c).post(`/v1/stashes/${s.id}/open`, at(north(5, where)));
    const { rows } = await db().query(`SELECT data FROM notifications WHERE user_id = $1 AND type = 'stash_found'`, [a.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.count).toBe(2);
    expect((await as(t.app, b).post(`/v1/stashes/${s.id}/thanks`, { reaction: 'love', text: 'Made my day' })).status).toBe(200);
    // Only finders can thank.
    expect((await as(t.app, await adult()).post(`/v1/stashes/${s.id}/thanks`, { reaction: 'wow' })).status).toBe(404);
    const page = await as(t.app, a).get(`/v1/stashes/${s.id}`);
    expect(page.body.finds.find((f: { finder: { id: string } }) => f.finder.id === b.id)).toMatchObject({ reaction: 'love', thanks: 'Made my day' });
    const thanks = await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'stash_thanks'`, [a.id]);
    expect(thanks.rowCount).toBe(1);
  });
});

describe('reports and the team', () => {
  it('hides a stash reported as being at someone’s home at once, and moderators can remove it', async () => {
    const [a, b] = [await adult(), await adult()];
    const s = await hidden(a, {}, freshSpot());
    const r = await as(t.app, b).post('/v1/reports', { targetType: 'stash', targetId: s.id, reason: 'private_place' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await sees(b, s.id)).toBe(false);
    expect((await as(t.app, a).get(`/v1/stashes/${s.id}`)).body.stash.moderation).toBe('restricted');

    const mod = await adult();
    await db().query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
    const cases = await as(t.app, mod).get('/v1/admin/moderation/cases');
    const c = cases.body.items.find((x: { target_id?: string; targetId?: string }) => (x.target_id ?? x.targetId) === s.id);
    expect(c).toBeTruthy();
    // Moderators see the exact point to judge it.
    expect(c.excerpt).toContain(String(s.point!.lat));
    expect((await as(t.app, mod).del(`/v1/admin/stashes/${s.id}`)).status).toBe(200);
    expect((await db().query(`SELECT moderation_status FROM stashes WHERE id = $1`, [s.id])).rows[0].moderation_status).toBe('removed');
  });

  it('seed mode is for admins, at any point, shown as the team’s', async () => {
    const [someone, admin, b] = [await adult(), await adult(), await adult()];
    const point = { lat: 6.1375, lng: 1.2123 };
    expect((await as(t.app, someone).post('/v1/admin/stashes', { kind: 'text', body: 'x', duration: 'none', point })).status).toBe(403);
    await db().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const seed = await as(t.app, admin).post('/v1/admin/stashes', { kind: 'gift', giftCode: 'LOME', duration: '7d', point });
    expect(seed.status).toBe(201);
    expect(seed.body.stash.city).toBe('Lomé');
    const page = await as(t.app, b).get(`/v1/stashes/${seed.body.stash.id}`);
    expect(page.body.stash).toMatchObject({ seeded: true, owner: null });
    const list = await as(t.app, admin).get('/v1/admin/stashes');
    expect(list.body.items[0].point).toEqual(point);
  });
});

describe('explorers', () => {
  it('counts finds and badges, lists this month’s top explorers, and respects opting out and minors', async () => {
    const [a, finder, shy, kid] = [await adult(), await adult(), await adult(), await teen()];
    const where = { lat: 48.8566 + 0.001 * ++spots, lng: 2.3522 };
    for (const u of [finder, shy]) {
      const s = await hidden(a, {}, where);
      await later(u);
      expect((await as(t.app, u).post(`/v1/stashes/${s.id}/open`, at(where))).body.opened).toBe(true);
    }
    const teenStash = await hidden(await teen(), {}, where);
    await as(t.app, kid).post(`/v1/stashes/${teenStash.id}/open`, at(where));

    const ex = await as(t.app, a).get(`/v1/users/${finder.username}/explorer`);
    expect(ex.body.explorer).toMatchObject({ found: 1, hidden: 0, badges: ['first_find'] });
    expect((await as(t.app, a).get(`/v1/users/${a.username}/explorer`)).body.explorer.hidden).toBeGreaterThanOrEqual(2);

    await as(t.app, shy).put('/v1/me/stash-settings', { explorerLists: false, showCounts: false });
    expect((await as(t.app, a).get(`/v1/users/${shy.username}/explorer`)).body.explorer).toBeNull();
    expect((await as(t.app, shy).get(`/v1/users/${shy.username}/explorer`)).body.explorer.found).toBe(1);

    const top = await as(t.app, a).get('/v1/stashes/explorers?city=paris');
    const ids = top.body.items.map((x: { user: { id: string } }) => x.user.id);
    expect(ids).toContain(finder.id);
    expect(ids).not.toContain(shy.id);
    expect(ids).not.toContain(kid.id);
    // Under 18: never in the lists, whatever the setting says.
    const kidSettings = await as(t.app, kid).put('/v1/me/stash-settings', { explorerLists: true });
    expect(kidSettings.body.settings).toMatchObject({ explorerLists: false, explorerListsLocked: true });
  });
});

describe('new stashes near you', () => {
  it('is off by default, then at most once a day', async () => {
    const [a, b] = [await adult(), await adult()];
    await db().query(`UPDATE profiles SET city = 'Lagos' WHERE user_id = $1`, [b.id]);
    await hidden(a, {}, freshSpot());
    await sweepStashNearby({ db: db(), realtime: t.ctx.realtime }, 10_000);
    const none = await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'stash_nearby'`, [b.id]);
    expect(none.rowCount).toBe(0);
    await as(t.app, b).put('/v1/me/stash-settings', { nearbyNotify: true });
    await sweepStashNearby({ db: db(), realtime: t.ctx.realtime }, 10_000);
    await sweepStashNearby({ db: db(), realtime: t.ctx.realtime }, 10_000);
    const told = await db().query(`SELECT data FROM notifications WHERE user_id = $1 AND type = 'stash_nearby'`, [b.id]);
    expect(told.rowCount).toBe(1);
    expect(told.rows[0].data.count).toBeGreaterThanOrEqual(1);
  });
});

describe('the STASH flag and deleting an account', () => {
  it('turns it all off, and deleting an account removes its stashes and positions', async () => {
    const a = await adult();
    const s = await hidden(a, {}, freshSpot());
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('STASH', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    expect((await as(t.app, a).get(`/v1/stashes/${s.id}`)).status).toBe(404);
    await db().query(`DELETE FROM feature_flags WHERE key = 'STASH'`);
    expect((await as(t.app, a).del('/v1/me', { password: a.password })).status).toBe(200);
    expect((await db().query(`SELECT 1 FROM stashes WHERE owner_id = $1`, [a.id])).rowCount).toBe(0);
    expect((await db().query(`SELECT 1 FROM stash_location_samples WHERE user_id = $1`, [a.id])).rowCount).toBe(0);
  });
});
