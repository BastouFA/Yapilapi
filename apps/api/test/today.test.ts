import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { devProvider, type AiProvider } from '../src/lib/ai/providers.ts';
import type { SpeechProvider } from '../src/lib/speech.ts';
import { sweepToday, todayAvailable, type TodayDeps } from '../src/lib/today.ts';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * Yapilapi Today (docs/product/yapilapi-today.md): a morning briefing written from the posts and
 * Yaps the listener can see, read aloud. A stand-in model (it writes one segment per item it is
 * given, "About @name: …", in the language asked for) and a stand-in voice answer; nothing paid
 * is called.
 */

const LANG_NAMES: Record<string, string> = { English: 'en', French: 'fr' };

/** A model that writes one segment per item and remembers what it was given. */
function stubModel() {
  const calls: { part: 'people' | 'city'; lang: string; prompt: string }[] = [];
  const provider: AiProvider = {
    name: 'stub',
    model: 'stub-today-1',
    async complete({ system, prompt }) {
      const part = system.includes('people in their city') ? 'city' : 'people';
      const lang = LANG_NAMES[/Write in (\w+)\./.exec(system)?.[1] ?? ''] ?? '?';
      calls.push({ part, lang, prompt });
      const items = [...prompt.matchAll(/^\[(\d+)\] @(\S+)/gm)];
      const segments = items.map((m) => ({ text: `${lang === 'fr' ? 'À propos de' : 'About'} @${m[2]}: a short line.`, posts: [Number(m[1])] }));
      return { text: JSON.stringify({ segments }), provider: 'stub', model: 'stub-today-1' };
    },
  };
  return { provider, calls };
}

/** Text-to-speech that counts what it reads. */
function stubSpeech() {
  const said: string[] = [];
  const provider: SpeechProvider = {
    name: 'stub-tts',
    model: 'stub-voice-1',
    voiceFor: () => 'alloy',
    async synthesize({ text }) {
      said.push(text);
      return { audio: Buffer.from(`ID3 spoken:${text}`), mime: 'audio/mpeg', ext: 'mp3' };
    },
  };
  return { provider, said };
}

let t: BuiltApp;
const model = stubModel();
const tts = stubSpeech();
const db = () => t.ctx.db;
const CITY = `Testville ${randomUUID().slice(0, 6)}`;

let ada: TestUser; // the listener: English, lives in CITY
let bola: TestUser; // Ada follows her
let carl: TestUser; // Ada follows him, then blocks him
let dan: TestUser; // private account; Ada's follow request is pending
let gus: TestUser; // Ada follows and mutes him
let kid: TestUser; // under 18; Ada follows them
let sam: TestUser; // in Ada's squad
let zed: TestUser; // in another squad
let cora: TestUser; // lives in CITY, public
let priv: TestUser; // lives in CITY, private account
let teen: TestUser; // lives in CITY, under 18
const posts: Record<string, string> = {};

/** An hour-aligned zone where it is `hour` o'clock now. */
function zoneAt(hour: number): string {
  const off = (((hour - new Date().getUTCHours()) % 24) + 24) % 24;
  const o = off > 12 ? off - 24 : off;
  return o === 0 ? 'Etc/UTC' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`;
}

async function person(name: string, extra: Record<string, unknown> = {}): Promise<TestUser> {
  const u = await signUp(t.app, { birthDate: '1990-04-02', ...extra });
  await db().query(`UPDATE profiles SET display_name = $2, username = $3 WHERE user_id = $1`, [u.id, name, `${name.toLowerCase()}_${u.id.slice(0, 6)}`]);
  return { ...u, username: `${name.toLowerCase()}_${u.id.slice(0, 6)}` };
}

async function say(u: TestUser, key: string, body: string, visibility = 'public') {
  const r = await as(t.app, u).post('/v1/posts', { body, visibility });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  posts[key] = r.body.post.id;
  return r.body.post.id as string;
}

/** A Yap by `u` whose transcript says `words` (`held`: its words didn't pass the checks). */
async function yap(u: TestUser, key: string, words: string, held = false) {
  const id = await say(u, key, 'placeholder');
  await db().query(`UPDATE posts SET body = '' WHERE id = $1`, [id]);
  const m = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, storage_key, duration_ms) VALUES ($1,'audio',$2,'audio/mp4','ready',$3,9000) RETURNING id`,
    [u.id, `/media/yap-${id}.m4a`, `yap-${id}.m4a`],
  );
  await db().query(
    `INSERT INTO voice_clips (media_id, owner_id, purpose, duration_ms, transcript_status, transcript, lang, screened) VALUES ($1,$2,'yap',9000,'ready',$3,'en',$4)`,
    [m.rows[0].id, u.id, words, held ? 'held' : 'passed'],
  );
  await db().query(`INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,0)`, [id, m.rows[0].id]);
  await db().query(`UPDATE posts SET format = 'yap', kind = 'audio' WHERE id = $1`, [id]);
  return id;
}

