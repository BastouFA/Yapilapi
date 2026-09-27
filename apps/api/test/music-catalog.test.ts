import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { licenceBlock, postMusicInputSchema, storyMusicInputSchema, type MusicLicence, type MusicTrack } from '@yapilapi/shared';
import { loadConfig } from '../src/config.ts';
import { jamendoLicence } from '../src/lib/music/jamendo.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

// ── Stubbed providers: nothing leaves the machine ─────────────────────────

/** Jamendo's answer shape (v3.0 /tracks). */
const jamendoSongs = [
  { id: '1001', name: 'Open Road', artist_name: 'Ada Lane', album_name: 'Roads', duration: 180, license_ccurl: 'http://creativecommons.org/licenses/by/4.0/' },
  { id: '1002', name: 'Quiet Harbour', artist_name: 'Bola K', duration: 200, license_ccurl: 'http://creativecommons.org/licenses/by-nc/3.0/' },
  { id: '1003', name: 'Fixed Frame', artist_name: 'Chi O', duration: 150, license_ccurl: 'http://creativecommons.org/licenses/by-nd/4.0/' },
  { id: '1004', name: 'Same Again', artist_name: 'Dee M', duration: 150, license_ccurl: 'http://creativecommons.org/licenses/by-sa/4.0/' },
].map((s) => ({ ...s, audio: `https://prod.storage.jamendo.test/?trackid=${s.id}`, album_image: `https://img.jamendo.test/${s.id}.jpg` }));

/** The licensed partner's answer shape (see lib/music/licensed.ts). */
const licensedSongs = [
  {
    id: 'L1',
    title: 'Chart Song',
    artist: 'Big Artist',
    durationMs: 200_000,
    previewUrl: 'https://cdn.partner.test/L1.m4a',
    licence: { name: 'Partner social licence', commercialUse: false, territories: null, maxClipSeconds: 15, attribution: '℗ 2026 Big Label' },
  },
  {
    id: 'L2',
    title: 'Paris Only',
    artist: 'Local Band',
    durationMs: 120_000,
    previewUrl: 'https://cdn.partner.test/L2.m4a',
    licence: { name: 'Partner social licence', commercialUse: true, territories: ['FR'], maxClipSeconds: 30 },
  },
  {
    id: 'L3',
    title: 'Soon Gone',
    artist: 'Fading Act',
    durationMs: 90_000,
    previewUrl: 'https://cdn.partner.test/L3.m4a',
    licence: { name: 'Partner social licence', commercialUse: true, territories: null, maxClipSeconds: 30 },
  },
];
const withdrawnByPartner = new Set<string>();
const calls: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  calls.push(url.toString());
  if (url.hostname === 'api.jamendo.com') {
    if (url.searchParams.get('client_id') !== 'test-jamendo') return json({ headers: { status: 'failed', error_message: 'bad client id' }, results: [] });
    let results = jamendoSongs;
    const id = url.searchParams.get('id');
    if (id) results = results.filter((s) => s.id === id);
    if (url.searchParams.get('ccnc') === 'false') results = results.filter((s) => !s.license_ccurl.includes('-nc'));
    const search = url.searchParams.get('search');
    if (search) results = results.filter((s) => `${s.name} ${s.artist_name}`.toLowerCase().includes(search.toLowerCase()));
    return json({ headers: { status: 'success', code: 0, results_count: results.length }, results });
  }
  if (url.hostname === 'licensed.test') {
    if (new Headers(init?.headers).get('authorization') !== 'Bearer test-key') return json({ error: 'unauthorized' }, 401);
    const available = licensedSongs.filter((s) => !withdrawnByPartner.has(s.id));
    const one = url.pathname.match(/^\/v1\/tracks\/(.+)$/);
    if (one) {
      const song = available.find((s) => s.id === decodeURIComponent(one[1]!));
      return song ? json({ track: song }) : json({ error: 'not found' }, 404);
    }
    const commercial = url.searchParams.get('commercial') === 'true';
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return json({
      tracks: available.filter((s) => (!commercial || s.licence.commercialUse) && (!q || `${s.title} ${s.artist}`.toLowerCase().includes(q))),
    });
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp(
    {
      JAMENDO_CLIENT_ID: 'test-jamendo',
      MUSIC_LICENSED_API_URL: 'https://licensed.test',
      MUSIC_LICENSED_API_KEY: 'test-key',
      MUSIC_LICENSED_NAME: 'Test partner',
    },
    { musicFetch: fakeFetch },
  );
});
afterAll(async () => {
  await t.close();
});

