import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RADIO_PAGE_MAX } from '@yapilapi/shared';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, followAccepted, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';

/**
 * Yap Radio (docs/product/yap-radio.md): each station plays the next Yaps in order with a cursor,
 * never one you finished (or quickly skipped on the radio), only what you may hear (audiences,
 * squads, blocks, held words; outside the people you follow, only Yaps whose words passed), and
 * its listening teaches the recommender like any other.
 */

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  await t.ctx.db.query(`UPDATE fair_start_reels SET status = 'stopped', finished_at = now() WHERE status = 'active'`);
  await t.close();
});
const db = () => t.ctx.db;

let sound: Buffer | null = null;
/** A two-second tone, recorded once. */
function tone(): Buffer {
  if (sound) return sound;
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-radio-'));
  try {
    const out = path.join(dir, 'tone.m4a');
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'aac',
      out,
    ]);
    sound = readFileSync(out);
    return sound;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function clip(u: TestUser) {
  const boundary = '----yr' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`),
    tone(),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/voice?purpose=yap',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().voice as { id: string; url: string };
}

/** A public Yap by `u` (or with `extra`: audience, place, line). Returns its post id. */
async function yap(u: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
  const v = await clip(u);
  const r = await as(t.app, u).post('/v1/posts', { format: 'yap', visibility: 'public', body: '', media: [{ id: v.id, url: v.url, kind: 'audio' }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  for (let i = 0; i < 20; i++) if (!(await runJobs(t.ctx.jobs))) break;
  return r.body.post.id;
}

const radio = async (u: TestUser, path: string) => {
  const r = await as(t.app, u).get(`/v1/radio/${path}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    station: { kind: string; key: string | null; title: string | null };
    items: { id: string; format: string; voice: unknown }[];
    nextCursor: string | null;
    needsPlace?: boolean;
  };
};
const ids = async (u: TestUser, path: string) => (await radio(u, path)).items.map((p) => p.id);
/** Every page of a station, following the cursor. */
async function allOf(u: TestUser, station: string, limit = 2): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 30; i++) {
    const sep = station.includes('?') ? '&' : '?';
    const page = await radio(u, `${station}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.items.map((p) => p.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}
const events = (u: TestUser, list: { postId: string; kind: string; valueMs?: number }[]) =>
  as(t.app, u).post('/v1/feed/events', { events: list.map((e) => ({ surface: 'radio', ...e })) });
const tag = () => `radio${randomUUID().replace(/-/g, '').slice(0, 10)}`;

describe('stations', () => {
  it('offers the four main stations, your squads and the tags you follow', async () => {
    const u = await signUp(t.app);
    const mate = await signUp(t.app);
    const squad = (await db().query(`INSERT INTO squads (owner_id, name) VALUES ($1, '[Dev data] Radio crew') RETURNING id`, [u.id])).rows[0].id;
    await db().query(`INSERT INTO squad_members (squad_id, user_id, role, status) VALUES ($1,$2,'owner','active'), ($1,$3,'member','active')`, [
      squad,
      u.id,
      mate.id,
    ]);
    const tg = tag();
    expect((await as(t.app, u).put(`/v1/tags/${tg}/follow`)).status).toBe(200);
    const r = await as(t.app, u).get('/v1/radio');
    expect(r.status).toBe(200);
    const list = r.body.stations as { kind: string; key: string | null; title: string | null }[];
    expect(list.slice(0, 4).map((s) => s.kind)).toEqual(['for_you', 'friends', 'near', 'topics']);
    expect(list).toContainEqual({ kind: 'squad', key: squad, title: '[Dev data] Radio crew' });
    expect(list).toContainEqual({ kind: 'topics', key: tg, title: `#${tg}` });
    expect((await as(t.app, null).get('/v1/radio')).status).toBe(401);
    expect((await as(t.app, u).get('/v1/radio/weather')).status).toBe(400);
    expect((await as(t.app, u).get(`/v1/radio/friends?limit=${RADIO_PAGE_MAX + 1}`)).status).toBe(400);
  });

  it('is behind the YAP_RADIO flag', async () => {
    const u = await signUp(t.app);
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('YAP_RADIO', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      const r = await as(t.app, u).get('/v1/radio/friends');
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('feature_disabled');
    } finally {
      await db().query(`DELETE FROM feature_flags WHERE key = 'YAP_RADIO'`);
    }
  });
});

