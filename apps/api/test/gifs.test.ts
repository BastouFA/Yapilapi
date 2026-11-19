import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { gifNetwork } from '../src/modules/gifs.ts';
import { as, signUp, testApp } from './helpers.ts';

let t: BuiltApp;
let off: BuiltApp;
let both: BuiltApp;
let giphyDown = false;
const asked: string[] = [];
let gif: Buffer;

/** KLIPY as it answers: a page of results, each in several sizes. */
const item = (id: number, title: string) => ({
  id,
  title,
  type: 'gif',
  file: {
    hd: { gif: { url: `https://static.klipy.com/ii/${id}/hd.gif`, width: 498, height: 498, size: 4_000_000 } },
    md: { gif: { url: `https://static.klipy.com/ii/${id}/md.gif`, width: 320, height: 320, size: 900_000 } },
    sm: { webp: { url: `https://static.klipy.com/ii/${id}/sm.webp`, width: 200, height: 200, size: 40_000 } },
  },
});

/** GIPHY as it answers: a page of results, each in several renditions. */
const giphyItem = (id: string, title: string) => ({
  id,
  title,
  images: {
    original: { url: `https://media2.giphy.com/media/${id}/giphy.gif?cid=x`, width: '480', height: '270', size: '20000000' },
    downsized_medium: { url: `https://media2.giphy.com/media/${id}/giphy-downsized-medium.gif`, width: '480', height: '270', size: '2000000' },
    fixed_width: {
      url: `https://media2.giphy.com/media/${id}/200w.gif`,
      webp: `https://media2.giphy.com/media/${id}/200w.webp`,
      width: '200',
      height: '113',
      size: '300000',
    },
  },
});

beforeAll(async () => {
  const frames = await Promise.all(
    ['#e33', '#3e3', '#33e'].map((c) =>
      sharp({ create: { width: 40, height: 30, channels: 3, background: c } })
        .png()
        .toBuffer(),
    ),
  );
  gif = await sharp(frames, { join: { animated: true } })
    .gif({ delay: 200, loop: 0 })
    .toBuffer();
  gifNetwork.fetch = async (url) => {
    asked.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.klipy.com') {
      const q = u.searchParams.get('q');
      const items = q === 'nothing' ? [] : [item(1, q ? `${q} one` : 'Trending one'), item(2, 'Two')];
      return Response.json({ result: true, data: { data: items, current_page: 1, per_page: 24, has_next: !q } });
    }
    if (u.hostname === 'api.giphy.com') {
      if (giphyDown) return new Response('', { status: 503 });
      const q = u.searchParams.get('q');
      return Response.json({
        data: [giphyItem('abc', q ? `${q} giphy` : 'Trending giphy')],
        pagination: { total_count: 100, count: 1, offset: Number(u.searchParams.get('offset')) },
      });
    }
    if (u.hostname.endsWith('.giphy.com')) return new Response(new Uint8Array(gif), { headers: { 'content-type': 'image/gif' } });
    if (u.hostname === 'static.klipy.com') return new Response(new Uint8Array(gif), { headers: { 'content-type': 'image/gif' } });
    throw new Error(`unexpected ${url}`);
  };
  t = await testApp({ KLIPY_API_KEY: 'test-klipy-key' });
  off = await testApp({ KLIPY_API_KEY: '', GIPHY_API_KEY: '' });
  both = await testApp({ KLIPY_API_KEY: 'test-klipy-key', GIPHY_API_KEY: 'test-giphy-key' });
});
afterAll(async () => {
  await t.close();
  await off.close();
  await both.close();
});

