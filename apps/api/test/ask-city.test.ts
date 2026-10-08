import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_NOTIFY_PER_DAY, ASK_PER_DAY, askAreaPoint, type MapItem, type Post } from '@yapilapi/shared';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import type { BuiltApp } from '../src/app.ts';
import type { TranscriptionProvider } from '../src/lib/transcription.ts';
import { mixInQuestions, notifyNearby } from '../src/lib/ask-city.ts';
import { as, followAccepted, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';

/**
 * Ask the city (lib/ask-city.ts, modules/ask-city.ts, docs/product/ask-the-city.md): questions to
 * people nearby, by area only, answered by voice or text, with helpful answers first, a helper
 * count on profiles, a few notifications a day for people who opted in, a map layer and an
 * occasional slot in For you. Each test works in a city of its own.
 */
let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  t.ctx.transcription = null;
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'ASK_CITY'`);
  await t.close();
});

const db = () => t.ctx.db;
const flag = (key: string, on: boolean) =>
  db().query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`, [key, on]);
const adult = (extra: Record<string, unknown> = {}) => signUp(t.app, { birthDate: '1990-04-02', ...extra });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });
const town = () => `Town ${randomUUID().slice(0, 8)}`;
const setCity = (u: TestUser, city: string) => as(t.app, u).patch('/v1/me/profile', { city });
const drain = async () => {
  for (let i = 0; i < 20; i++) if (!(await runJobs(t.ctx.jobs))) break;
};