async function squad(owner: TestUser, members: TestUser[]) {
  const { rows } = await db().query(`INSERT INTO squads (owner_id, name) VALUES ($1, 'Crew') RETURNING id`, [owner.id]);
  for (const m of [owner, ...members])
    await db().query(`INSERT INTO squad_members (squad_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())`, [
      rows[0].id,
      m.id,
      m.id === owner.id ? 'owner' : 'member',
    ]);
  return rows[0].id as string;
}

const settle = (u: TestUser, b: Record<string, unknown>) => as(t.app, u).put('/v1/me/today', b);
const today = (u: TestUser) => as(t.app, u).get('/v1/today');
const forget = (u: TestUser) => db().query(`DELETE FROM today_briefings WHERE user_id = $1`, [u.id]);
const deps = (): TodayDeps => ({
  db: db(),
  storage: t.ctx.storage,
  speech: t.ctx.speech,
  realtime: t.ctx.realtime,
  provider: t.ctx.ai.briefer,
  config: t.ctx.config,
});
const peopleCalls = (u: TestUser) => model.calls.filter((c) => c.part === 'people' && c.prompt.includes(`@${u.username}`));

beforeAll(async () => {
  t = await testApp({}, { briefer: model.provider });
  t.ctx.speech = tts.provider;
  ada = await person('Ada');
  bola = await person('Bola');
  carl = await person('Carl');
  dan = await person('Dan');
  gus = await person('Gus');
  kid = await person('Kid', { birthDate: '2012-03-03' });
  sam = await person('Sam');
  zed = await person('Zed');
  cora = await person('Cora');
  priv = await person('Priv');
  teen = await person('Teen', { birthDate: '2011-06-06' });
  await db().query(`UPDATE profiles SET city = $2 WHERE user_id = ANY($1::uuid[])`, [[ada.id, cora.id, priv.id, teen.id], CITY]);
  await db().query(`UPDATE profiles SET is_private = true WHERE user_id = ANY($1::uuid[])`, [[dan.id, priv.id]]);
  for (const u of [bola, carl, gus, kid]) await followAccepted(t.app, ada, u);
  await as(t.app, ada).post(`/v1/users/${dan.id}/follow`);
  await db().query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1,$2)`, [ada.id, gus.id]);
  const mine = await squad(sam, [ada]);
  const theirs = await squad(zed, [bola]);

  await say(bola, 'bola', 'Bola opened a bakery on Market Street this morning.');
  await say(bola, 'bolaHeld', 'Bola wrote something waiting for review.');
  await db().query(`UPDATE posts SET moderation_status = 'review' WHERE id = $1`, [posts.bolaHeld]);
  await yap(bola, 'bolaYap', 'Bola says the new bus line starts on Monday.');
  await yap(bola, 'bolaYapHeld', 'Bola said something the checks held.', true);
  await say(carl, 'carl', 'Carl shared his holiday plans.');
  await say(dan, 'dan', 'Dan wrote to his approved followers.');
  await say(gus, 'gus', 'Gus posted a long thread about football.');
  await say(kid, 'kid', 'Kid posted about the school play.');
  await say(sam, 'squad', 'Sam is cooking for the squad on Friday.');
  await db().query(`UPDATE posts SET visibility = 'squad', squad_id = $2 WHERE id = $1`, [posts.squad, mine]);
  await say(zed, 'otherSquad', 'Zed told another squad a secret.');
  await db().query(`UPDATE posts SET visibility = 'squad', squad_id = $2 WHERE id = $1`, [posts.otherSquad, theirs]);
  await say(cora, 'cora', 'Cora says the river walk reopened today.');
  await say(priv, 'priv', 'Priv wrote about the river too.');
  await say(teen, 'teen', 'Teen wrote about the city fair.');
  await as(t.app, ada).post(`/v1/users/${carl.id}/block`);

  // It's 2 in the afternoon for Ada, and her Today is due from 5.
  expect((await settle(ada, { timezone: zoneAt(14), hour: 5 })).status).toBe(200);
});

afterAll(async () => {
  await t.app.close();
});

describe('Yapilapi Today', () => {
  it('is written only from what the listener can see, cites its sources and is read aloud', async () => {
    const r = await today(ada);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body.today;
    expect(b).toBeTruthy();
    expect(b.lang).toBe('en');

    const people = model.calls.filter((c) => c.part === 'people' && c.prompt.includes(`@${bola.username}`)).at(-1)!;
    expect(people.prompt).toContain('Bola opened a bakery');
    expect(people.prompt).toContain('new bus line'); // a Yap, through its transcript
    expect(people.prompt).toContain('Sam is cooking for the squad'); // Ada's squad
    for (const left of ['waiting for review', 'the checks held', 'Carl shared', 'Dan wrote', 'Gus posted', 'Kid posted', 'Zed told'])
      expect(people.prompt).not.toContain(left);

    const city = model.calls.filter((c) => c.part === 'city').at(-1)!;
    expect(city.prompt).toContain('river walk reopened');
    for (const left of ['Priv wrote', 'Teen wrote', 'Bola opened']) expect(city.prompt).not.toContain(left);

    const kinds = b.segments.map((s: any) => s.kind);
    expect(kinds).toContain('people');
    expect(kinds).toContain('city');
    for (const s of b.segments) {
      expect(s.sources.length).toBeGreaterThan(0);
      expect(s.audioUrl).toMatch(/\.mp3$/);
    }
    const yapSeg = b.segments.find((s: any) => s.sources[0].postId === posts.bolaYap);
    expect(yapSeg.sources[0].voice.url).toContain(`yap-${posts.bolaYap}`);
    expect(yapSeg.sources[0].username).toBe(bola.username);
    expect(b.segments.flatMap((s: any) => s.sources.map((x: any) => x.postId))).not.toContain(posts.carl);
  });

  it('is made once a day: asking again reads the same one', async () => {
    const before = model.calls.length;
    const first = (await today(ada)).body.today;
    const again = (await today(ada)).body.today;
    expect(again.id).toBe(first.id);
    expect(model.calls.length).toBe(before);
  });

  it('shares the city part between neighbours who read the same language, filtered for each', async () => {
    const lea = await person('Lea');
    const nia = await person('Nia');
    await db().query(`UPDATE profiles SET city = $2 WHERE user_id = ANY($1::uuid[])`, [[lea.id, nia.id], CITY]);
    for (const u of [lea, nia]) await settle(u, { timezone: zoneAt(14), hour: 5 });
    await as(t.app, nia).post(`/v1/users/${cora.id}/block`);
    const cityCalls = model.calls.filter((c) => c.part === 'city').length;
    const spoken = tts.said.length;
    const forLea = (await today(lea)).body.today;
    expect(forLea.segments.map((s: any) => s.kind)).toEqual(['city']);
    expect(model.calls.filter((c) => c.part === 'city').length).toBe(cityCalls);
    expect(tts.said.length).toBe(spoken); // the clip was made for Ada's
    // Nia blocked Cora: the segment about her isn't hers to hear, and nothing else is left.
    expect((await today(nia)).body.today).toBeNull();
  });

  it('is in the listener’s language', async () => {
    const fatou = await person('Fatou', { locale: 'fr' });
    await db().query(`UPDATE profiles SET locale = 'fr' WHERE user_id = $1`, [fatou.id]);
    await followAccepted(t.app, fatou, bola);
    await settle(fatou, { timezone: zoneAt(14), hour: 5, city: false });
    const b = (await today(fatou)).body.today;
    expect(b.lang).toBe('fr');
    expect(model.calls.at(-1)!.lang).toBe('fr');
    expect(b.segments[0].text).toMatch(/^À propos de/);
    expect(b.segments.every((s: any) => s.kind === 'people')).toBe(true);
  });

  it('drops a segment when one of its sources can no longer be seen', async () => {
    const vic = await person('Vic');
    await followAccepted(t.app, vic, bola);
    await settle(vic, { timezone: zoneAt(14), hour: 5, city: false });
    const before = (await today(vic)).body.today;
    expect(before.segments.some((s: any) => s.sources[0].postId === posts.bola)).toBe(true);
    await as(t.app, vic).post(`/v1/users/${bola.id}/block`);
    expect((await today(vic)).body.today).toBeNull();
  });

  it('"Not interested in this" takes the segment away and keeps its people out of the next ones', async () => {
    const b = (await today(ada)).body.today;
    const seg = b.segments.find((s: any) => s.sources[0].postId === posts.bola);
    const r = await as(t.app, ada).post(`/v1/today/${b.id}/segments/${seg.index}/not-interested`);
    expect(r.status).toBe(200);
    expect(r.body.today.segments.map((s: any) => s.index)).not.toContain(seg.index);
    // Only that segment: the one about Bola's Yap stays in this one.
    expect(r.body.today.segments.some((s: any) => s.sources[0].postId === posts.bolaYap)).toBe(true);
    expect((await as(t.app, bola).post(`/v1/today/${b.id}/segments/0/not-interested`)).status).toBe(404);
    // Tomorrow's: nothing from Bola, Sam's squad post still there.
    await forget(ada);
    await today(ada);
    const next = peopleCalls(sam).at(-1)!;
    expect(next.prompt).not.toContain(`@${bola.username}`);
    expect(next.prompt).toContain('Sam is cooking');
  });

  it('belongs to its owner only', async () => {
    const b = (await today(ada)).body.today;
    expect((await as(t.app, bola).get(`/v1/today/${b.id}`)).status).toBe(404);
    expect((await as(t.app, ada).get(`/v1/today/${b.id}`)).body.today.id).toBe(b.id);
    expect((await as(t.app, bola).post(`/v1/today/${b.id}/dismiss`)).status).toBe(404);
  });

  it('waits for the chosen hour, and Hide puts it away until tomorrow', async () => {
    const ola = await person('Ola');
    await followAccepted(t.app, ola, bola);
    await settle(ola, { timezone: zoneAt(6), hour: 9 });
    expect((await today(ola)).body.today).toBeNull();
    expect((await db().query(`SELECT 1 FROM today_briefings WHERE user_id = $1`, [ola.id])).rowCount).toBe(0);
    await settle(ola, { hour: 5 });
    const b = (await today(ola)).body.today;
    expect(b).toBeTruthy();
    expect((await as(t.app, ola).post(`/v1/today/${b.id}/dismiss`)).status).toBe(200);
    expect((await today(ola)).body.today).toBeNull();
  });

  it('is made in the morning for people active this week, and lazily for the others', async () => {
    const pia = await person('Pia');
    const quo = await person('Quo');
    for (const u of [pia, quo]) {
      await followAccepted(t.app, u, bola);
      await settle(u, { timezone: zoneAt(9), hour: 7, city: false });
    }
    await settle(pia, { notify: true });
    await db().query(`UPDATE sessions SET last_seen_at = now() - interval '10 days' WHERE user_id = $1`, [quo.id]);
    expect(await sweepToday(deps(), { userIds: [pia.id, quo.id] })).toBe(1);
    const notes = await db().query(`SELECT type, entity_type FROM notifications WHERE user_id = $1 AND type = 'today_ready'`, [pia.id]);
    expect(notes.rows).toEqual([{ type: 'today_ready', entity_type: 'today' }]);
    expect((await db().query(`SELECT 1 FROM today_briefings WHERE user_id = $1`, [quo.id])).rowCount).toBe(0);
    // Quo opens the app: made now. No notification by default.
    expect((await today(quo)).body.today).toBeTruthy();
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'today_ready'`, [quo.id])).rowCount).toBe(0);
    // Not again the same day.
    expect(await sweepToday(deps(), { userIds: [pia.id, quo.id] })).toBe(0);
  });

  it('can be turned off, and then nothing is made', async () => {
    const rex = await person('Rex');
    await followAccepted(t.app, rex, bola);
    const s = await settle(rex, { enabled: false, timezone: zoneAt(9) });
    expect(s.body.settings).toMatchObject({ enabled: false, hour: 7, city: true, notify: false });
    expect((await today(rex)).body.today).toBeNull();
    expect(await sweepToday(deps(), { userIds: [rex.id] })).toBe(0);
    expect((await settle(rex, { hour: 4 })).status).toBe(400);
    expect((await settle(rex, { timezone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('stays within its budgets: text only past the reading budget, nothing past the writing one', async () => {
    const cfg = t.ctx.config as { TODAY_DAILY_LIMIT: number; TODAY_TTS_DAILY_CHAR_LIMIT: number };
    const [calls, chars] = [cfg.TODAY_DAILY_LIMIT, cfg.TODAY_TTS_DAILY_CHAR_LIMIT];
    try {
      const sid = await person('Sid');
      await followAccepted(t.app, sid, bola);
      await settle(sid, { timezone: zoneAt(14), hour: 5, city: false });
      cfg.TODAY_TTS_DAILY_CHAR_LIMIT = 0;
      const b = (await today(sid)).body.today;
      expect(b.segments.length).toBeGreaterThan(0);
      expect(b.segments.every((s: any) => s.audioUrl === null)).toBe(true);
      expect(b.segments.find((s: any) => s.sources[0].postId === posts.bolaYap).sources[0].voice).toBeTruthy();

      const tia = await person('Tia');
      await followAccepted(t.app, tia, bola);
      await settle(tia, { timezone: zoneAt(14), hour: 5, city: false });
      cfg.TODAY_DAILY_LIMIT = 0;
      expect((await today(tia)).body.today).toBeNull();
      expect((await db().query(`SELECT 1 FROM today_briefings WHERE user_id = $1`, [tia.id])).rowCount).toBe(0);
    } finally {
      cfg.TODAY_DAILY_LIMIT = calls;
      cfg.TODAY_TTS_DAILY_CHAR_LIMIT = chars;
    }
  });

  it('is text with the original Yaps when listening isn’t set up', async () => {
    const speech = t.ctx.speech;
    t.ctx.speech = null;
    try {
      const una = await person('Una');
      await followAccepted(t.app, una, bola);
      await settle(una, { timezone: zoneAt(14), hour: 5, city: false });
      const b = (await today(una)).body.today;
      expect(b.segments.every((s: any) => s.audioUrl === null)).toBe(true);
    } finally {
      t.ctx.speech = speech;
    }
  });

  it('follows the flag, and the offline stand-in never answers in production', async () => {
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('TODAY', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      expect((await today(ada)).body.today).toBeNull();
      expect((await as(t.app, null).get('/v1/flags')).body.today).toBe(false);
    } finally {
      await db().query(`DELETE FROM feature_flags WHERE key = 'TODAY'`);
    }
    expect((await as(t.app, null).get('/v1/flags')).body.today).toBe(true);
    const config = { ...t.ctx.config, APP_ENV: 'production' as const };
    expect(await todayAvailable({ db: db(), provider: devProvider(), config })).toBe(false);
    expect(await todayAvailable({ db: db(), provider: devProvider(), config: t.ctx.config })).toBe(true);
    expect(await todayAvailable({ db: db(), provider: model.provider, config })).toBe(true);
  });

  it('is in the data export', async () => {
    const r = await as(t.app, ada).get('/v1/me/export');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.ai.todayBriefings.length).toBeGreaterThan(0);
    expect(d.ai.todayNotInterested).toMatchObject([{ person: bola.username, post_id: posts.bola }]);
    expect(d.settings.preferences).toMatchObject({ today_hour: 5 });
  });

  it('logs every script in the AI audit log, without its words', async () => {
    const { rows } = await db().query(`SELECT status, context_scopes FROM ai_tool_calls WHERE user_id = $1 AND task = 'today'`, [ada.id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.flatMap((r) => r.context_scopes)).toContain('today:people');
  });
});