const find = (items: MusicTrack[], title: string) => items.find((i) => i.title === title);
const search = async (u: TestUser, q: string, extra = '') => {
  const r = await as(t.app, u).get(`/v1/music?q=${encodeURIComponent(q)}${extra}`);
  expect(r.status).toBe(200);
  return r.body.items as MusicTrack[];
};
/** A catalogue song's id, found by searching as `u`. */
const songId = async (u: TestUser, q: string, title: string) => {
  const hit = find(await search(u, q), title);
  expect(hit, title).toBeTruthy();
  return hit!.id;
};
const textPost = (u: TestUser, music: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  as(t.app, u).post('/v1/posts', { body: 'Listening', music, ...extra });
const setCountry = (u: TestUser, country: string | null) => t.ctx.db.query(`UPDATE profiles SET country = $2 WHERE user_id = $1`, [u.id, country]);
const setBusiness = (u: TestUser) => t.ctx.db.query(`UPDATE profiles SET mode = 'business' WHERE user_id = $1`, [u.id]);
async function makeFriends(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await t.ctx.db.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

describe('music licences', () => {
  const base: MusicLicence = {
    name: 'Test',
    url: null,
    commercialUse: false,
    regions: null,
    excludedRegions: [],
    maxClipSeconds: 15,
    attribution: 'A by B · Test',
    expiresAt: null,
    cacheAllowed: false,
  };

  it('checks business use, countries, clip length and expiry', () => {
    expect(licenceBlock(base, { commercial: false, countries: [] })).toBeNull();
    expect(licenceBlock(base, { commercial: true, countries: [] })).toBe('commercial');
    expect(licenceBlock({ ...base, commercialUse: true }, { commercial: true, countries: [] })).toBeNull();
    expect(licenceBlock(base, { commercial: false, countries: [], clipMs: 15_000 })).toBeNull();
    expect(licenceBlock(base, { commercial: false, countries: [], clipMs: 15_001 })).toBe('clip');
    const fr = { ...base, regions: ['FR'] };
    expect(licenceBlock(fr, { commercial: false, countries: ['FR'] })).toBeNull();
    expect(licenceBlock(fr, { commercial: false, countries: ['NG'] })).toBe('region');
    // Unknown country: a song limited to some countries isn't allowed.
    expect(licenceBlock(fr, { commercial: false, countries: [] })).toBe('region');
    // Every known country must be allowed (chosen and reported by the network).
    expect(licenceBlock(fr, { commercial: false, countries: ['FR', 'NG'] })).toBe('region');
    expect(licenceBlock({ ...base, excludedRegions: ['US'] }, { commercial: false, countries: ['US'] })).toBe('region');
    expect(licenceBlock({ ...base, expiresAt: '2020-01-01T00:00:00Z' }, { commercial: false, countries: [] })).toBe('expired');
  });

  it('only takes Jamendo licences that allow putting a song on a post, and credits them', () => {
    const credit = { title: 'Open Road', artist: 'Ada Lane' };
    expect(jamendoLicence('http://creativecommons.org/licenses/by/4.0/', credit)).toMatchObject({
      name: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      commercialUse: true,
      attribution: 'Open Road by Ada Lane · CC BY 4.0',
    });
    expect(jamendoLicence('http://creativecommons.org/licenses/by-nc/3.0/', credit)).toMatchObject({ name: 'CC BY-NC 3.0', commercialUse: false });
    expect(jamendoLicence('http://creativecommons.org/licenses/by-nd/4.0/', credit)).toBeNull();
    expect(jamendoLicence('http://creativecommons.org/licenses/by-nc-nd/3.0/', credit)).toBeNull();
    expect(jamendoLicence('http://creativecommons.org/licenses/by-sa/4.0/', credit)).toBeNull();
    expect(jamendoLicence(undefined, credit)).toBeNull();
  });

  it('validates the part: 5 to 30 seconds on posts, 15 on stories, a sound or a song', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(postMusicInputSchema.parse({ trackId: id, startMs: 0 })).toMatchObject({ durationMs: 15_000, style: 'compact' });
    expect(postMusicInputSchema.safeParse({ trackId: id, startMs: 0, durationMs: 30_001 }).success).toBe(false);
    expect(postMusicInputSchema.safeParse({ trackId: id, startMs: 0, durationMs: 4_999 }).success).toBe(false);
    expect(postMusicInputSchema.safeParse({ startMs: 0 }).success).toBe(false);
    expect(postMusicInputSchema.safeParse({ trackId: id, soundId: id, startMs: 0 }).success).toBe(false);
    expect(storyMusicInputSchema.safeParse({ trackId: id, startMs: 0, durationMs: 20_000 }).success).toBe(false);
    expect(storyMusicInputSchema.safeParse({ trackId: id, startMs: 0 }).success).toBe(true);
  });
});

describe('music providers', () => {
  it('are off without credentials, and never called', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const off = await testApp();
    try {
      const u = await signUp(off.app);
      const sources = (await as(off.app, u).get('/v1/music/sources')).body.items;
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'library', enabled: true }),
          expect.objectContaining({ id: 'jamendo', enabled: false }),
          expect.objectContaining({ id: 'licensed', enabled: false }),
          expect.objectContaining({ id: 'dev', enabled: true }),
        ]),
      );
      const items = (await as(off.app, u).get('/v1/music?q=road')).body.items as MusicTrack[];
      expect(items.filter((i) => i.source === 'jamendo' || i.source === 'licensed')).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await off.close();
    }
    // The dev tones can be switched off, and a licensed catalogue needs both its address and key.
    const env = { ...process.env, APP_ENV: 'test', DATABASE_URL: 'postgres://x/y' };
    expect(loadConfig({ ...env, MUSIC_DEV_PROVIDER: 'false' }).MUSIC_DEV_PROVIDER).toBe(false);
    expect(() => loadConfig({ ...env, MUSIC_LICENSED_API_URL: 'https://licensed.test' })).toThrow(/MUSIC_LICENSED_API_KEY/);
  });

  it('lists the sources that are on, and searches all of them with licence and credit', async () => {
    const u = await signUp(t.app);
    const sources = (await as(t.app, u).get('/v1/music/sources')).body.items;
    expect(sources.map((s: { id: string; enabled: boolean }) => `${s.id}:${s.enabled}`)).toEqual(['library:true', 'jamendo:true', 'licensed:true', 'dev:true']);
    expect(sources.find((s: { id: string }) => s.id === 'licensed').label).toBe('Test partner');

    const found = await search(u, 'o');
    const road = find(found, 'Open Road')!;
    expect(road).toMatchObject({
      source: 'jamendo',
      artist: 'Ada Lane',
      canUse: true,
      attribution: 'Open Road by Ada Lane · CC BY 4.0',
      licence: expect.objectContaining({ name: 'CC BY 4.0', commercialUse: true }),
      previewUrl: 'https://prod.storage.jamendo.test/?trackid=1001',
      maxClipMs: 30_000,
    });
    // Personal accounts get non-commercial songs; no derivatives and share alike are never offered.
    expect(find(found, 'Quiet Harbour')?.licence.commercialUse).toBe(false);
    expect(find(found, 'Fixed Frame')).toBeUndefined();
    expect(find(found, 'Same Again')).toBeUndefined();
    // The partner's credit, and its clip limit.
    expect(find(await search(u, 'chart'), 'Chart Song')).toMatchObject({ source: 'licensed', attribution: '℗ 2026 Big Label', maxClipMs: 15_000 });
    // The dev tones are marked as such.
    expect(find(await search(u, 'morning'), '[Dev data] Morning tone')).toMatchObject({ source: 'dev', canUse: true });
    // Every song carries its licence and a credit line.
    for (const s of found) {
      expect(s.licence.name).toBeTruthy();
      expect(s.attribution).toContain(s.source === 'licensed' ? '' : s.title);
    }
    // A source on its own, and the tabs.
    expect((await search(u, 'o', '&source=jamendo')).every((s) => s.source === 'jamendo')).toBe(true);
    expect((await as(t.app, u).get('/v1/music?tab=trending')).body.items.length).toBeGreaterThan(0);
    expect((await as(t.app, u).get('/v1/music?tab=for_you')).body.items.length).toBeGreaterThan(0);
  });

  it('caches metadata instead of asking providers again', async () => {
    const u = await signUp(t.app);
    await search(u, 'harbour');
    const before = calls.length;
    await search(u, 'harbour');
    await search(u, 'harbour');
    expect(calls.length).toBe(before);
  });
});

