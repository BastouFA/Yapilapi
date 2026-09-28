import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approximatePoint } from '@yapilapi/shared';
import { AiGateway } from '../src/lib/ai/gateway.ts';
import type { AiProvider } from '../src/lib/ai/providers.ts';
import { expireShares, LOCATION_EXPIRE_JOB, locationJobHandlers } from '../src/lib/location.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, jobRunner, type JobRunner, type TestUser } from './helpers.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}
async function unfriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
}

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

async function direct(a: TestUser, b: TestUser): Promise<string> {
  await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function group(owner: TestUser, others: TestUser[]): Promise<string> {
  for (const o of others) await befriend(owner, o);
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Meet up' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

// A spot in Lagos, to 5 decimal places; the digits must never turn up anywhere they shouldn't.
const HERE = { lat: 6.52437, lng: 3.37921 };
const COORD_TEXT = ['6.52437', '3.37921', '6.524', '3.379'];

const share = (u: TestUser, conversationId: string, body: Record<string, unknown>) =>
  as(t.app, u).post(`/v1/conversations/${conversationId}/location`, { ...HERE, precision: 'precise', ...body });

async function startLive(u: TestUser, conversationId: string, extra: Record<string, unknown> = {}) {
  const r = await share(u, conversationId, { mode: 'live', minutes: 60, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.message as { id: string; body: string; location: any };
}

const row = async (shareId: string) => (await db().query(`SELECT * FROM location_shares WHERE id = $1`, [shareId])).rows[0];
/** Let the next point through: the last one was read more than 10 seconds ago. */
const tenSecondsLater = (shareId: string) => db().query(`UPDATE location_shares SET point_at = point_at - interval '11 seconds' WHERE id = $1`, [shareId]);

describe('Sharing where you are', () => {
  it('puts a live card in the chat for its members only, with a quiet notification', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const live = connect(b);
    const outsider = connect(stranger);

    expect((await share(stranger, convo, { mode: 'live', minutes: 60 })).status).toBe(404);
    expect((await share(a, convo, { mode: 'live', minutes: 30 })).status).toBe(400);
    expect((await share(a, convo, { mode: 'live' })).status).toBe(400);
    expect((await share(a, convo, { mode: 'live', minutes: 60, lat: 91 })).status).toBe(400);

    const m = await startLive(a, convo, { clientId: randomUUID() });
    expect(m.body).toBe('Live location');
    expect(m.location).toMatchObject({ mode: 'live', precision: 'precise', live: true, stoppedAt: null, sharer: { id: a.id } });
    expect(m.location.point).toMatchObject({ lat: HERE.lat, lng: HERE.lng });
    expect(new Date(m.location.endsAt).getTime() - new Date(m.location.startedAt).getTime()).toBe(3_600_000);
    expect(live.of('message.created').find((e) => e.data.id === m.id)?.data.location.point.lat).toBe(HERE.lat);
    expect(outsider.events).toEqual([]);

    // "Ada is sharing where they are with you", as a friends notification.
    const n = (
      await db().query(`SELECT category, type, entity_type, entity_id, data FROM notifications WHERE user_id = $1 AND type = 'location_shared'`, [b.id])
    ).rows;
    expect(n).toEqual([{ category: 'friends', type: 'location_shared', entity_type: 'conversation', entity_id: convo, data: {} }]);
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'location_shared'`, [a.id])).rowCount).toBe(0);

    // One live share per person per chat; the other person can share too.
    const again = await share(a, convo, { mode: 'live', minutes: 15 });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'already_sharing', details: { shareId: m.location.id } });
    await startLive(b, convo, { minutes: 15 });
    const running = (await as(t.app, a).get(`/v1/conversations/${convo}/location-shares`)).body.items;
    expect(running.map((s: any) => s.sharer.id).sort()).toEqual([a.id, b.id].sort());
    expect((await as(t.app, stranger).get(`/v1/conversations/${convo}/location-shares`)).status).toBe(404);

    // It reads like a message elsewhere: a reply quotes it as a location, and it can't be edited.
    const reply = await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'On my way too', replyToId: m.id });
    expect(reply.body.message.replyTo).toMatchObject({ id: m.id, kind: 'location' });
    expect((await as(t.app, a).patch(`/v1/messages/${m.id}`, { body: 'Somewhere else' })).body.error.code).toBe('not_editable');
    live.remove();
    outsider.remove();
  });

  it('snaps approximate shares to about a kilometre on the server too', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await startLive(a, convo, { precision: 'approximate', accuracy: 12 });
    const snapped = approximatePoint(HERE);
    expect(m.location.point).toMatchObject({ lat: snapped.lat, lng: snapped.lng, accuracyM: 1000 });
    const kept = await row(m.location.id);
    expect([kept.lat, kept.lng]).toEqual([snapped.lat, snapped.lng]);
    await tenSecondsLater(m.location.id);
    const moved = await as(t.app, a).post(`/v1/location-shares/${m.location.id}/point`, { lat: 6.5301234, lng: 3.3812345 });
    expect(moved.body.location.point).toMatchObject(approximatePoint({ lat: 6.5301234, lng: 3.3812345 }));
  });

  it('takes one point every 10 seconds at most, from the sharer only, and sends it to members only', async () => {
    const [a, b, c, stranger] = [await adult(), await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const m = await startLive(a, convo);
    const id = m.location.id as string;
    const [lb, lc, ls] = [connect(b), connect(c), connect(stranger)];

    const tooSoon = await as(t.app, a).post(`/v1/location-shares/${id}/point`, { lat: 6.53, lng: 3.38 });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('location_too_soon');
    expect(tooSoon.body.error.details.retryAfter).toBeGreaterThan(0);

    await tenSecondsLater(id);
    const ok = await as(t.app, a).post(`/v1/location-shares/${id}/point`, { lat: 6.53, lng: 3.38, accuracy: 8.4 });
    expect(ok.status).toBe(200);
    expect(ok.body.location.point).toMatchObject({ lat: 6.53, lng: 3.38, accuracyM: 8 });
    // And straight away again: too soon.
    expect((await as(t.app, a).post(`/v1/location-shares/${id}/point`, { lat: 6.531, lng: 3.381 })).status).toBe(429);

    for (const d of [lb, lc])
      expect(d.of('location.updated').at(-1)?.data).toMatchObject({ id: m.id, conversationId: convo, location: { point: { lat: 6.53 } } });
    expect(ls.events).toEqual([]);

    // Nobody else moves it or stops it.
    await tenSecondsLater(id);
    expect((await as(t.app, b).post(`/v1/location-shares/${id}/point`, { lat: 1, lng: 1 })).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/location-shares/${id}/stop`)).status).toBe(404);
    expect((await as(t.app, b).post(`/v1/location-shares/${id}/stop`)).status).toBe(404);
    // Only exactly one row per share, holding the latest point: no history.
    expect((await db().query(`SELECT count(*)::int AS n FROM location_shares WHERE message_id = $1`, [m.id])).rows[0].n).toBe(1);
    for (const d of [lb, lc, ls]) d.remove();
  });

  it('Stop deletes the point; the card says it stopped', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await startLive(a, convo);
    const lb = connect(b);
    const stopped = await as(t.app, a).post(`/v1/location-shares/${m.location.id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.location).toMatchObject({ live: false, point: null, stopReason: 'stopped' });
    expect(await row(m.location.id)).toMatchObject({ lat: null, lng: null, accuracy_m: null, point_at: null, stop_reason: 'stopped' });
    expect(lb.of('location.updated').at(-1)?.data.location).toMatchObject({ live: false, point: null });
    // Stopping twice is fine; a point after it isn't.
    expect((await as(t.app, a).post(`/v1/location-shares/${m.location.id}/stop`)).status).toBe(200);
    expect((await as(t.app, a).post(`/v1/location-shares/${m.location.id}/point`, HERE)).body.error.code).toBe('share_ended');
    const seen = (await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items.find((x: any) => x.id === m.id);
    expect(seen.location).toMatchObject({ live: false, point: null, stopReason: 'stopped' });
    // A new one can start now.
    await startLive(a, convo, { minutes: 15 });
    lb.remove();
  });

  it('stops at its time: the job deletes the point, and the sweep catches any it missed', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await startLive(a, convo, { minutes: 15 });
    const job = (await db().query(`SELECT run_at FROM jobs WHERE kind = $1 AND payload->>'shareId' = $2`, [LOCATION_EXPIRE_JOB, m.location.id])).rows[0];
    expect(new Date(job.run_at).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    const lb = connect(b);
    // Its time comes: until the job runs, everyone already sees it as stopped, without the place.
    await db().query(`UPDATE location_shares SET started_at = started_at - interval '16 minutes', ends_at = ends_at - interval '16 minutes' WHERE id = $1`, [
      m.location.id,
    ]);
    const before = (await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items.find((x: any) => x.id === m.id);
    expect(before.location).toMatchObject({ live: false, point: null, stopReason: 'expired' });
    await db().query(`UPDATE jobs SET run_at = now() WHERE kind = $1 AND payload->>'shareId' = $2`, [LOCATION_EXPIRE_JOB, m.location.id]);
    await runJobs(locationJobHandlers({ db: db(), realtime: t.ctx.realtime }), 50);
    expect(await row(m.location.id)).toMatchObject({ lat: null, lng: null, point_at: null, stop_reason: 'expired' });
    expect(lb.of('location.updated').at(-1)?.data.location).toMatchObject({ live: false, stopReason: 'expired' });

    // A share whose job never ran is stopped by the sweep.
    const other = await startLive(b, convo, { minutes: 15 });
    await db().query(`UPDATE location_shares SET started_at = started_at - interval '1 hour', ends_at = ends_at - interval '1 hour' WHERE id = $1`, [
      other.location.id,
    ]);
    expect(await expireShares({ db: db(), realtime: t.ctx.realtime })).toBeGreaterThanOrEqual(1);
    expect(await row(other.location.id)).toMatchObject({ lat: null, stop_reason: 'expired' });
    lb.remove();
  });

  it('a pin sent once stays like a message until it is unsent', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const r = await share(a, convo, { mode: 'once', minutes: 60 });
    expect(r.status).toBe(201);
    const m = r.body.message;
    expect(m.body).toBe('Location');
    expect(m.location).toMatchObject({ mode: 'once', live: false, endsAt: null, point: { lat: HERE.lat } });
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM jobs WHERE kind = $1 AND payload->>'shareId' = $2`, [LOCATION_EXPIRE_JOB, m.location.id])).rows[0].n,
    ).toBe(0);
    // Several pins at once are fine; Stop is for live shares.
    expect((await share(a, convo, { mode: 'once' })).status).toBe(201);
    expect((await as(t.app, a).post(`/v1/location-shares/${m.location.id}/stop`)).body.error.code).toBe('not_live');
    expect((await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items.find((x: any) => x.id === m.id).location.point.lat).toBe(HERE.lat);

    await as(t.app, a).post(`/v1/messages/${m.id}/unsend`);
    expect(await row(m.location.id)).toMatchObject({ lat: null, lng: null, stop_reason: 'unsent' });
    const after = (await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items.find((x: any) => x.id === m.id);
    expect(after.unsent).toBe(true);
    expect(after.location).toBeUndefined();

    // Unsending a live card stops it too.
    const liveCard = await startLive(a, convo);
    await as(t.app, a).post(`/v1/messages/${liveCard.id}/unsend`);
    expect(await row(liveCard.location.id)).toMatchObject({ lat: null, stop_reason: 'unsent' });
  });
});