describe('friends', () => {
  it('plays the people you follow and your friends, newest first, page after page with no repeats', async () => {
    const me = await signUp(t.app);
    const followed = await signUp(t.app);
    const friend = await signUp(t.app);
    const stranger = await signUp(t.app);
    await followAccepted(t.app, me, followed);
    await as(t.app, me).post(`/v1/users/${friend.id}/friend-request`);
    await as(t.app, friend).post(`/v1/users/${me.id}/friend-request`);
    const a = await yap(followed);
    const b = await yap(friend);
    const c = await yap(followed);
    await yap(stranger);
    await yap(me);
    // A text post by someone followed isn't radio.
    await as(t.app, followed).post('/v1/posts', { body: 'Just words', visibility: 'public' });
    expect(await allOf(me, 'friends')).toEqual([c, b, a]);
  });

  it('never plays what you finished, or quickly skipped on the radio, again', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    await followAccepted(t.app, me, them);
    const heard = await yap(them);
    const skipped = await yap(them);
    const skippedElsewhere = await yap(them);
    const fresh = await yap(them);
    expect(
      (
        await events(me, [
          { postId: heard, kind: 'listen_start' },
          { postId: heard, kind: 'listen', valueMs: 1900 },
          { postId: heard, kind: 'listen_complete' },
        ])
      ).body.accepted,
    ).toBe(3);
    await events(me, [{ postId: skipped, kind: 'skip' }]);
    await as(t.app, me).post('/v1/feed/events', { events: [{ postId: skippedElsewhere, surface: 'yaps', kind: 'skip' }] });
    expect(await ids(me, 'friends')).toEqual([fresh, skippedElsewhere]);
    // The listening counts for the Yap like any other.
    const stats = (await db().query(`SELECT listens, listen_completes FROM post_stats WHERE post_id = $1`, [heard])).rows[0];
    expect(stats).toMatchObject({ listens: 1, listen_completes: 1 });
    // A quick skip counts against the Yap, and teaches the recommender "not this".
    expect((await db().query(`SELECT skips FROM post_stats WHERE post_id = $1`, [skipped])).rows[0].skips).toBe(1);
    const kept = (await db().query(`SELECT DISTINCT surface FROM feed_events WHERE user_id = $1 AND post_id = $2`, [me.id, heard])).rows;
    expect(kept).toEqual([{ surface: 'radio' }]);
  });

  it('starts where you left off', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    await followAccepted(t.app, me, them);
    const older = await yap(them);
    const newer = await yap(them);
    expect(await ids(me, `friends?start=${older}`)).toEqual([older, newer]);
    // A Yap that doesn't belong to the station is ignored.
    const other = await yap(await signUp(t.app));
    expect(await ids(me, `friends?start=${other}`)).toEqual([newer, older]);
  });
});

describe('who may hear what', () => {
  it('leaves out blocked people, held words, audiences you are not in and other squads', async () => {
    const me = await signUp(t.app);
    const blocked = await signUp(t.app);
    const blocker = await signUp(t.app);
    const them = await signUp(t.app);
    for (const u of [blocked, blocker, them]) await followAccepted(t.app, me, u);
    await yap(blocked);
    await yap(blocker);
    await as(t.app, me).post(`/v1/users/${blocked.id}/block`);
    await as(t.app, blocker).post(`/v1/users/${me.id}/block`);
    const ok = await yap(them);
    const held = await yap(them);
    await db().query(
      `UPDATE voice_clips SET transcript_status = 'ready', transcript = 'words', screened = 'held' WHERE media_id = (SELECT media_id FROM post_media WHERE post_id = $1)`,
      [held],
    );
    const friendsOnly = await yap(them, { visibility: 'friends' });
    // Their squad, which I'm not in.
    const mate = await signUp(t.app);
    const squad = (await db().query(`INSERT INTO squads (owner_id, name) VALUES ($1, '[Dev data] Not mine') RETURNING id`, [them.id])).rows[0].id;
    await db().query(`INSERT INTO squad_members (squad_id, user_id, role, status) VALUES ($1,$2,'owner','active'), ($1,$3,'member','active')`, [
      squad,
      them.id,
      mate.id,
    ]);
    const squadYap = await yap(them, { visibility: 'squad', squadId: squad });
    const heard = await ids(me, 'friends');
    expect(heard).toEqual([ok]);
    expect(heard).not.toContain(friendsOnly);
    expect(heard).not.toContain(squadYap);
    // Not on their profile's station either, and the squad's station is members only.
    expect(await ids(me, `person?key=${them.username}`)).toEqual([ok]);
    const r = await as(t.app, me).get(`/v1/radio/squad?key=${squad}`);
    expect(r.status).toBe(404);
    expect(await ids(mate, `squad?key=${squad}`)).toEqual([squadYap]);
    expect((await as(t.app, me).get(`/v1/radio/person?key=${blocker.username}`)).status).toBe(404);
  });

  it('plays only Yaps whose words passed outside the people you follow', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    const tg = tag();
    const passed = await yap(them, { body: `#${tg}` });
    const pending = await yap(them, { body: `#${tg}` });
    await db().query(`UPDATE voice_clips SET transcript_status = 'pending' WHERE media_id = (SELECT media_id FROM post_media WHERE post_id = $1)`, [pending]);
    expect(await ids(me, `topics?key=${tg}`)).toEqual([passed]);
    expect(await ids(me, `person?key=${them.username}`)).toEqual([passed]);
    // Once you follow them, their Yap reaches you as it does on Pulse.
    await followAccepted(t.app, me, them);
    expect(await ids(me, 'friends')).toEqual([pending, passed]);
    expect(await ids(me, `person?key=${them.username}`)).toEqual([pending, passed]);
  });
});