describe('music: business accounts, countries and clip length', () => {
  it('gives business accounts only songs cleared for commercial use', async () => {
    const shop = await signUp(t.app);
    await setBusiness(shop);
    const found = await search(shop, 'o');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => s.licence.commercialUse)).toBe(true);
    expect(find(found, 'Quiet Harbour')).toBeUndefined();
    expect(find(await search(shop, 'evening'), '[Dev data] Evening tone')).toBeUndefined();

    // A personal account found it; a business account can't post with it.
    const person = await signUp(t.app);
    const nc = await songId(person, 'harbour', 'Quiet Harbour');
    const refused = await textPost(shop, { trackId: nc, startMs: 0 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('music_not_allowed');
    expect(refused.body.error.message).toMatch(/business accounts/);
    expect((await textPost(person, { trackId: nc, startMs: 0 })).status).toBe(201);
    // Songs cleared for commercial use are fine.
    expect((await textPost(shop, { trackId: await songId(shop, 'road', 'Open Road'), startMs: 0 })).status).toBe(201);
  });

  it('checks the country at publish time and at view time', async () => {
    const author = await signUp(t.app);
    // Limited to France: not offered to someone whose country isn't known, and refused when posting.
    expect(find(await search(author, 'paris'), 'Paris Only')).toBeUndefined();
    await setCountry(author, 'FR');
    const paris = await songId(author, 'paris', 'Paris Only');
    await setCountry(author, 'NG');
    const refused = await textPost(author, { trackId: paris, startMs: 0 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/country/);
    await setCountry(author, 'FR');
    const posted = await textPost(author, { trackId: paris, startMs: 10_000, durationMs: 20_000 });
    expect(posted.status).toBe(201);
    expect(posted.body.post.music).toMatchObject({
      source: 'licensed',
      title: 'Paris Only',
      startMs: 10_000,
      durationMs: 20_000,
      audioUrl: expect.any(String),
    });

    // A viewer in Nigeria sees the post, and a quiet note instead of the music.
    const lagos = await signUp(t.app);
    await setCountry(lagos, 'NG');
    const seen = (await as(t.app, lagos).get(`/v1/posts/${posted.body.post.id}`)).body.post;
    expect(seen.body).toBe('Listening');
    expect(seen.music).toMatchObject({ title: 'Paris Only', audioUrl: null, unavailable: 'region' });
    const paris2 = await signUp(t.app);
    await setCountry(paris2, 'FR');
    expect((await as(t.app, paris2).get(`/v1/posts/${posted.body.post.id}`)).body.post.music).toMatchObject({ audioUrl: 'https://cdn.partner.test/L2.m4a' });
    // Someone signed out, with no known country, doesn't get it either.
    expect((await as(t.app, null).get(`/v1/posts/${posted.body.post.id}`)).body.post.music.unavailable).toBe('region');
  });

  it('keeps parts within the licence, and within the song', async () => {
    const u = await signUp(t.app);
    const chart = await songId(u, 'chart', 'Chart Song');
    const long = await textPost(u, { trackId: chart, startMs: 0, durationMs: 20_000 });
    expect(long.status).toBe(400);
    expect(long.body.error.details.fields['music.durationMs']).toMatch(/15 seconds/);
    expect((await textPost(u, { trackId: chart, startMs: 0, durationMs: 15_000 })).status).toBe(201);
    const short = await songId(u, 'short', '[Dev data] Short clip tone');
    expect((await textPost(u, { trackId: short, startMs: 0, durationMs: 12_000 })).status).toBe(400);
    const past = await textPost(u, { trackId: await songId(u, 'morning', '[Dev data] Morning tone'), startMs: 40_000 });
    expect(past.status).toBe(400);
    expect(past.body.error.details.fields['music.startMs']).toMatch(/40 seconds long/);
    // Near the end the part is cut to what's left.
    const end = await textPost(u, { trackId: await songId(u, 'morning', '[Dev data] Morning tone'), startMs: 35_000, durationMs: 15_000 });
    expect(end.body.post.music).toMatchObject({ startMs: 35_000, durationMs: 5_000 });
  });
});

describe('music on posts, reels and stories', () => {
  it('goes on photo and text posts, not on videos, polls or links', async () => {
    const u = await signUp(t.app);
    const tone = await songId(u, 'morning', '[Dev data] Morning tone');
    const photo = await as(t.app, u).post('/v1/posts', {
      body: 'Sunset',
      media: [{ url: 'https://example.com/a.jpg', kind: 'image' }],
      music: { trackId: tone, startMs: 5_000 },
    });
    expect(photo.status).toBe(201);
    expect(photo.body.post).toMatchObject({
      kind: 'photo',
      music: { source: 'dev', id: tone, attribution: '[Dev data] Morning tone by Dev tones · Dev licence' },
    });
    const carousel = await as(t.app, u).post('/v1/posts', {
      media: [
        { url: 'https://example.com/a.jpg', kind: 'image' },
        { url: 'https://example.com/b.jpg', kind: 'image' },
      ],
      music: { trackId: tone, startMs: 0 },
    });
    expect(carousel.body.post).toMatchObject({ kind: 'carousel', music: { id: tone } });
    const video = await as(t.app, u).post('/v1/posts', { media: [{ url: 'https://example.com/a.mp4', kind: 'video' }], music: { trackId: tone, startMs: 0 } });
    expect(video.status).toBe(400);
    const poll = await as(t.app, u).post('/v1/posts', { body: 'Which?', kind: 'poll', poll: { options: ['A', 'B'] }, music: { trackId: tone, startMs: 0 } });
    expect(poll.status).toBe(400);
    // A post without music has none.
    expect((await as(t.app, u).post('/v1/posts', { body: 'Quiet' })).body.post.music).toBeUndefined();
  });

  it('shows the music only to people who can see the post', async () => {
    const author = await signUp(t.app);
    const friend = await signUp(t.app);
    const stranger = await signUp(t.app);
    await makeFriends(author, friend);
    const tone = await songId(author, 'long', '[Dev data] Long tone');
    const p = await textPost(author, { trackId: tone, startMs: 0 }, { visibility: 'friends' });
    expect(p.status).toBe(201);
    expect((await as(t.app, friend).get(`/v1/posts/${p.body.post.id}`)).body.post.music.title).toBe('[Dev data] Long tone');
    expect((await as(t.app, stranger).get(`/v1/posts/${p.body.post.id}`)).status).toBe(404);
    // The song's page lists it for the friend only.
    const forFriend = (await as(t.app, friend).get(`/v1/music/tracks/${tone}/posts`)).body.items.map((x: { id: string }) => x.id);
    const forStranger = (await as(t.app, stranger).get(`/v1/music/tracks/${tone}/posts`)).body.items.map((x: { id: string }) => x.id);
    expect(forFriend).toContain(p.body.post.id);
    expect(forStranger).not.toContain(p.body.post.id);
  });

  it('plays a catalogue song on a reel instead of its own sound, and on a story', async () => {
    const u = await signUp(t.app);
    const tone = await songId(u, 'evening', '[Dev data] Evening tone');
    const { rows } = await t.ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',20000) RETURNING id, url`,
      [u.id],
    );
    const reel = await as(t.app, u).post('/v1/posts', {
      format: 'reel',
      media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
      music: { trackId: tone, startMs: 0, durationMs: 20_000 },
    });
    expect(reel.status).toBe(201);
    expect(reel.body.post.music).toMatchObject({ id: tone, durationMs: 20_000 });
    expect(reel.body.post.sound).toBeNull();
    // A reel can't have a sound and a song.
    expect(
      (
        await as(t.app, u).post('/v1/posts', {
          format: 'reel',
          media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
          soundId: tone,
          music: { trackId: tone, startMs: 0 },
        })
      ).status,
    ).toBe(400);

    const story = await as(t.app, u).post('/v1/moments', { body: 'Evening', visibility: 'friends', music: { trackId: tone, startMs: 2_000, style: 'card' } });
    expect(story.status).toBe(201);
    const opened = (await as(t.app, u).get(`/v1/moments/${story.body.moment.id}`)).body.group.moments[0];
    expect(opened.music).toMatchObject({
      startMs: 2_000,
      durationMs: 15_000,
      style: 'card',
      sound: { id: tone, source: 'dev', title: '[Dev data] Evening tone', attribution: expect.stringContaining('Dev licence'), audioUrl: expect.any(String) },
    });
  });

  it('counts uses across reels, posts and stories', async () => {
    const u = await signUp(t.app);
    const tone = await songId(u, 'regional', '[Dev data] Regional tone').catch(async () => null);
    // Limited to some countries: offered once the country is known.
    expect(tone).toBeNull();
    await setCountry(u, 'GH');
    const regional = await songId(u, 'regional', '[Dev data] Regional tone');
    expect((await as(t.app, u).get(`/v1/music/tracks/${regional}`)).body.track.uses).toBe(0);
    await textPost(u, { trackId: regional, startMs: 0 });
    await as(t.app, u).post('/v1/moments', { body: 'x', visibility: 'friends', music: { trackId: regional, startMs: 0 } });
    const { rows } = await t.ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',20000) RETURNING id, url`,
      [u.id],
    );
    await as(t.app, u).post('/v1/posts', {
      format: 'reel',
      media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
      music: { trackId: regional, startMs: 0 },
    });
    expect((await as(t.app, u).get(`/v1/music/tracks/${regional}`)).body.track.uses).toBe(3);

    // A sound from the library on a text post counts on the sound's page too.
    const creator = await signUp(t.app);
    const m2 = await t.ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',40000) RETURNING id, url`,
      [creator.id],
    );
    const src = await as(t.app, creator).post('/v1/posts', { format: 'reel', media: [{ id: m2.rows[0].id, url: m2.rows[0].url, kind: 'video' }] });
    const soundId = src.body.post.sound.id;
    const withSound = await textPost(u, { soundId, startMs: 0 });
    expect(withSound.status).toBe(201);
    expect(withSound.body.post.music).toMatchObject({ source: 'library', id: soundId, artist: expect.any(String) });
    const sound = (await as(t.app, u).get(`/v1/sounds/${soundId}`)).body.sound;
    expect(sound).toMatchObject({ reels: 1, posts: 1 });
    const original = (await as(t.app, u).get('/v1/music?tab=original')).body.items as MusicTrack[];
    expect(original.find((s) => s.id === soundId)).toMatchObject({ source: 'library', uses: 2, canUse: true });
  });

  it('saves songs and sounds for later', async () => {
    const u = await signUp(t.app);
    const road = await songId(u, 'road', 'Open Road');
    expect((await as(t.app, u).put(`/v1/music/tracks/${road}/save`)).status).toBe(200);
    const saved = (await as(t.app, u).get('/v1/music?tab=saved')).body.items as MusicTrack[];
    expect(saved.map((s) => s.id)).toEqual([road]);
    expect(saved[0]!.saved).toBe(true);
    await as(t.app, u).del(`/v1/music/tracks/${road}/save`);
    expect((await as(t.app, u).get('/v1/music?tab=saved')).body.items).toEqual([]);
  });
});

