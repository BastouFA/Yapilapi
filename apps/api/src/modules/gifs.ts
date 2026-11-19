import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { enqueue } from '../lib/jobs.ts';
import { readCapped } from '../lib/link-icons.ts';
import { detectMedia, toWebFormat } from '../lib/media-formats.ts';
import { safeFetch } from '../lib/safe-fetch.ts';
import { ageOf } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** KLIPY's API; its files are served from KLIPY_FILES only, the one host a KLIPY GIF is fetched from. */
const KLIPY_API = 'https://api.klipy.com/api/v1';
const KLIPY_FILES = 'static.klipy.com';
/** GIPHY's API, and the hosts its GIFs are served from (the only ones a GIPHY GIF is fetched from). */
const GIPHY_API = 'https://api.giphy.com/v1/gifs';
const GIPHY_FILES = new Set([
  'i.giphy.com',
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
]);
/** A GIF bigger than this isn't sent (a chat's GIFs are a few hundred KB to a few MB). */
export const GIF_MAX_BYTES = 15 * 1024 * 1024;
const PER_PAGE = 24;
/** The same search (and the trending list) is asked of KLIPY at most once in this long. */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 300;
const TIMEOUT_MS = 10_000;

/** How the API reaches KLIPY and GIPHY; tests put a stand-in here. */
export const gifNetwork: { fetch: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response> } = {
  fetch: (url, init) => safeFetch(url, init),
};

export interface Gif {
  id: string;
  title: string;
  /** A small moving picture for the grid. */
  preview: { url: string; width: number; height: number };
  /** The GIF that's sent (POST /v1/gifs/send). */
  url: string;
}

type KlipyFile = { url?: string; width?: number; height?: number; size?: number };
type KlipySizes = Partial<Record<'gif' | 'webp' | 'jpg' | 'mp4' | 'webm', KlipyFile>>;
type KlipyItem = { id?: number | string; title?: string; type?: string; file?: Partial<Record<'hd' | 'md' | 'sm' | 'xs', KlipySizes>> };

export type GifProvider = 'giphy' | 'klipy';

/** The URL when it's an https file on one of `provider`'s file hosts, else null. */
const fileOf = (provider: GifProvider, u: string | undefined) => {
  if (!u) return null;
  try {
    const url = new URL(u);
    const ours = provider === 'klipy' ? url.hostname === KLIPY_FILES : GIPHY_FILES.has(url.hostname);
    return url.protocol === 'https:' && ours ? url.toString() : null;
  } catch {
    return null;
  }
};
const fromKlipy = (u: string | undefined) => fileOf('klipy', u);
const fromGiphy = (u: string | undefined) => fileOf('giphy', u);

type GiphyImage = { url?: string; webp?: string; width?: string | number; height?: string | number; size?: string | number };
type GiphyItem = {
  id?: string;
  title?: string;
  images?: Partial<Record<'original' | 'downsized' | 'downsized_medium' | 'fixed_width' | 'fixed_width_downsampled', GiphyImage>>;
};

/** One GIPHY result as the app shows it, or null when it has no GIF we can send. */
function giphyToGif(item: GiphyItem): Gif | null {
  const im = item.images ?? {};
  const send = [im.downsized_medium, im.original, im.downsized].find((x) => fromGiphy(x?.url) && Number(x?.size ?? 0) <= GIF_MAX_BYTES);
  const small = [im.fixed_width, im.fixed_width_downsampled].find((x) => fromGiphy(x?.webp) || fromGiphy(x?.url));
  if (!send?.url || !small || !item.id) return null;
  return {
    id: String(item.id),
    title: String(item.title ?? '').slice(0, 200),
    preview: { url: fromGiphy(small.webp) ?? small.url!, width: Number(small.width) || 200, height: Number(small.height) || 200 },
    url: send.url,
  };
}

/** One result as the app shows it, or null when it has no GIF we can send. */
function toGif(item: KlipyItem): Gif | null {
  const f = item.file ?? {};
  const send = [f.md?.gif, f.hd?.gif, f.sm?.gif].find((x) => fromKlipy(x?.url) && (x?.size ?? 0) <= GIF_MAX_BYTES);
  const small = [f.sm?.webp, f.sm?.gif, f.xs?.gif, f.md?.webp, send].find((x) => fromKlipy(x?.url));
  if (!send?.url || !small?.url || item.id === undefined) return null;
  return {
    id: String(item.id),
    title: String(item.title ?? '').slice(0, 200),
    preview: { url: small.url, width: Number(small.width) || 200, height: Number(small.height) || 200 },
    url: send.url,
  };
}

