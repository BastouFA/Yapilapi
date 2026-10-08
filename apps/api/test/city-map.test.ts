import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAP_LAYER_LIMIT, MAP_MAX_SPAN, approximatePoint, marketPoint, type MapItem } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { areaOf, sweepPresence } from '../src/lib/city-map.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * Near you (lib/city-map.ts, modules/city-map.ts): docs/product/city-map.md. Each test works in its
 * own part of the world (spot(n)), since the map keeps each area's candidates for a little while.
 */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  await flag('LIVE', true);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key IN ('LIVE', 'CITY_MAP')`);
  await t.close();
});

const db = () => t.ctx.db;
const flag = (key: string, on: boolean) =>
  t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`, [key, on]);
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A part of the world of its own for each test, well away from the others. */
const spot = (n: number) => ({ lat: -40 + n * 3.1, lng: -150 + n * 7.3 });
const near = (p: { lat: number; lng: number }, dLat = 0, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const boxQs = (p: { lat: number; lng: number }, half = 0.05, extra = '') =>
  `south=${p.lat - half}&west=${p.lng - half}&north=${p.lat + half}&east=${p.lng + half}${extra}`;
const map = (u: TestUser | null, p: { lat: number; lng: number }, extra = '', half = 0.05) => as(t.app, u).get(`/v1/map?${boxQs(p, half, extra)}`);
const keys = (r: { body: any }, layer?: string) => (r.body.items as MapItem[]).filter((i) => !layer || i.layer === layer).map((i) => i.key);
const item = (r: { body: any }, key: string) => (r.body.items as MapItem[]).find((i) => i.key === key);

let placeN = 0;
async function place(by: TestUser, at: { lat: number; lng: number }, name = `Place ${++placeN}`) {
  const r = await as(t.app, by).post('/v1/places', { name, category: 'venue', city: 'Testville', ...at });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.place.id as string;
}
const live = async (host: TestUser, placeId: string | null, visibility = 'public') =>
  (
    await db().query(
      `INSERT INTO live_sessions (host_id, title, status, visibility, started_at, place_id) VALUES ($1, 'On the beach', 'live', $2, now(), $3) RETURNING id`,
      [host.id, visibility, placeId],
    )
  ).rows[0].id as string;
const event = async (host: TestUser, placeId: string, extra: { visibility?: string; startsIn?: string; endsIn?: string | null } = {}) =>
  (
    await db().query(
      `INSERT INTO events (host_id, title, starts_at, ends_at, place_id, visibility)
       VALUES ($1, 'Jazz night', now() + $2::interval, CASE WHEN $3::text IS NULL THEN NULL ELSE now() + $3::interval END, $4, $5) RETURNING id`,
      [host.id, extra.startsIn ?? '1 minute', extra.endsIn === undefined ? '2 hours' : extra.endsIn, placeId, extra.visibility ?? 'public'],
    )
  ).rows[0].id as string;
let listingN = 0;
async function listing(seller: TestUser, at: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  listingN++;
  const p = approximatePoint(at);
  const { rows } = await db().query(
    `INSERT INTO market_listings (seller_id, title, category, condition, price_cents, currency, area, approx_lat, approx_lng, country, delivery, expires_at, fingerprint, moderation_status)
     VALUES ($1, $2, 'furniture', 'good', 100000, 'NGN', 'Yaba, Lagos', $3, $4, 'NG', ARRAY['pickup'], now() + interval '30 days', $5, $6) RETURNING id`,
    [seller.id, `Desk ${listingN}`, p.lat, p.lng, `fp-${listingN}-${Date.now()}`, extra.moderation ?? 'normal'],
  );
  return rows[0].id as string;
}
const video = async (u: TestUser) =>
  (
    await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms, poster_url) VALUES ($1,'video','http://localhost:4000/media/r.mp4','video/mp4','ready',10000,'http://localhost:4000/media/r.jpg') RETURNING id, url`,
      [u.id],
    )
  ).rows[0] as { id: string; url: string };
async function post(u: TestUser, placeId: string, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, u).post('/v1/posts', { body: 'Here now', visibility: 'public', placeId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.post as { id: string; place: unknown; chain?: { id: string } };
}
async function reel(u: TestUser, placeId: string, extra: Record<string, unknown> = {}) {
  const m = await video(u);
  return post(u, placeId, { format: 'reel', media: [{ id: m.id, url: m.url, kind: 'video' }], ...extra });
}

describe('Near you: the layers', () => {
  it('shows lives at a place, events today, Market listings, busy places and chains, each with its card', async () => {
    const at = spot(1);
    const [host, seller, a, b, c] = [await adult(), await adult(), await adult(), await adult(), await adult()];
    const viewer = await adult();
    const beach = await place(host, near(at, 0.001), 'Bar Beach');
    const square = await place(host, near(at, -0.01, 0.01), 'Tafawa Square');
    const quiet = await place(host, near(at, 0.02), 'Quiet corner');
    const liveId = await live(host, beach);
    await live(host, null); // No place: never on the map.
    const tonight = await event(host, beach);
    const tomorrow = await event(host, beach, { startsIn: '30 hours', endsIn: null });
    const over = await event(host, beach, { startsIn: '-5 hours', endsIn: '-1 hour' });
    const sale = await listing(seller, near(at, 0.003, 0.004));
    // Three different people posted at the square: it's buzzing. Only one at the quiet corner.
    await post(a, square);
    await post(b, square);
    await post(c, square, { kind: 'photo', media: [{ url: 'http://localhost:4000/media/p.jpg', kind: 'image' }] });
    await post(a, quiet);
    await post(a, quiet);
    await post(a, quiet);
    // A chain whose reels were made at the beach.
    const first = await reel(a, beach, { chainPrompt: 'Show your city’s best sunset' });
    await reel(b, beach, { chainId: first.chain!.id });

    const r = await map(viewer, at);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(keys(r, 'live')).toEqual([`live:${liveId}`]);
    expect(item(r, `live:${liveId}`)).toMatchObject({ title: 'On the beach', subtitle: 'Bar Beach', approximate: false, target: { kind: 'live', id: liveId } });
    expect(item(r, `live:${liveId}`)!.user!.id).toBe(host.id);
    expect(keys(r, 'today')).toEqual([`today:${tonight}`]);
    expect(keys(r, 'today')).not.toContain(`today:${tomorrow}`);
    expect(keys(r, 'today')).not.toContain(`today:${over}`);
    expect(keys(r, 'market')).toEqual([`market:${sale}`]);
    expect(keys(r, 'places')).toEqual([`places:${square}`]);
    expect(item(r, `places:${square}`)).toMatchObject({ title: 'Tafawa Square', subtitle: 'Testville', count: 3, target: { kind: 'place', id: square } });
    expect(item(r, `places:${square}`)!.thumbUrl).toContain('/media/p.jpg');
    expect(keys(r, 'chains')).toEqual([`chains:${first.chain!.id}`]);
    expect(item(r, `chains:${first.chain!.id}`)).toMatchObject({ title: 'Show your city’s best sunset', subtitle: 'Bar Beach', count: 2 });
    expect(r.body.more).toEqual([]);

    // Only the layers asked for; a place outside the box isn't there.
    const some = await map(viewer, at, '&layers=today,market');
    expect(new Set((some.body.items as MapItem[]).map((i) => i.layer))).toEqual(new Set(['today', 'market']));
    expect(keys(await map(viewer, near(at, 0.5)))).toEqual([]);

    // Lives need LIVE; chains need PASS_THE_MIC.
    await flag('LIVE', false);
    await flag('PASS_THE_MIC', false);
    const off = await map(viewer, at);
    expect(keys(off, 'live')).toEqual([]);
    expect(keys(off, 'chains')).toEqual([]);
    await flag('LIVE', true);
    await db().query(`DELETE FROM feature_flags WHERE key = 'PASS_THE_MIC'`);
  });

  it('tags posts and lives with a place, which shows on them', async () => {
    const at = spot(2);
    const u = await adult();
    const placeId = await place(u, at, 'Freedom Park');
    const p = await post(u, placeId);
    expect(p.place).toEqual({ id: placeId, name: 'Freedom Park', city: 'Testville' });
    expect((await as(t.app, u).get(`/v1/posts/${p.id}`)).body.post.place).toEqual({ id: placeId, name: 'Freedom Park', city: 'Testville' });
    // A place that isn't there is refused.
    const missing = await as(t.app, u).post('/v1/posts', { body: 'x', placeId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
    // A post without one has none.
    expect((await as(t.app, u).post('/v1/posts', { body: 'Nowhere in particular' })).body.post.place).toBeNull();
  });

  it('keeps Market listings on a 2 km grid, never their kept point', async () => {
    const at = spot(3);
    const [seller, viewer] = [await adult(), await adult()];
    const id = await listing(seller, near(at, 0.0031, 0.0042));
    const kept = (await db().query(`SELECT approx_lat, approx_lng FROM market_listings WHERE id = $1`, [id])).rows[0];
    const r = await map(viewer, at);
    const pin = item(r, `market:${id}`)!;
    expect(pin.point).toEqual(marketPoint({ lat: kept.approx_lat, lng: kept.approx_lng }));
    expect(pin).toMatchObject({ approximate: true, subtitle: 'Yaba, Lagos' });
    expect(JSON.stringify(r.body)).not.toContain(String(kept.approx_lat));
    // Held for review: not there.
    const held = await listing(seller, near(at, 0.01), { moderation: 'review' });
    expect(keys(await map(viewer, near(at, 0.0001)), 'market')).not.toContain(`market:${held}`);
  });
});

describe('Near you: who sees what', () => {
  it('follows audiences: followers-only and friends-only events and lives, never link-only events', async () => {
    const at = spot(4);
    const [host, follower, friend, stranger] = [await adult(), await adult(), await adult(), await adult()];
    await as(t.app, follower).post(`/v1/users/${host.id}/follow`);
    await befriend(host, friend);
    const placeId = await place(host, at);
    const forFollowers = await event(host, placeId, { visibility: 'followers' });
    const forFriends = await event(host, placeId, { visibility: 'friends' });
    const byLink = await event(host, placeId, { visibility: 'private' });
    const friendsLive = await live(host, placeId, 'friends');

    const seen = async (u: TestUser) => keys(await map(u, at));
    expect(await seen(stranger)).toEqual([]);
    expect(await seen(follower)).toEqual([`today:${forFollowers}`]);
    expect((await seen(friend)).sort()).toEqual([`live:${friendsLive}`, `today:${forFriends}`].sort());
    expect(await seen(host)).not.toContain(`today:${byLink}`);
    expect(keys(await map(null, at))).toEqual([]);
  });

  it('hides everything from someone blocked, both ways', async () => {
    const at = spot(5);
    const [ada, bola, cleo, dayo] = [await adult(), await adult(), await adult(), await adult()];
    const placeId = await place(ada, at);
    const liveId = await live(ada, placeId);
    const ev = await event(ada, placeId);
    const sale = await listing(ada, near(at, 0.004));
    await post(ada, placeId);
    await post(cleo, placeId);
    await post(dayo, placeId);
    const first = await reel(ada, placeId, { chainPrompt: 'Your morning walk' });
    const eve = await adult();
    const eveLive = await live(eve, placeId);

    const before = keys(await map(bola, at));
    expect(before).toEqual(expect.arrayContaining([`live:${liveId}`, `today:${ev}`, `market:${sale}`, `places:${placeId}`, `chains:${first.chain!.id}`]));
    // Ada blocks Bola: Bola sees none of Ada's things (the busy place stays: others posted there).
    await as(t.app, ada).post(`/v1/users/${bola.id}/block`);
    const after = keys(await map(bola, at));
    expect(after).not.toContain(`live:${liveId}`);
    expect(after).not.toContain(`today:${ev}`);
    expect(after).not.toContain(`market:${sale}`);
    expect(after).not.toContain(`chains:${first.chain!.id}`);
    // And the other way: Cleo blocking someone hides theirs too (what's listed is read again each time, never kept).
    expect(keys(await map(cleo, at))).toContain(`live:${eveLive}`);
    await as(t.app, cleo).post(`/v1/users/${eve.id}/block`);
    expect(keys(await map(cleo, at))).not.toContain(`live:${eveLive}`);
  });

  it('keeps a teen’s live from adults who aren’t their friends or guardian', async () => {
    const at = spot(6);
    const [kid, stranger, friend, parent] = [await teen(), await adult(), await adult(), await adult()];
    await befriend(kid, friend);
    await db().query(`INSERT INTO family_links (guardian_id, teen_id, status, accepted_at) VALUES ($1,$2,'active',now())`, [parent.id, kid.id]);
    const placeId = await place(stranger, at);
    const liveId = await live(kid, placeId, 'public');
    expect(keys(await map(stranger, at))).toEqual([]);
    expect(keys(await map(null, at))).toEqual([]);
    expect(keys(await map(friend, at))).toEqual([`live:${liveId}`]);
    expect(keys(await map(parent, at))).toEqual([`live:${liveId}`]);
  });

  it('leaves out posts withheld in the viewer’s country when picking a busy place’s picture', async () => {
    const at = spot(7);
    const [a, b, c, viewer] = [await adult(), await adult(), await adult(), await adult()];
    await db().query(`UPDATE profiles SET country = 'DE' WHERE user_id = $1`, [viewer.id]);
    const placeId = await place(a, at);
    await post(a, placeId);
    await post(b, placeId);
    await post(c, placeId, { body: 'Mapwithheldword here', kind: 'photo', media: [{ url: 'http://localhost:4000/media/withheld.jpg', kind: 'image' }] });
    await db().query(`INSERT INTO regional_rules (country, kind, term, legal_basis) VALUES ('DE', 'blocked_term', 'mapwithheldword', '[Dev data] Test rule')`);
    const pin = item(await map(viewer, at), `places:${placeId}`);
    expect(pin).toBeDefined();
    expect(pin!.thumbUrl).toBeNull();
  });
});

describe('Near you: friends out', () => {
  const HERE = { lat: 0, lng: 0 };
  it('is off by default, shows only to friends, rounded to about a kilometre, and stops when asked', async () => {
    const at = spot(8);
    Object.assign(HERE, near(at, 0.00321, 0.00456));
    const [ada, friend, stranger, blocked] = [await adult(), await adult(), await adult(), await adult()];
    await befriend(ada, friend);
    await befriend(ada, blocked);
    expect((await as(t.app, ada).get('/v1/map/presence')).body.presence).toBeNull();
    expect(keys(await map(friend, at), 'friends')).toEqual([]);

    const on = await as(t.app, ada).put('/v1/map/presence', { ...HERE, duration: '1h' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.presence.point).toEqual(approximatePoint(HERE));
    const kept = (await db().query(`SELECT lat, lng FROM map_presence WHERE user_id = $1`, [ada.id])).rows[0];
    expect(kept).toEqual(approximatePoint(HERE));
    expect(new Date(on.body.presence.endsAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(new Date(on.body.presence.endsAt).getTime() - Date.now()).toBeLessThan(61 * 60_000);

    const seen = await map(friend, at);
    expect(keys(seen, 'friends')).toEqual([`friends:${ada.id}`]);
    expect(item(seen, `friends:${ada.id}`)).toMatchObject({
      approximate: true,
      point: approximatePoint(HERE),
      target: { kind: 'user', username: ada.username },
    });
    expect(JSON.stringify(seen.body)).not.toContain(String(HERE.lat));
    expect(keys(await map(stranger, at), 'friends')).toEqual([]);
    expect(keys(await map(null, at), 'friends')).toEqual([]);
    await as(t.app, blocked).post(`/v1/users/${ada.id}/block`);
    expect(keys(await map(blocked, at), 'friends')).toEqual([]);
    // Not a friend any more: gone.
    const [x, y] = [ada.id, friend.id].sort();
    await db().query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
    expect(keys(await map(friend, at), 'friends')).toEqual([]);
    await befriend(ada, friend);

    // Stop: the point is deleted.
    expect((await as(t.app, ada).del('/v1/map/presence')).body.presence).toBeNull();
    expect((await db().query(`SELECT 1 FROM map_presence WHERE user_id = $1`, [ada.id])).rowCount).toBe(0);
    expect(keys(await map(friend, at), 'friends')).toEqual([]);
  });

  it('runs for the time chosen, moves without a new time, and ends by itself', async () => {
    const at = spot(9);
    const [ada, friend] = [await adult(), await adult()];
    await befriend(ada, friend);
    const four = (await as(t.app, ada).put('/v1/map/presence', { ...at, duration: '4h' })).body.presence;
    expect(new Date(four.endsAt).getTime() - Date.now()).toBeGreaterThan(239 * 60_000);
    // Moving keeps the end.
    const moved = (await as(t.app, ada).put('/v1/map/presence', near(at, 0.02))).body.presence;
    expect(moved.endsAt).toBe(four.endsAt);
    expect(moved.point).toEqual(approximatePoint(near(at, 0.02)));
    // Until midnight in their time zone: the coming one (or the next, when it's under 15 minutes away).
    const midnight = (await as(t.app, ada).put('/v1/map/presence', { ...at, duration: 'midnight', timeZone: 'Africa/Lagos' })).body.presence;
    const ends = new Date(midnight.endsAt);
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ends)).toBe('00:00');
    expect(ends.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(ends.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 15 * 60_000);
    // Never more than a day, whatever's asked.
    expect((await as(t.app, ada).put('/v1/map/presence', { ...at, duration: '12h' })).status).toBe(400);
    expect((await as(t.app, ada).put('/v1/map/presence', { lat: 95, lng: 0 })).status).toBe(400);

    // Past its time: not shown, and the sweep deletes it.
    expect(keys(await map(friend, at), 'friends')).toEqual([`friends:${ada.id}`]);
    await db().query(`UPDATE map_presence SET started_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE user_id = $1`, [ada.id]);
    expect(keys(await map(friend, at), 'friends')).toEqual([]);
    expect((await as(t.app, ada).get('/v1/map/presence')).body.presence).toBeNull();
    expect(await sweepPresence(db())).toBeGreaterThanOrEqual(1);
    expect((await db().query(`SELECT 1 FROM map_presence WHERE user_id = $1`, [ada.id])).rowCount).toBe(0);
    // Signed out: no presence of your own.
    expect((await as(t.app, null).put('/v1/map/presence', { ...at, duration: '1h' })).status).toBe(401);
  });

  it('keeps teens and adults apart unless a family link allows it', async () => {
    const at = spot(10);
    const [kid, kidFriend, adultFriend, parent] = [await teen(), await teen(), await adult(), await adult()];
    await befriend(kid, kidFriend);
    await befriend(kid, adultFriend);
    await befriend(kid, parent);
    await db().query(`INSERT INTO family_links (guardian_id, teen_id, status, accepted_at) VALUES ($1,$2,'active',now())`, [parent.id, kid.id]);
    await as(t.app, kid).put('/v1/map/presence', { ...at, duration: '1h' });
    await as(t.app, adultFriend).put('/v1/map/presence', { ...at, duration: '1h' });
    expect(keys(await map(kidFriend, at), 'friends')).toEqual([`friends:${kid.id}`]);
    expect(keys(await map(adultFriend, at), 'friends')).toEqual([]);
    expect(keys(await map(parent, at), 'friends')).toEqual([`friends:${kid.id}`]);
    // The teen doesn't see the adult friend either.
    expect(keys(await map(kid, at), 'friends')).toEqual([]);
  });

  it('shows friends sharing a live location with a chat you’re in, rounded, and opens the chat', async () => {
    const at = spot(11);
    const [ada, bola, cleo] = [await adult(), await adult(), await adult()];
    await befriend(ada, bola);
    await befriend(ada, cleo);
    const conv = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation.id;
    const exact = near(at, 0.00123, 0.00456);
    const s = await as(t.app, ada).post(`/v1/conversations/${conv}/location`, { ...exact, precision: 'precise', mode: 'live', minutes: 60 });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const seen = await map(bola, at);
    expect(item(seen, `friends:${ada.id}`)).toMatchObject({ point: approximatePoint(exact), approximate: true, target: { kind: 'chat', id: conv } });
    // Cleo is a friend but not in that chat: she doesn't see it.
    expect(keys(await map(cleo, at), 'friends')).toEqual([]);
    // When the share stops, Ada is gone.
    const shareId = (await db().query(`SELECT id FROM location_shares WHERE user_id = $1`, [ada.id])).rows[0].id;
    expect((await as(t.app, ada).post(`/v1/location-shares/${shareId}/stop`)).status).toBe(200);
    expect(keys(await map(bola, at), 'friends')).toEqual([]);
  });
});

describe('Near you: the box', () => {
  it('answers only for a box up to MAP_MAX_SPAN each way, on the map', async () => {
    const at = spot(12);
    const u = await adult();
    const big = await map(u, at, '', MAP_MAX_SPAN);
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.body.error)).toContain('Zoom in to see what’s here.');
    expect((await map(u, at, '', MAP_MAX_SPAN / 2)).status).toBe(200);
    expect((await as(t.app, u).get(`/v1/map?south=10&west=10&north=9&east=11`)).status).toBe(400);
    expect((await as(t.app, u).get(`/v1/map?south=89.9&west=10&north=91&east=11`)).status).toBe(400);
    expect((await as(t.app, u).get(`/v1/map?south=1&west=1&north=1.1&east=1.1&layers=live,nope`)).status).toBe(400);
  });

  it('gives at most MAP_LAYER_LIMIT a layer and says there are more', async () => {
    const at = spot(13);
    const [seller, viewer] = [await adult(), await adult()];
    for (let i = 0; i < MAP_LAYER_LIMIT + 3; i++) await listing(seller, near(at, (i % 7) * 0.001, Math.floor(i / 7) * 0.001));
    const r = await map(viewer, at, '&layers=market');
    expect(keys(r, 'market')).toHaveLength(MAP_LAYER_LIMIT);
    expect(r.body.more).toEqual(['market']);
  });

  it('shares an area’s candidates between nearby boxes', () => {
    const a = areaOf({ south: 6.5, west: 3.35, north: 6.56, east: 3.41 });
    const b = areaOf({ south: 6.51, west: 3.36, north: 6.57, east: 3.42 });
    expect(a.key).toBe(b.key);
    expect(a.box.south).toBeLessThanOrEqual(6.5);
    expect(a.box.north).toBeGreaterThanOrEqual(6.57);
  });

  it('can be turned off', async () => {
    await flag('CITY_MAP', false);
    const r = await map(null, spot(14));
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('Near you is not enabled.');
    await db().query(`DELETE FROM feature_flags WHERE key = 'CITY_MAP'`);
  });

  it('finds where a city is from its place pages, and starts at your own city', async () => {
    const at = spot(15);
    const u = await adult();
    await as(t.app, u).post('/v1/places', { name: 'Kiosk', category: 'store', city: 'Port Harcourt', ...at });
    await as(t.app, u).post('/v1/places', { name: 'Kiosk 2', category: 'store', city: 'Port Harcourt', ...near(at, 0.02) });
    const r = await as(t.app, u).get('/v1/map/center?city=port har');
    expect(r.body.center.city).toBe('Port Harcourt');
    expect(r.body.center.center.lat).toBeCloseTo(at.lat + 0.01, 5);
    expect((await as(t.app, u).get('/v1/map/center?city=Nowhere%25')).body.center).toBeNull();
    expect((await as(t.app, u).get('/v1/map/center')).body.center).toBeNull();
    await db().query(`UPDATE profiles SET city = 'Port Harcourt' WHERE user_id = $1`, [u.id]);
    expect((await as(t.app, u).get('/v1/map/center')).body.center.city).toBe('Port Harcourt');
  });

  it('puts "Show me on the map" in the data export without the place', async () => {
    const at = spot(16);
    const u = await adult();
    await as(t.app, u).put('/v1/map/presence', { ...near(at, 0.00777), duration: '1h' });
    const r = await as(t.app, u).get('/v1/me/export');
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).toContain('mapPresence');
    expect(text).not.toContain(String(approximatePoint(near(at, 0.00777)).lat));
  });
});