const ask = (u: TestUser, body: Record<string, unknown>) => as(t.app, u).post('/v1/ask', { topic: 'food', body: 'Best suya near here?', ...body });
const listIds = async (u: TestUser, qs: string) => {
  const r = await as(t.app, u).get(`/v1/ask?${qs}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.items as Post[]).map((p) => p.id);
};
const answer = (u: TestUser, postId: string, body = 'Try the spot by the bus stop.') => as(t.app, u).post(`/v1/posts/${postId}/comments`, { body });
const notices = async (u: TestUser, type = 'ask_nearby') =>
  (await db().query(`SELECT entity_id, data FROM notifications WHERE user_id = $1 AND type = $2`, [u.id, type])).rows as { entity_id: string; data: any }[];
const helpOn = (u: TestUser, city: string, topics?: string[]) => as(t.app, u).put('/v1/me/ask-settings', { on: true, city, ...(topics ? { topics } : {}) });

let placeN = 0;
async function place(by: TestUser, at: { lat: number; lng: number }, city: string) {
  const r = await as(t.app, by).post('/v1/places', { name: `Market ${++placeN}`, category: 'venue', city, ...at });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.place.id as string;
}

/** A short tone, recorded as the phone does. */
let toneBuf: Buffer | null = null;
function tone(): Buffer {
  if (toneBuf) return toneBuf;
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-ask-'));
  try {
    const out = path.join(dir, 'tone.m4a');
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=2',
      '-c:a',
      'aac',
      out,
    ]);
    toneBuf = readFileSync(out);
    return toneBuf;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function clip(u: TestUser, purpose = 'yap') {
  const boundary = '----ya' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`),
    tone(),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/voice?purpose=${purpose}`,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().voice as { id: string; url: string };
}
function provider(say: () => string): TranscriptionProvider {
  return { name: 'stub', transcribe: async () => say() };
}

describe('asking', () => {
  it('asks about a place, a city or the part of the map on screen, and never keeps where the asker is', async () => {
    const city = town();
    const ada = await adult();
    const spot = { lat: 6.5095, lng: 3.3711 };
    const placeId = await place(ada, spot, city);

    const atPlace = await ask(ada, { area: { placeId } });
    expect(atPlace.status, JSON.stringify(atPlace.body)).toBe(201);
    expect(atPlace.body.post).toMatchObject({
      visibility: 'public',
      place: { id: placeId },
      askCity: { topic: 'food', city, placeId, open: true, answers: 0 },
    });
    expect(atPlace.body.post.askCity.area).toMatch(/^Market /);

    // From the map: only the middle of the view, on the 2 km grid.
    const box = { south: 6.4, west: 3.3, north: 6.6, east: 3.5 };
    const fromMap = await ask(ada, { area: { box } });
    expect(fromMap.status, JSON.stringify(fromMap.body)).toBe(201);
    expect(fromMap.body.post.askCity).toMatchObject({ city, area: null, placeId: null });
    const kept = (await db().query(`SELECT lat, lng FROM ask_city_questions WHERE post_id = $1`, [fromMap.body.post.id])).rows[0];
    expect(kept).toEqual(askAreaPoint(box));
    expect(kept.lat).not.toBe(6.5);

    // A city alone (the profile's when nothing else is given), or nothing usable.
    const noCity = await adult();
    expect((await ask(noCity, { area: {} })).status).toBe(400);
    const far = await ask(noCity, { area: { box: { south: -60.1, west: -170.1, north: -60, east: -170 } } });
    expect(far.status).toBe(400);
    expect(far.body.error.message).toBe('Choose a place or a city for your question.');
    await setCity(noCity, city);
    const fromProfile = await ask(noCity, { area: { city } });
    expect(fromProfile.body.post.askCity).toMatchObject({ city, area: null });
  });

  it('closes traffic questions after an hour unless told otherwise, and keeps others open', async () => {
    const city = town();
    const ada = await adult();
    const traffic = await ask(ada, { topic: 'traffic', body: 'Is Third Mainland jammed?', area: { city } });
    const at = Date.parse(traffic.body.post.askCity.expiresAt);
    expect(at - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(at - Date.now()).toBeLessThan(61 * 60_000);
    const open = await ask(ada, { topic: 'traffic', body: 'Roads near the stadium on Saturday?', area: { city }, expires: null });
    expect(open.body.post.askCity.expiresAt).toBeNull();
    const week = await ask(ada, { area: { city }, expires: 'week' });
    expect(Date.parse(week.body.post.askCity.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const today = await ask(ada, { area: { city }, expires: 'today', timeZone: 'Africa/Lagos' });
    expect(Date.parse(today.body.post.askCity.expiresAt) - Date.now()).toBeLessThanOrEqual(25 * 3_600_000);

    // Past its end, it's out of the list and shows as closed, but still takes answers.
    await db().query(`UPDATE ask_city_questions SET expires_at = now() - interval '1 minute' WHERE post_id = $1`, [traffic.body.post.id]);
    const viewer = await adult();
    const ids = await listIds(viewer, `city=${encodeURIComponent(city)}`);
    expect(ids).not.toContain(traffic.body.post.id);
    expect(ids).toContain(open.body.post.id);
    const seen = await as(t.app, viewer).get(`/v1/posts/${traffic.body.post.id}`);
    expect(seen.body.post.askCity.open).toBe(false);
    expect((await answer(viewer, traffic.body.post.id)).status).toBe(201);
  });

  it('asks by voice: a Yap with the question’s topic and area', async () => {
    const city = town();
    const ada = await adult();
    const v = await clip(ada);
    const r = await ask(ada, { body: '', voiceId: v.id, topic: 'services', area: { city } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.post).toMatchObject({ format: 'yap', kind: 'audio', voice: { id: v.id }, askCity: { topic: 'services' } });
    // Neither words nor voice: nothing to ask.
    expect((await ask(ada, { body: '', area: { city } })).status).toBe(400);
    // A clip that isn't yours.
    const other = await adult();
    expect((await ask(other, { body: '', voiceId: (await clip(ada)).id, area: { city } })).status).toBe(404);
  });

  it('refuses questions about where someone lives, and keeps to a pace', async () => {
    const city = town();
    const ada = await adult();
    const r = await ask(ada, { body: 'Where does Tunde Bakare live these days?', area: { city } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('Ask about places and things, not where someone lives.');
    expect((await ask(ada, { body: 'Where does the danfo to Ikeja stop?', area: { city } })).status).toBe(201);
    await db().query(`UPDATE ask_city_questions SET created_at = now() - interval '2 days' WHERE author_id = $1`, [ada.id]);
    for (let i = 0; i < ASK_PER_DAY; i++) expect((await ask(ada, { body: `Question ${i}?`, area: { city } })).status).toBe(201);
    const over = await ask(ada, { body: 'One more?', area: { city } });
    expect(over.status).toBe(429);
  });

  it('is held like any post when its words are flagged, and found by nobody else until cleared', async () => {
    const city = town();
    const ada = await adult();
    const viewer = await adult();
    const r = await ask(ada, { body: 'Cheap followers anyone? buy followers here', area: { city } });
    expect(r.status).toBe(201);
    expect(r.body.moderation).toBeTruthy();
    expect(await listIds(viewer, `city=${encodeURIComponent(city)}`)).not.toContain(r.body.post.id);
    expect(await listIds(ada, `city=${encodeURIComponent(city)}`)).toContain(r.body.post.id);
  });

  it('is behind the ASK_CITY flag', async () => {
    const ada = await adult();
    await flag('ASK_CITY', false);
    try {
      expect((await ask(ada, { area: { city: town() } })).status).toBe(404);
      expect((await as(t.app, ada).get('/v1/ask')).status).toBe(404);
    } finally {
      await flag('ASK_CITY', true);
    }
  });
});

describe('finding questions', () => {
  it('lists open questions in a city or a box: waiting for an answer first, then the newest, by topic', async () => {
    const city = town();
    const [ada, bola, chi] = [await adult(), await adult(), await adult()];
    const spot = { lat: 9.07, lng: 7.48 };
    const placeId = await place(ada, spot, city);
    const a = (await ask(ada, { area: { placeId } })).body.post.id;
    const b = (await ask(bola, { topic: 'traffic', body: 'Is the expressway clear?', area: { city } })).body.post.id;
    const c = (await ask(bola, { topic: 'events', body: 'Anything on tonight?', area: { city } })).body.post.id;
    await answer(chi, c);
    expect(await listIds(chi, `city=${encodeURIComponent(city.toUpperCase())}`)).toEqual([b, a, c]);
    expect(await listIds(chi, `city=${encodeURIComponent(city)}&topic=traffic`)).toEqual([b]);
    // By box: questions whose area is inside (a place, a map area, or a city's middle: its place pages').
    const elsewhere = (await ask(chi, { area: { box: { south: 9.5, west: 7.9, north: 9.6, east: 8 }, city } })).body.post.id;
    const inBox = await listIds(chi, `south=${spot.lat - 0.05}&west=${spot.lng - 0.05}&north=${spot.lat + 0.05}&east=${spot.lng + 0.05}`);
    expect(inBox).toEqual(expect.arrayContaining([a, b, c]));
    expect(inBox).not.toContain(elsewhere);
    await as(t.app, chi).del(`/v1/posts/${elsewhere}`);
    // No city given: the one you help in, or your profile's; none at all: nothing.
    const none = await as(t.app, chi).get('/v1/ask');
    expect(none.body).toMatchObject({ city: null, items: [] });
    await setCity(chi, city);
    expect((await as(t.app, chi).get('/v1/ask')).body.city).toBe(city);
    // Paging.
    const page = await as(t.app, chi).get(`/v1/ask?city=${encodeURIComponent(city)}&limit=2`);
    expect(page.body.items).toHaveLength(2);
    const next = await as(t.app, chi).get(`/v1/ask?city=${encodeURIComponent(city)}&limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`);
    expect((next.body.items as Post[]).map((p) => p.id)).toEqual([c]);
    // Your own, open or closed.
    const mine = await as(t.app, bola).get('/v1/ask/mine');
    expect((mine.body.items as Post[]).map((p) => p.id)).toEqual([c, b]);
  });

  it('follows who may see the post: blocks both ways and private accounts', async () => {
    const city = town();
    const [ada, viewer, follower] = [await adult(), await adult(), await adult()];
    const q = (await ask(ada, { area: { city } })).body.post.id;
    await as(t.app, viewer).post(`/v1/users/${ada.id}/block`);
    expect(await listIds(viewer, `city=${encodeURIComponent(city)}`)).not.toContain(q);
    const shy = await adult();
    await as(t.app, shy).patch('/v1/me/profile', { isPrivate: true });
    const p = (await ask(shy, { area: { city } })).body.post.id;
    await followAccepted(t.app, follower, shy);
    expect(await listIds(follower, `city=${encodeURIComponent(city)}`)).toContain(p);
    expect(await listIds(await adult(), `city=${encodeURIComponent(city)}`)).not.toContain(p);
  });

  it('shows open questions on the Near you map by their area, and not when the flag is off', async () => {
    const city = town();
    const ada = await adult();
    const spot = { lat: -33.1 + Math.random(), lng: 18.2 + Math.random() };
    const placeId = await place(ada, spot, city);
    const q = (await ask(ada, { body: 'Who fixes phones around here?', topic: 'services', area: { placeId } })).body.post.id;
    const viewer = await adult();
    const qs = `south=${spot.lat - 0.05}&west=${spot.lng - 0.05}&north=${spot.lat + 0.05}&east=${spot.lng + 0.05}&layers=questions`;
    const r = await as(t.app, viewer).get(`/v1/map?${qs}`);
    expect(r.status).toBe(200);
    const item = (r.body.items as MapItem[]).find((i) => i.key === `questions:${q}`);
    expect(item).toMatchObject({ layer: 'questions', title: 'Who fixes phones around here?', point: spot, target: { kind: 'post', id: q }, count: 0 });
    expect(item!.subtitle).toContain(city);
    await flag('ASK_CITY', false);
    try {
      const off = await as(t.app, viewer).get(`/v1/map?${qs}`);
      expect(off.body.items).toEqual([]);
    } finally {
      await flag('ASK_CITY', true);
    }
  });
});

describe('answers', () => {
  it('takes voice and text answers; only the asker marks them helpful, and helpful ones come first', async () => {
    const city = town();
    const [ada, bola, chi] = [await adult(), await adult(), await adult()];
    const q = (await ask(ada, { area: { city } })).body.post.id;
    const text = (await answer(bola, q, 'Suya Spot on Herbert Macaulay.')).body.comment.id;
    const v = await clip(chi, 'comment');
    const voice = await as(t.app, chi).post(`/v1/posts/${q}/comments`, { voiceId: v.id });
    expect(voice.status, JSON.stringify(voice.body)).toBe(201);
    const own = (await answer(ada, q, 'Thanks all')).body.comment.id;

    expect((await as(t.app, bola).put(`/v1/ask/${q}/helpful/${voice.body.comment.id}`)).status).toBe(403);
    expect((await as(t.app, ada).put(`/v1/ask/${q}/helpful/${own}`)).status).toBe(400);
    expect((await as(t.app, ada).put(`/v1/ask/${q}/helpful/${randomUUID()}`)).status).toBe(404);
    expect((await as(t.app, ada).put(`/v1/ask/${q}/helpful/${voice.body.comment.id}`)).status).toBe(200);
    expect((await as(t.app, ada).put(`/v1/ask/${q}/helpful/${voice.body.comment.id}`)).status).toBe(200);

    const list = await as(t.app, bola).get(`/v1/posts/${q}/comments`);
    expect(list.body.items[0]).toMatchObject({ id: voice.body.comment.id, helpful: true, voice: { id: v.id } });
    expect(list.body.items.find((c: { id: string }) => c.id === text).helpful).toBeUndefined();
    const post = await as(t.app, bola).get(`/v1/posts/${q}`);
    expect(post.body.post.askCity).toMatchObject({ helpful: 1, answers: 3 });
    // The answerer hears it.
    expect(await notices(chi, 'ask_helpful')).toEqual([expect.objectContaining({ entity_id: q })]);

    expect((await as(t.app, ada).del(`/v1/ask/${q}/helpful/${voice.body.comment.id}`)).status).toBe(200);
    expect((await as(t.app, bola).get(`/v1/posts/${q}`)).body.post.askCity.helpful).toBe(0);
  });

  it('counts the different people an answerer helped, in the city where they helped most, on their profile', async () => {
    const city = town();
    const helper = await adult();
    const askers = [await adult(), await adult()];
    for (const a of askers) {
      for (let i = 0; i < 2; i++) {
        const q = (await ask(a, { body: `Where to fix a bike? ${i}`, area: { city } })).body.post.id;
        const c = (await answer(helper, q)).body.comment.id;
        await as(t.app, a).put(`/v1/ask/${q}/helpful/${c}`);
      }
    }
    const other = await adult();
    const profile = await as(t.app, other).get(`/v1/users/${helper.username}`);
    expect(profile.body.profile.localHelper).toEqual({ people: 2, city });
    expect((await as(t.app, other).get(`/v1/users/${other.username}`)).body.profile.localHelper).toBeNull();

    // Someone under 18: only they see theirs (it names a city).
    const kid = await teen();
    const kidAsker = await teen();
    const q = (await ask(kidAsker, { area: { city } })).body.post.id;
    await followAccepted(t.app, kid, kidAsker);
    const c = (await answer(kid, q)).body.comment.id;
    expect((await as(t.app, kidAsker).put(`/v1/ask/${q}/helpful/${c}`)).status).toBe(200);
    expect((await as(t.app, kid).get(`/v1/users/${kid.username}`)).body.profile.localHelper).toEqual({ people: 1, city });
    await followAccepted(t.app, other, kid);
    expect((await as(t.app, other).get(`/v1/users/${kid.username}`)).body.profile.localHelper).toBeNull();
  });
});

describe('telling people nearby', () => {
  it('is off by default, follows the city and topics chosen, and never tells the asker', async () => {
    const city = town();
    const [ada, bola, chi, dayo] = [await adult(), await adult(), await adult(), await adult()];
    expect((await as(t.app, bola).get('/v1/me/ask-settings')).body.settings).toMatchObject({ on: false, city: null });
    await setCity(bola, city);
    expect((await as(t.app, bola).get('/v1/me/ask-settings')).body.settings).toMatchObject({ on: false, city });
    expect((await as(t.app, bola).put('/v1/me/ask-settings', { on: true })).body.settings).toMatchObject({
      on: true,
      city,
      topics: expect.arrayContaining(['food', 'safety']),
    });
    await helpOn(chi, city, ['traffic']);
    await helpOn(dayo, town());
    await helpOn(ada, city);
    const q = (await ask(ada, { area: { city } })).body.post.id;
    await drain();
    expect(await notices(bola)).toEqual([expect.objectContaining({ entity_id: q, data: expect.objectContaining({ topic: 'food', area: city }) })]);
    expect(await notices(chi)).toEqual([]);
    expect(await notices(dayo)).toEqual([]);
    expect(await notices(ada)).toEqual([]);
    // Turned off: the row goes.
    await as(t.app, bola).put('/v1/me/ask-settings', { on: false });
    expect((await db().query(`SELECT 1 FROM ask_city_helpers WHERE user_id = $1`, [bola.id])).rowCount).toBe(0);
  });

  it(`sends at most ${ASK_NOTIFY_PER_DAY} a day, nobody twice, and nothing in quiet hours`, async () => {
    const city = town();
    const [helper, quiet] = [await adult(), await adult()];
    await helpOn(helper, city);
    await helpOn(quiet, city);
    await db().query(
      `UPDATE user_preferences SET quiet_start = ((now() AT TIME ZONE 'UTC') - interval '1 hour')::time,
                                   quiet_end = ((now() AT TIME ZONE 'UTC') + interval '1 hour')::time, quiet_timezone = 'UTC' WHERE user_id = $1`,
      [quiet.id],
    );
    const ids: string[] = [];
    for (let i = 0; i < ASK_NOTIFY_PER_DAY + 2; i++) ids.push((await ask(await adult(), { body: `Good tailor? ${i}`, area: { city } })).body.post.id);
    await drain();
    expect(await notices(helper)).toHaveLength(ASK_NOTIFY_PER_DAY);
    expect(await notices(quiet)).toHaveLength(0);
    expect(await notifyNearby(t.ctx, ids[0]!)).toBe(0);
  });

  it('never reaches people blocked either way, or people under 18 about adults’ questions', async () => {
    const city = town();
    const [ada, blocked, blocker, kid] = [await adult(), await adult(), await adult(), await teen()];
    for (const u of [blocked, blocker, kid]) await helpOn(u, city);
    await as(t.app, ada).post(`/v1/users/${blocked.id}/block`);
    await as(t.app, blocker).post(`/v1/users/${ada.id}/block`);
    await ask(ada, { area: { city } });
    await drain();
    expect(await notices(blocked)).toEqual([]);
    expect(await notices(blocker)).toEqual([]);
    expect(await notices(kid)).toEqual([]);
    // Someone under 18's question reaches other people under 18 who may see it, never adults.
    const kidAsker = await teen();
    await followAccepted(t.app, kid, kidAsker);
    const grown = await adult();
    await helpOn(grown, city);
    await followAccepted(t.app, grown, kidAsker);
    const q = (await ask(kidAsker, { area: { city } })).body.post.id;
    await drain();
    expect(await notices(kid)).toEqual([expect.objectContaining({ entity_id: q })]);
    expect(await notices(grown)).toEqual([]);
  });

  it('waits for a spoken question’s words, and tells nobody when they’re held', async () => {
    const city = town();
    const helper = await adult();
    await helpOn(helper, city);
    t.ctx.transcription = provider(() => 'WEBVTT\n\n00:00.000 --> 00:01.900\nBuy followers here, cheap followers\n');
    try {
      const ada = await adult();
      const q = (await ask(ada, { body: '', voiceId: (await clip(ada)).id, area: { city } })).body.post.id;
      await drain();
      expect((await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [q])).rows[0].moderation_status).not.toBe('normal');
      expect(await notices(helper)).toEqual([]);
      expect(await listIds(helper, `city=${encodeURIComponent(city)}`)).not.toContain(q);
    } finally {
      t.ctx.transcription = null;
    }
    t.ctx.transcription = provider(() => 'WEBVTT\n\n00:00.000 --> 00:01.900\nWhere is the best suya in Yaba\n');
    try {
      const bola = await adult();
      const q = (await ask(bola, { body: '', voiceId: (await clip(bola)).id, area: { city } })).body.post.id;
      await drain();
      console.log(
        JSON.stringify(
          (
            await db().query(
              `SELECT kind, payload, status, run_at > now() AS later, last_error FROM jobs WHERE payload->>'postId' = $1 OR kind like 'voice%' ORDER BY id DESC LIMIT 6`,
              [q],
            )
          ).rows,
        ),
      );
      // A look before the words came back waits and looks again a little later (run here at once).
      if (!(await notices(helper)).length) {
        const again = await db().query(`SELECT payload FROM jobs WHERE kind = 'ask.city.notify' AND payload->>'postId' = $1 AND run_at > now()`, [q]);
        expect(again.rows[0]?.payload).toMatchObject({ tries: 1 });
        expect(await notifyNearby(t.ctx, q, 1)).toBe(1);
      }
      expect(await notices(helper)).toEqual([expect.objectContaining({ entity_id: q })]);
    } finally {
      t.ctx.transcription = null;
    }
  });
});

describe('in the feed', () => {
  it('puts a question from your city in one slot of every 15, never your own or one you answered, and keeps to your age group', async () => {
    const city = town();
    const viewer = await adult();
    await setCity(viewer, city);
    const [ada, bola] = [await adult(), await adult()];
    const first = (await ask(ada, { area: { city } })).body.post.id;
    const second = (await ask(bola, { body: 'Late-night pharmacy?', topic: 'services', area: { city } })).body.post.id;
    await answer(viewer, second);
    await ask(viewer, { body: 'My own question', area: { city } });
    const ranked = Array.from({ length: 30 }, () => ({ id: randomUUID(), reason: { code: 'popular' as const } }));
    const mixed = await mixInQuestions(db(), viewer.id, 'for_you', 0, ranked, '');
    expect(mixed).toHaveLength(31);
    expect(mixed[14]).toEqual({ id: first, reason: { code: 'ask_city' } });
    // The second page carries on from where the first stopped; no more questions to give.
    expect(await mixInQuestions(db(), viewer.id, 'for_you', 30, ranked, '')).toHaveLength(30);
    // The Yaps filter takes spoken questions only.
    expect(await mixInQuestions(db(), viewer.id, 'yaps', 0, ranked, '')).toHaveLength(30);
    // People under 18 don't get adults' questions.
    const kid = await teen();
    await setCity(kid, city);
    expect(await mixInQuestions(db(), kid.id, 'for_you', 0, ranked, '')).toHaveLength(30);
  });
});

describe('your data', () => {
  it('exports your questions, helpful marks and helper settings', async () => {
    const city = town();
    const ada = await adult();
    await helpOn(ada, city, ['food']);
    const q = (await ask(ada, { area: { city } })).body.post.id;
    const r = await as(t.app, ada).get('/v1/me/export');
    expect(r.status).toBe(200);
    const content = r.body.content ?? r.body.export?.content ?? r.body;
    expect(JSON.stringify(content)).toContain(q);
    expect(JSON.stringify(content)).toContain('"helping"');
  });
});