/**
 * KLIPY_API_KEY=dev outside production: sample GIFs made here instead of KLIPY's, so the GIF tab
 * can be tried and tested without a key. Their previews are data URLs; sending one makes it again.
 */
const DEV_KEY = 'dev';
const DEV_COLORS = ['#e4572e', '#29335c', '#f3a712', '#a8c686', '#669bbc', '#8f2d56', '#2a9d8f', '#e9c46a'];
const devGifs = new Map<number, Buffer>();
async function devGif(i: number): Promise<Buffer> {
  const known = devGifs.get(i);
  if (known) return known;
  const base = DEV_COLORS[i % DEV_COLORS.length]!;
  const frames = await Promise.all(
    [base, '#ffffff', base].map((c, f) =>
      sharp({ create: { width: 160, height: 120 - f * 10, channels: 3, background: c } })
        .resize(160, 120, { fit: 'contain', background: '#222222' })
        .png()
        .toBuffer(),
    ),
  );
  const out = await sharp(frames, { join: { animated: true } })
    .gif({ delay: 250, loop: 0 })
    .toBuffer();
  devGifs.set(i, out);
  return out;
}
async function devPage(q: string | undefined, page: number): Promise<{ items: Gif[]; next: number | null }> {
  if (q?.toLowerCase() === 'nothing') return { items: [], next: null };
  const items = await Promise.all(
    Array.from({ length: 8 }, async (_, n) => {
      const i = (page - 1) * 8 + n;
      return {
        id: `dev-${i}`,
        title: `${q || 'Sample'} ${i + 1}`,
        preview: { url: `data:image/gif;base64,${(await devGif(i)).toString('base64')}`, width: 160, height: 120 },
        url: `https://${KLIPY_FILES}/dev-sample/${i}.gif`,
      };
    }),
  );
  return { items, next: page < 3 ? page + 1 : null };
}

const cache = new Map<string, { at: number; body: { items: Gif[]; next: number | null } }>();

const searchQuery = z.object({ q: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).max(50).optional() });
const sendBody = z.object({ url: z.string().url().max(500), title: z.string().trim().max(200).optional() });