describe('GIFs in chats', () => {
  it('lists trending GIFs and search results from KLIPY, never saying who is asking', async () => {
    const u = await signUp(t.app);
    const trending = await as(t.app, u).get('/v1/gifs');
    expect(trending.status).toBe(200);
    expect(trending.body).toMatchObject({ enabled: true, next: 2 });
    expect(trending.body.items[0]).toEqual({
      id: '1',
      title: 'Trending one',
      preview: { url: 'https://static.klipy.com/ii/1/sm.webp', width: 200, height: 200 },
      url: 'https://static.klipy.com/ii/1/md.gif',
    });
    const found = await as(t.app, u).get('/v1/gifs?q=dance');
    expect(found.body.items[0].title).toBe('dance one');
    expect(found.body.next).toBeNull();
    const call = new URL(asked.find((a) => a.includes('/gifs/search'))!);
    expect(call.pathname).toBe('/api/v1/test-klipy-key/gifs/search');
    expect(call.searchParams.get('content_filter')).toBe('medium');
    // A stand-in for the person, the same each time, never their id.
    expect(call.searchParams.get('customer_id')).toMatch(/^[0-9a-f]{32}$/);
    expect(asked.join(' ')).not.toContain(u.id);
    // The same search again comes from what we kept.
    const before = asked.length;
    await as(t.app, u).get('/v1/gifs?q=dance');
    expect(asked.length).toBe(before);
    expect((await as(t.app, u).get('/v1/gifs?q=nothing')).body.items).toEqual([]);
  });

  it('gives under-18s the strictest filter', async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-01-01` });
    await as(t.app, teen).get('/v1/gifs?q=cats');
    expect(new URL(asked.filter((a) => a.includes('q=cats')).at(-1)!).searchParams.get('content_filter')).toBe('high');
  });

  it('sends a GIF as a photo of your own that stays animated, and fetches only from KLIPY', async () => {
    const a = await signUp(t.app);
    const sent = await as(t.app, a).post('/v1/gifs/send', { url: 'https://static.klipy.com/ii/1/md.gif', title: 'Dance' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.media).toMatchObject({ kind: 'image', altText: 'Dance' });
    const { rows } = await t.ctx.db.query(`SELECT owner_id, mime FROM media WHERE id = $1`, [sent.body.media.id]);
    expect(rows[0]).toEqual({ owner_id: a.id, mime: 'image/gif' });
    for (const url of [
      'https://evil.example/x.gif',
      'http://static.klipy.com/ii/1/md.gif',
      'https://static.klipy.com.evil.example/x.gif',
      'https://127.0.0.1/x.gif',
    ]) {
      const r = await as(t.app, a).post('/v1/gifs/send', { url });
      expect(r.status, url).toBe(400);
    }
  });

  it('is off without a KLIPY key', async () => {
    const u = await signUp(off.app);
    expect((await as(off.app, u).get('/v1/gifs')).body).toEqual({ enabled: false, items: [], next: null });
    expect((await as(off.app, u).post('/v1/gifs/send', { url: 'https://static.klipy.com/ii/1/md.gif' })).status).toBe(404);
    expect((await off.app.inject({ method: 'GET', url: '/v1/gifs' })).statusCode).toBe(401);
  });

  it('searches GIPHY first when it has a key, says so, and falls back to KLIPY when GIPHY fails', async () => {
    const u = await signUp(both.app);
    const r = await as(both.app, u).get('/v1/gifs?q=wave');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, provider: 'giphy', next: 2 });
    expect(r.body.items[0]).toEqual({
      id: 'abc',
      title: 'wave giphy',
      preview: { url: 'https://media2.giphy.com/media/abc/200w.webp', width: 200, height: 113 },
      url: 'https://media2.giphy.com/media/abc/giphy-downsized-medium.gif',
    });
    const call = new URL(asked.filter((a) => a.includes('api.giphy.com')).at(-1)!);
    expect(call.pathname).toBe('/v1/gifs/search');
    expect(call.searchParams.get('rating')).toBe('pg-13');
    expect(asked.join(' ')).not.toContain(u.id);
    const teen = await signUp(both.app, { birthDate: `${new Date().getFullYear() - 15}-01-01` });
    await as(both.app, teen).get('/v1/gifs?q=wave');
    expect(new URL(asked.filter((a) => a.includes('api.giphy.com')).at(-1)!).searchParams.get('rating')).toBe('g');

    const sent = await as(both.app, u).post('/v1/gifs/send', { url: r.body.items[0].url, title: 'Wave' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await as(both.app, u).post('/v1/gifs/send', { url: 'https://media2.giphy.com.evil.example/x.gif' })).status).toBe(400);
    // GIPHY files aren't fetched when only KLIPY is on.
    expect((await as(t.app, u).post('/v1/gifs/send', { url: r.body.items[0].url })).status).not.toBe(201);

    giphyDown = true;
    const fallback = await as(both.app, u).get('/v1/gifs?q=fallback');
    giphyDown = false;
    expect(fallback.body).toMatchObject({ enabled: true, provider: 'klipy' });
    expect(fallback.body.items[0].title).toBe('fallback one');
  });
});