describe('topics, places and near you', () => {
  it('plays the tags you follow, or one you pick', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    const tg = tag();
    const other = tag();
    const a = await yap(them, { body: `About #${tg}` });
    const b = await yap(them, { body: `About #${other}` });
    expect(await ids(me, 'topics')).toEqual([]);
    await as(t.app, me).put(`/v1/tags/${tg}/follow`);
    expect(await ids(me, 'topics')).toEqual([a]);
    const picked = await radio(me, `topics?key=${other}`);
    expect(picked.items.map((p) => p.id)).toEqual([b]);
    expect(picked.station).toEqual({ kind: 'topics', key: other, title: `#${other}` });
  });

  it('plays a place, the places near you, or your city', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    const city = `Radiotown ${randomUUID().slice(0, 6)}`;
    const lat = -40 + Math.random() * 10;
    const lng = -120 + Math.random() * 10;
    const place = (
      await db().query(
        `INSERT INTO places (name, category, city, lat, lng, created_by) VALUES ('[Dev data] Corner', 'restaurant', $1, $2, $3, $4) RETURNING id`,
        [city, lat, lng, them.id],
      )
    ).rows[0].id;
    const here = await yap(them, { placeId: place });
    await yap(them);
    expect(await ids(me, `place?key=${place}`)).toEqual([here]);
    expect((await as(t.app, me).get(`/v1/radio/place?key=${randomUUID()}`)).status).toBe(404);
    expect(await ids(me, `near?lat=${(lat + 0.05).toFixed(3)}&lng=${lng.toFixed(3)}`)).toEqual([here]);
    expect(await ids(me, `near?lat=${(lat + 5).toFixed(3)}&lng=${lng.toFixed(3)}`)).toEqual([]);
    const none = await radio(me, 'near');
    expect(none).toMatchObject({ items: [], needsPlace: true });
    await db().query(`UPDATE profiles SET city = $2 WHERE user_id = $1`, [me.id, city.toUpperCase()]);
    const byCity = await radio(me, 'near');
    expect(byCity.items.map((p) => p.id)).toEqual([here]);
    expect(byCity.needsPlace).toBeUndefined();
  });
});

describe('for you', () => {
  it('ranks Yaps you may be suggested, page by page, without repeats or what you heard', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    await followAccepted(t.app, me, them);
    const mine = [await yap(them), await yap(them), await yap(them)];
    const first = await radio(me, 'for_you?limit=1');
    expect(first.station.kind).toBe('for_you');
    const all = await allOf(me, 'for_you', 5);
    expect(new Set(all).size).toBe(all.length);
    for (const id of mine) expect(all).toContain(id);
    expect(first.items.every((p) => p.format === 'yap' && p.voice)).toBe(true);
    await events(me, [{ postId: mine[0]!, kind: 'listen_complete' }]);
    const again = await allOf(me, 'for_you', 5);
    expect(again).not.toContain(mine[0]);
    expect(again).toContain(mine[1]);
    // Where you left off goes first.
    expect((await ids(me, `for_you?start=${mine[2]}`))[0]).toBe(mine[2]);
  });
});