/** One page of KLIPY's trending list or search results. */
async function klipyPage(key: string, userId: string, teen: boolean, q: string | undefined, page: number) {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(PER_PAGE),
    content_filter: teen ? 'high' : 'medium',
    format_filter: 'gif,webp',
    customer_id: createHash('sha256').update(`yapilapi-gif:${userId}`).digest('hex').slice(0, 32),
  });
  if (q) params.set('q', q);
  const res = await gifNetwork.fetch(`${KLIPY_API}/${encodeURIComponent(key)}/gifs/${q ? 'search' : 'trending'}?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`KLIPY ${res.status}`);
  const data = (await res.json()) as { data?: { data?: KlipyItem[]; has_next?: boolean } };
  return { items: (data.data?.data ?? []).map(toGif).filter((g): g is Gif => !!g), next: data.data?.has_next ? page + 1 : null };
}

/** One page of GIPHY's trending list or search results. GIPHY isn't told anything about the person. */
async function giphyPage(key: string, teen: boolean, q: string | undefined, page: number) {
  const params = new URLSearchParams({ api_key: key, limit: String(PER_PAGE), offset: String((page - 1) * PER_PAGE), rating: teen ? 'g' : 'pg-13' });
  if (q) params.set('q', q);
  const res = await gifNetwork.fetch(`${GIPHY_API}/${q ? 'search' : 'trending'}?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GIPHY ${res.status}`);
  const data = (await res.json()) as { data?: GiphyItem[]; pagination?: { total_count?: number; count?: number; offset?: number } };
  const p = data.pagination ?? {};
  const more = (p.offset ?? 0) + (p.count ?? 0) < (p.total_count ?? 0) && page < 50;
  return { items: (data.data ?? []).map(giphyToGif).filter((g): g is Gif => !!g), next: more ? page + 1 : null };
}

/**
 * GIFs in chats, from GIPHY when GIPHY_API_KEY is set, else KLIPY (and KLIPY when GIPHY fails):
 * GET /v1/gifs (trending, or a search with q) says which one with `provider`, for the search box and
 * credit they ask for. POST /v1/gifs/send fetches the chosen GIF and keeps it as the person's own
 * photo, like an upload: the chat shows it from our storage, and the people in it never load
 * anything from GIPHY or KLIPY. Only their file hosts are ever fetched. Under-18s get the strictest
 * filter. Neither is told who the person is (KLIPY gets a hash as a stand-in). Without either key,
 * `enabled` is false and there's no GIF tab.
 */
export default async function gifsModule(app: FastifyInstance, ctx: AppContext) {
  const key = ctx.config.KLIPY_API_KEY;
  const giphyKey = ctx.config.GIPHY_API_KEY;
  const dev = key === DEV_KEY && ctx.config.APP_ENV !== 'production';

  app.get('/v1/gifs', { preHandler: requireAuth, config: { rateLimit: { max: 300, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    if (!key && !giphyKey) return { enabled: false, items: [], next: null };
    const q = parse(searchQuery, req.query);
    const page = q.page ?? 1;
    const age = ageOf(u.birthDate ?? null);
    const teen = age !== null && age < 18;
    if (dev && !giphyKey) return { enabled: true, provider: 'klipy' as GifProvider, ...(await devPage(q.q, page)) };
    const providers: GifProvider[] = [...(giphyKey ? (['giphy'] as const) : []), ...(key && !dev ? (['klipy'] as const) : [])];
    for (const provider of providers) {
      const cacheKey = `${provider}|${teen ? 't' : 'a'}|${(q.q ?? '').toLowerCase()}|${page}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_MS) return { enabled: true, provider, ...hit.body };
      try {
        const body = provider === 'giphy' ? await giphyPage(giphyKey, teen, q.q, page) : await klipyPage(key, u.id, teen, q.q, page);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { at: Date.now(), body });
        return { enabled: true, provider, ...body };
      } catch (e) {
        req.log.warn({ err: (e as Error).message, provider }, 'GIF search failed');
      }
    }
    throw new AppError(502, 'gifs_unavailable', "GIFs couldn't load. Try again in a moment.");
  });

  app.post('/v1/gifs/send', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    if (!key && !giphyKey) throw new AppError(404, 'gifs_off', 'GIFs are not available.');
    const { url, title } = parse(sendBody, req.body);
    const from = (key ? fromKlipy(url) : null) ?? (giphyKey ? fromGiphy(url) : null);
    if (!from) throw new AppError(400, 'not_a_gif', 'That GIF can’t be sent.');
    const provider: GifProvider = fromKlipy(from) ? 'klipy' : 'giphy';
    let bytes: Uint8Array | null = null;
    const sample = dev ? /^\/dev-sample\/(\d{1,3})\.gif$/.exec(new URL(from).pathname) : null;
    if (sample) bytes = await devGif(Number(sample[1]));
    else
      try {
        const res = await gifNetwork.fetch(from, { signal: AbortSignal.timeout(TIMEOUT_MS * 2), headers: { accept: 'image/gif,image/webp,image/*' } });
        if (res.ok) bytes = await readCapped(res, GIF_MAX_BYTES);
        else await res.body?.cancel().catch(() => {});
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'GIF download failed');
      }
    if (!bytes) throw new AppError(502, 'gifs_unavailable', "That GIF couldn't be sent. Try another one.");
    const raw = Buffer.from(bytes);
    const detected = detectMedia(raw, 'image/gif');
    if (!detected || detected.kind !== 'image') throw new AppError(502, 'gifs_unavailable', "That GIF couldn't be sent. Try another one.");
    const web = await toWebFormat(raw, detected).catch(() => {
      throw new AppError(502, 'gifs_unavailable', "That GIF couldn't be sent. Try another one.");
    });
    const stored = await ctx.storage.put(web.buf, web.ext, web.mime);
    const { rows } = await ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, alt_text, status, storage_key, size_bytes) VALUES ($1,'image',$2,$3,$4,'ready',$5,$6) RETURNING id, kind, url, alt_text`,
      [u.id, stored.url, web.mime, title || 'GIF', stored.key, web.buf.length],
    );
    await enqueue(ctx.db, 'media.process', { mediaId: rows[0].id, filename: `${provider}.gif` });
    reply.code(201);
    return { media: { id: rows[0].id, kind: rows[0].kind, url: rows[0].url, altText: rows[0].alt_text } };
  });
}