describe('Safety', () => {
  it('a block stops shares both ways, and nobody shares into a chat with a block', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const g = await group(a, [b, c]);
    const mine = await startLive(a, convo);
    const inGroup = await startLive(b, g);
    const elsewhere = await startLive(c, g);
    const la = connect(a);

    expect((await as(t.app, b).post(`/v1/users/${a.id}/block`)).status).toBe(200);
    expect(await row(mine.location.id)).toMatchObject({ lat: null, stop_reason: 'blocked' });
    expect(await row(inGroup.location.id)).toMatchObject({ lat: null, stop_reason: 'blocked' });
    // Someone else's share in the group goes on.
    expect(await row(elsewhere.location.id)).toMatchObject({ lat: HERE.lat, stopped_at: null });
    expect(la.of('location.updated').some((e) => e.data.id === mine.id && !e.data.location.live)).toBe(true);

    // Starting again: refused either way while the block stands.
    expect((await share(a, convo, { mode: 'live', minutes: 15 })).status).toBe(403);
    const inBlockedGroup = await share(c, g, { mode: 'once' });
    expect(inBlockedGroup.status).toBe(201);
    expect((await share(a, g, { mode: 'once' })).body.error.code).toBe('location_blocked');
    la.remove();
  });

  it('nobody sees the place on a pin from someone who blocked them', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const g = await group(a, [b, c]);
    const pin = (await share(c, g, { mode: 'once' })).body.message;
    const pinOf = async (u: TestUser) => (await as(t.app, u).get(`/v1/conversations/${g}/messages`)).body.items.find((x: any) => x.id === pin.id);
    expect((await pinOf(b)).location.point.lat).toBe(HERE.lat);
    // c blocks b: b still sees the card in the group they share, without the place; everyone else sees it as before.
    await as(t.app, c).post(`/v1/users/${b.id}/block`);
    expect((await pinOf(b)).location).toMatchObject({ mode: 'once', point: null });
    expect((await pinOf(a)).location.point.lat).toBe(HERE.lat);
    expect((await pinOf(c)).location.point.lat).toBe(HERE.lat);
  });

  it('under-18s share only with friends; adults share with them only as friends and never ask where they are', async () => {
    const [kid, friend, notFriend, grownUp] = [await teen(), await teen(), await teen(), await adult()];
    const withFriend = await direct(kid, friend);
    expect((await share(kid, withFriend, { mode: 'live', minutes: 15 })).status).toBe(201);

    // A group where someone isn't the teen's friend.
    await befriend(kid, friend);
    await befriend(friend, notFriend);
    const g = (await as(t.app, friend).post('/v1/conversations', { memberIds: [kid.id, notFriend.id], title: 'Park' })).body.conversation.id;
    const refused = await share(kid, g, { mode: 'once' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('minor_protection');
    // Once they're friends, it's fine.
    await befriend(kid, notFriend);
    expect((await share(kid, g, { mode: 'once' })).status).toBe(201);

    // An adult who was a friend and isn't any more can't share with the teen.
    const adultChat = await direct(grownUp, kid);
    await unfriend(grownUp, kid);
    expect((await share(grownUp, adultChat, { mode: 'once' })).body.error.code).toBe('minor_protection');
    // Friends again: sharing works, but asking a teen where they are never does.
    await befriend(grownUp, kid);
    expect((await share(grownUp, adultChat, { mode: 'once' })).status).toBe(201);
    const ask = await as(t.app, grownUp).post(`/v1/conversations/${adultChat}/location/request`);
    expect(ask.status).toBe(403);
    expect(ask.body.error.code).toBe('minor_protection');
    // The teen can ask their friends.
    const kidAsks = await as(t.app, kid).post(`/v1/conversations/${withFriend}/location/request`);
    expect(kidAsks.status).toBe(201);
    expect(kidAsks.body.message).toMatchObject({ kind: 'system', system: { type: 'location_request' } });
  });

  it('asking where people are is a line in the chat, once every 10 minutes', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const lb = connect(b);
    expect((await as(t.app, stranger).post(`/v1/conversations/${convo}/location/request`)).status).toBe(404);
    const r = await as(t.app, a).post(`/v1/conversations/${convo}/location/request`);
    expect(r.status).toBe(201);
    expect(lb.of('message.created').find((e) => e.data.id === r.body.message.id)?.data.system).toEqual({ type: 'location_request' });
    const again = await as(t.app, a).post(`/v1/conversations/${convo}/location/request`);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('location_request_too_soon');
    // Asking shares nothing.
    expect((await db().query(`SELECT count(*)::int AS n FROM location_shares WHERE conversation_id = $1`, [convo])).rows[0].n).toBe(0);
    lb.remove();
  });

  it('leaving the chat stops your share; someone joining a group stops the shares there', async () => {
    const [a, b, c, d] = [await adult(), await adult(), await adult(), await adult()];
    const g = await group(a, [b, c]);
    const fromB = await startLive(b, g);
    const fromA = await startLive(a, g);
    await as(t.app, b).post(`/v1/conversations/${g}/leave`);
    expect(await row(fromB.location.id)).toMatchObject({ lat: null, stop_reason: 'left' });
    expect(await row(fromA.location.id)).toMatchObject({ stopped_at: null });
    // Someone who left gets no more updates.
    const lb = connect(b);
    await tenSecondsLater(fromA.location.id);
    await as(t.app, a).post(`/v1/location-shares/${fromA.location.id}/point`, { lat: 6.6, lng: 3.4 });
    expect(lb.of('location.updated')).toEqual([]);
    lb.remove();

    await befriend(a, d);
    expect((await as(t.app, a).post(`/v1/conversations/${g}/members`, { userIds: [d.id] })).status).toBe(200);
    expect(await row(fromA.location.id)).toMatchObject({ lat: null, stop_reason: 'joined' });
  });
});