describe('music: withdrawn songs', () => {
  it('keeps posts, silently, with a note, and refuses new uses', async () => {
    const u = await signUp(t.app);
    const soon = await songId(u, 'soon', 'Soon Gone');
    const p = await textPost(u, { trackId: soon, startMs: 0 });
    expect(p.status).toBe(201);
    const draft = await as(t.app, u).post('/v1/posts', { body: 'Later', draft: true, music: { trackId: soon, startMs: 0 } });
    expect(draft.status).toBe(201);

    withdrawnByPartner.add('L3');
    const r = await t.ctx.music.refresh({ olderThanMs: 0 });
    expect(r.withdrawn).toBeGreaterThanOrEqual(1);

    const post = (await as(t.app, u).get(`/v1/posts/${p.body.post.id}`)).body.post;
    expect(post.body).toBe('Listening');
    expect(post.music).toMatchObject({ title: 'Soon Gone', audioUrl: null, unavailable: 'withdrawn' });
    // Not offered any more, and can't be used in a new post or when a draft goes out.
    expect(find(await search(u, 'soon'), 'Soon Gone')).toBeUndefined();
    const again = await textPost(u, { trackId: soon, startMs: 0 });
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/no longer available/);
    expect((await as(t.app, u).post(`/v1/drafts/${draft.body.post.id}/publish`)).status).toBe(422);
  });

  it('finds out at publish time too', async () => {
    const u = await signUp(t.app);
    const tone = await songId(u, 'morning', '[Dev data] Morning tone');
    const dev = t.ctx.music.provider('dev') as unknown as { withdraw(id: string): void; restore(id: string): void };
    dev.withdraw('tone-morning');
    try {
      const refused = await textPost(u, { trackId: tone, startMs: 0 });
      expect(refused.status).toBe(422);
      expect((await as(t.app, u).get(`/v1/music/tracks/${tone}`)).body.track).toMatchObject({ canUse: false, blocked: 'withdrawn', previewUrl: null });
    } finally {
      dev.restore('tone-morning');
    }
    // Back on offer: a search finds it again.
    expect(find(await search(u, 'morning'), '[Dev data] Morning tone')?.canUse).toBe(true);
  });
});

describe('dev tones', () => {
  it('serves generated audio, in byte ranges', async () => {
    const whole = await t.app.inject({ method: 'GET', url: '/v1/music/dev/tones/tone-morning.wav' });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-type']).toBe('audio/wav');
    expect(whole.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const part = await t.app.inject({ method: 'GET', url: '/v1/music/dev/tones/tone-morning.wav', headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);
    expect((await t.app.inject({ method: 'GET', url: '/v1/music/dev/tones/nope.wav' })).statusCode).toBe(404);
  });
});
