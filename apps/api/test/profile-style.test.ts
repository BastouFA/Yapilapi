import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { fetchLinkIcon, refreshLinkIcons, sniffIcon } from '../src/lib/link-icons.ts';
import { isPrivateIp } from '../src/lib/webhooks.ts';
import type { MusicTrack } from '@yapilapi/shared';

let t: BuiltApp;

beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const profileOf = async (viewer: TestUser | null, u: TestUser) => {
  const r = await as(t.app, viewer).get(`/v1/users/${u.username}`);
  expect(r.status).toBe(200);
  return r.body.profile;
};
const patch = (u: TestUser, body: Record<string, unknown>) => as(t.app, u).patch('/v1/me/profile', body);
const newPost = async (u: TestUser, extra: Record<string, unknown> = {}) => {
  const r = await as(t.app, u).post('/v1/posts', { body: 'Hello there', ...extra });
  expect(r.status).toBe(201);
  return r.body.post.id as string;
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const publicDns = async () => ['93.184.216.34'];

describe('profile style, pronouns and about', () => {
  it('has defaults, saves the choices and shows them to visitors', async () => {
    const ada = await adult();
    const bola = await adult();
    const before = await profileOf(bola, ada);
    expect(before).toMatchObject({
      style: { accent: 'yapi', header: 'cover' },
      pronouns: null,
      city: null,
      tabs: ['posts', 'reels', 'reposts', 'tagged', 'boards', 'chapters', 'shop'],
      featured: [],
      song: null,
    });
    expect(Date.parse(before.joinedAt)).toBeGreaterThan(Date.now() - 60_000);

    const saved = await patch(ada, { accent: 'teal', headerStyle: 'gradient', pronouns: ' she/her ', city: 'Lagos', tabs: ['reels', 'posts', 'shop'] });
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toMatchObject({ style: { accent: 'teal', header: 'gradient' }, pronouns: 'she/her', city: 'Lagos' });
    expect(await profileOf(bola, ada)).toMatchObject({
      style: { accent: 'teal', header: 'gradient' },
      pronouns: 'she/her',
      city: 'Lagos',
      tabs: ['reels', 'posts', 'shop'],
    });
    // Blank clears.
    expect((await patch(ada, { pronouns: '', city: null })).body.profile).toMatchObject({ pronouns: null, city: null });
  });

  it('refuses colours outside the palette, bad tab lists and long or multi-line text', async () => {
    const ada = await adult();
    for (const body of [
      { accent: '#ff00ff' },
      { headerStyle: 'video' },
      { tabs: [] },
      { tabs: ['posts', 'posts'] },
      { tabs: ['stories'] },
      { pronouns: 'x'.repeat(31) },
      { pronouns: 'a\nb' },
      { city: 'x'.repeat(61) },
      { city: 'www.example.com' },
    ]) {
      const r = await patch(ada, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      await db()
        .query(`SELECT accent, tabs, pronouns FROM profiles WHERE user_id = $1`, [ada.id])
        .then((r) => r.rows[0]),
    ).toEqual({
      accent: null,
      tabs: null,
      pronouns: null,
    });
  });

  it("never shows an under-18's city to anyone else", async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
    const friend = await adult();
    await patch(teen, { city: 'Accra' });
    expect((await profileOf(teen, teen)).city).toBe('Accra');
    expect((await profileOf(friend, teen)).city).toBeNull();
  });

  it('leaves the extras out for people without an account looking at a private profile', async () => {
    const ada = await adult();
    const post = await newPost(ada);
    await patch(ada, {
      pronouns: 'they/them',
      city: 'Nairobi',
      featuredPostIds: [post],
      links: [{ label: 'Site', url: 'https://example.com' }],
      isPrivate: true,
    });
    const p = await profileOf(null, ada);
    expect(p).toMatchObject({ pronouns: null, city: null, featured: [], song: null, links: [] });
  });
});

describe('profile links', () => {
  it('takes up to 5 web links with titles and refuses other schemes', async () => {
    const ada = await adult();
    const link = (url: string, label = 'My site') => ({ label, url });
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'https://user:pw@example.com', 'https://localhost/x', 'example.com'])
      expect((await patch(ada, { links: [link(url)] })).status, url).toBe(400);
    expect((await patch(ada, { links: [link('https://example.com', '')] })).status).toBe(400);
    expect((await patch(ada, { links: [link('https://example.com', 'x'.repeat(41))] })).status).toBe(400);
    expect((await patch(ada, { links: Array.from({ length: 6 }, (_, i) => link(`https://example${i}.com`)) })).status).toBe(400);

    const ok = await patch(ada, { links: Array.from({ length: 5 }, (_, i) => link(`https://site${i}.example.com/a`, `Site ${i}`)) });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.links).toHaveLength(5);
    expect(ok.body.profile.links[0]).toEqual({ label: 'Site 0', url: 'https://site0.example.com/a', iconUrl: null });
    // Icons are fetched by the job worker, never during the request.
    const job = await db().query(`SELECT payload FROM jobs WHERE kind = 'profile.link_icons' ORDER BY created_at DESC LIMIT 1`);
    expect(job.rows[0].payload.hosts).toContain('site0.example.com');
  });

  it('fetches site icons safely: public https hosts only, small images recognised by their bytes', async () => {
    const calls: string[] = [];
    const fake = (routes: Record<string, () => Response>): typeof fetch =>
      (async (url: string | URL) => {
        calls.push(String(url));
        const r = routes[String(url)];
        return r ? r() : new Response('nope', { status: 404 });
      }) as typeof fetch;

    // A PNG from a public host is kept.
    expect(
      await fetchLinkIcon('good.example', { fetchImpl: fake({ 'https://good.example/favicon.ico': () => new Response(PNG) }), resolve: publicDns }),
    ).toMatchObject({
      mime: 'image/png',
    });
    // SVG (can carry script) and HTML are refused, whatever the site says they are.
    expect(
      await fetchLinkIcon('svg.example', {
        fetchImpl: fake({ 'https://svg.example/favicon.ico': () => new Response(SVG, { headers: { 'content-type': 'image/png' } }) }),
        resolve: publicDns,
      }),
    ).toBeNull();
    // Too big.
    expect(
      await fetchLinkIcon('big.example', {
        fetchImpl: fake({ 'https://big.example/favicon.ico': () => new Response(new Uint8Array(40_000).fill(0x89)) }),
        resolve: publicDns,
      }),
    ).toBeNull();
    // A host that resolves to a private address is never contacted.
    calls.length = 0;
    expect(await fetchLinkIcon('internal.example', { fetchImpl: fake({}), resolve: async () => ['10.0.0.5'] })).toBeNull();
    expect(await fetchLinkIcon('meta.example', { fetchImpl: fake({}), resolve: async () => ['169.254.169.254'] })).toBeNull();
    expect(calls).toEqual([]);
    // A redirect is checked again: one to a private address is not followed.
    const hop = fake({
      'https://hop.example/favicon.ico': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/favicon.ico' } }),
    });
    expect(await fetchLinkIcon('hop.example', { fetchImpl: hop, resolve: publicDns })).toBeNull();
    expect(calls).toEqual(['https://hop.example/favicon.ico']);

    expect(sniffIcon(Uint8Array.from([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon');
    expect(isPrivateIp('::ffff:172.16.0.1')).toBe(true);
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });

  it('shows the icon on the profile and serves it with a safe type, or a generic icon when there is none', async () => {
    const ada = await adult();
    const bola = await adult();
    await patch(ada, {
      links: [
        { label: 'Shop', url: 'https://shop.icons.example/items' },
        { label: 'Blog', url: 'https://blog.icons.example' },
      ],
    });
    await refreshLinkIcons(db(), ['shop.icons.example', 'blog.icons.example'], {
      resolve: publicDns,
      fetchImpl: (async (url: string | URL) =>
        String(url).startsWith('https://shop.')
          ? new Response(PNG)
          : new Response('<html></html>', { headers: { 'content-type': 'image/x-icon' } })) as typeof fetch,
    });
    const links = (await profileOf(bola, ada)).links;
    expect(links[0].iconUrl).toMatch(/\/v1\/link-icons\/shop\.icons\.example$/);
    expect(links[1].iconUrl).toBeNull();

    const res = await t.app.inject({ method: 'GET', url: '/v1/link-icons/shop.icons.example' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await t.app.inject({ method: 'GET', url: '/v1/link-icons/blog.icons.example' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/v1/link-icons/..%2Fetc' })).statusCode).toBe(400);
  });
});

describe('featured posts', () => {
  it('only takes your own published posts that people can see, up to 3, in your order', async () => {
    const ada = await adult();
    const bola = await adult();
    const [a, b, c, d] = [await newPost(ada), await newPost(ada), await newPost(ada), await newPost(ada)];
    const onlyMe = await newPost(ada, { visibility: 'private' });
    const theirs = await newPost(bola);
    const gone = await newPost(ada);
    await as(t.app, ada).del(`/v1/posts/${gone}`);
    const held = await newPost(ada);
    await db().query(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [held]);

    for (const ids of [[theirs], [onlyMe], [gone], [held], ['00000000-0000-4000-8000-000000000000']]) {
      const r = await patch(ada, { featuredPostIds: ids });
      expect(r.status, ids.join()).toBe(400);
      expect(r.body.error.details.fields.featuredPostIds).toBeTruthy();
    }
    expect((await patch(ada, { featuredPostIds: [a, b, c, d] })).status).toBe(400);

    const ok = await patch(ada, { featuredPostIds: [c, a] });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.featured.map((p: { id: string }) => p.id)).toEqual([c, a]);
    expect((await profileOf(bola, ada)).featured.map((p: { id: string }) => p.id)).toEqual([c, a]);

    // Deleted later: it drops off.
    await as(t.app, ada).del(`/v1/posts/${c}`);
    expect((await profileOf(bola, ada)).featured.map((p: { id: string }) => p.id)).toEqual([a]);
  });

  it('shows each visitor only the featured posts they may see', async () => {
    const ada = await adult();
    const friend = await adult();
    const stranger = await adult();
    const everyone = await newPost(ada);
    const friendsOnly = await newPost(ada, { visibility: 'friends' });
    const [x, y] = [ada.id, friend.id].sort();
    await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2)`, [x, y]);
    expect((await patch(ada, { featuredPostIds: [friendsOnly, everyone] })).status).toBe(200);
    expect((await profileOf(friend, ada)).featured.map((p: { id: string }) => p.id)).toEqual([friendsOnly, everyone]);
    expect((await profileOf(stranger, ada)).featured.map((p: { id: string }) => p.id)).toEqual([everyone]);
    // Blocking takes them away too.
    await as(t.app, ada).post(`/v1/users/${stranger.id}/block`);
    expect((await as(t.app, stranger).get(`/v1/users/${ada.username}`)).status).toBe(404);
  });

  it('lists only reels for the Reels tab', async () => {
    const ada = await adult();
    const post = await newPost(ada);
    const reel = await newPost(ada);
    await db().query(`UPDATE posts SET format = 'reel' WHERE id = $1`, [reel]);
    const r = await as(t.app, null).get(`/v1/users/${ada.username}/posts?format=reel`);
    expect(r.body.items.map((p: { id: string }) => p.id)).toEqual([reel]);
    const all = await as(t.app, null).get(`/v1/users/${ada.username}/posts`);
    expect(all.body.items.map((p: { id: string }) => p.id).sort()).toEqual([post, reel].sort());
  });
});

describe('profile song', () => {
  const songId = async (u: TestUser, q: string, title: string) => {
    const r = await as(t.app, u).get(`/v1/music?q=${encodeURIComponent(q)}`);
    const hit = (r.body.items as MusicTrack[]).find((i) => i.title === title);
    expect(hit, title).toBeTruthy();
    return hit!.id;
  };

  it('checks the licence like music on a post, and never plays where it may not', async () => {
    const ada = await adult();
    const paris = await adult();
    await db().query(`UPDATE profiles SET country = 'FR' WHERE user_id = $1`, [paris.id]);
    // The picker only offers what you may use: found while Ada is in Nigeria…
    await db().query(`UPDATE profiles SET country = 'NG' WHERE user_id = $1`, [ada.id]);
    const regional = await songId(ada, 'regional', '[Dev data] Regional tone');
    await db().query(`UPDATE profiles SET country = NULL WHERE user_id = $1`, [ada.id]);

    // …but limited to some countries, and now we don't know Ada's: refused.
    const refused = await patch(ada, { song: { trackId: regional, startMs: 0 } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('music_not_allowed');

    await db().query(`UPDATE profiles SET country = 'NG' WHERE user_id = $1`, [ada.id]);
    const set = await patch(ada, { song: { trackId: regional, startMs: 2_000, durationMs: 20_000 } });
    expect(set.status).toBe(200);
    expect(set.body.profile.song).toMatchObject({ id: regional, source: 'dev', startMs: 2_000, durationMs: 20_000, audioUrl: expect.any(String) });

    // A visitor in a country the licence doesn't cover sees the song but it doesn't play.
    expect((await profileOf(paris, ada)).song).toMatchObject({ id: regional, audioUrl: null, unavailable: 'region' });

    // Longer than the licence allows.
    const short = await songId(ada, 'short', '[Dev data] Short clip tone');
    expect((await patch(ada, { song: { trackId: short, startMs: 0, durationMs: 15_000 } })).status).toBe(400);

    // Business accounts only get songs cleared for commercial use.
    const personal = await songId(ada, 'evening', '[Dev data] Evening tone');
    await db().query(`UPDATE profiles SET mode = 'business' WHERE user_id = $1`, [ada.id]);
    const biz = await patch(ada, { song: { trackId: personal, startMs: 0 } });
    expect(biz.status).toBe(403);
    expect(biz.body.error.code).toBe('music_not_allowed');

    // Unknown songs, and a sound and a song at once, are refused.
    expect((await patch(ada, { song: { trackId: '00000000-0000-4000-8000-000000000000', startMs: 0 } })).status).toBe(404);
    expect((await patch(ada, { song: { trackId: regional, soundId: regional, startMs: 0 } })).status).toBe(400);

    // Removed.
    expect((await patch(ada, { song: null })).body.profile.song).toBeNull();
  });

  it('goes quiet when the provider withdraws the song', async () => {
    const ada = await adult();
    const morning = await songId(ada, 'morning', '[Dev data] Morning tone');
    expect((await patch(ada, { song: { trackId: morning, startMs: 0 } })).status).toBe(200);
    await db().query(`UPDATE music_tracks SET status = 'withdrawn' WHERE id = $1`, [morning]);
    expect((await profileOf(null, ada)).song).toMatchObject({ audioUrl: null, unavailable: 'withdrawn' });
    await db().query(`UPDATE music_tracks SET status = 'active' WHERE id = $1`, [morning]);
  });
});

describe('deleting an account', () => {
  it('clears the profile style, the about details, the song, the Now status, the account type and the language', async () => {
    const ada = await adult();
    const post = await newPost(ada);
    expect(
      (await patch(ada, { accent: 'teal', headerStyle: 'gradient', pronouns: 'she/her', city: 'Lagos', tabs: ['posts', 'reels'], featuredPostIds: [post] }))
        .status,
    ).toBe(200);
    expect((await as(t.app, ada).put('/v1/me/status', { text: 'At the market' })).status).toBe(200);
    await db().query(`UPDATE profiles SET country = 'NG', pinned_post_id = $2, mode = 'creator', locale = 'fr' WHERE user_id = $1`, [ada.id, post]);

    expect((await as(t.app, ada).del('/v1/me', { password: ada.password })).status).toBe(200);

    const row = (
      await db().query(
        `SELECT accent, header_style, pronouns, city, tabs, featured_post_ids, song_sound_id, song_track_id, song_part, country, pinned_post_id, mode, locale
         FROM profiles WHERE user_id = $1`,
        [ada.id],
      )
    ).rows[0];
    expect(row).toEqual({
      accent: null,
      header_style: 'cover',
      pronouns: null,
      city: null,
      tabs: null,
      featured_post_ids: [],
      song_sound_id: null,
      song_track_id: null,
      song_part: null,
      country: null,
      pinned_post_id: null,
      // The account type and language go back to the defaults.
      mode: 'personal',
      locale: 'en',
    });
    expect((await db().query(`SELECT 1 FROM profile_statuses WHERE user_id = $1`, [ada.id])).rowCount).toBe(0);
  });
});