describe('Where a place never goes', () => {
  it('the data export lists that you shared, with whom and when, never the place', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    await startLive(a, convo);
    await share(a, convo, { mode: 'once' });
    const r = await t.app.inject({ method: 'GET', url: '/v1/me/export', headers: { authorization: `Bearer ${a.token}` } });
    expect(r.statusCode).toBe(200);
    const data = r.json();
    const shares = data.chats.locationShares;
    expect(shares).toHaveLength(2);
    expect(shares[0]).toMatchObject({ conversation_id: convo, shared_with: [b.username] });
    expect(Object.keys(shares[0]).sort()).toEqual(['conversation_id', 'ended_at', 'mode', 'precision', 'shared_with', 'started_at']);
    for (const text of COORD_TEXT) expect(r.body).not.toContain(text);
  });

  it('AI helpers never see a shared place', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: 'Where are you?' });
    await startLive(b, convo);
    await share(b, convo, { mode: 'once' });

    // Suggested replies: a location isn't something to reply to with text.
    const smart = await as(t.app, a).post(`/v1/conversations/${convo}/smart-replies`);
    expect(smart.status).toBe(200);
    expect(smart.body).toMatchObject({ suggestions: [], reason: 'no_text' });

    // Summaries: the model's context holds the chat's words, never a place (nor the cards).
    const seen: string[] = [];
    const provider: AiProvider = {
      name: 'spy',
      model: 'spy-1',
      complete: async ({ prompt }) => (seen.push(prompt), { text: 'They are meeting up.', provider: 'spy', model: 'spy-1' }),
    };
    await new AiGateway(db(), provider).run({ userId: a.id, task: 'summarize_conversation', input: '', conversationId: convo });
    expect(seen[0]).toContain('Where are you?');
    expect(seen[0]).not.toContain('location');
    for (const text of COORD_TEXT) expect(seen.join('\n')).not.toContain(text);
    // Nor do product analytics.
    const events = await db().query(`SELECT properties::text AS p FROM analytics_events WHERE user_id = $1`, [b.id]);
    for (const text of COORD_TEXT) expect(events.rows.map((e) => e.p).join('\n')).not.toContain(text);
  });

  it('coordinates travel only in request bodies, never in the addresses that request logs keep', async () => {
    const routes: string[] = [];
    for (const r of t.app.printRoutes({ commonPrefix: false }).split('\n')) if (/location/.test(r)) routes.push(r);
    expect(routes.join('\n')).not.toMatch(/lat|lng/);
  });
});
