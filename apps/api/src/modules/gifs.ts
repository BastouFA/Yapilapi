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

/** KLIPY's API; its files are served from KLIPY_FILES only, the one host a GIF is fetched from. */
const KLIPY_API = 'https://api.klipy.com/api/v1';
const KLIPY_FILES = 'static.klipy.com';
/** A GIF bigger than this isn't sent (a chat's GIFs are a few hundred KB to a few MB). */
export const GIF_MAX_BYTES = 15 * 1024 * 1024;
const PER_PAGE = 24;
/** The same search (and the trending list) is asked of KLIPY at most once in this long. */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 300;
const TIMEOUT_MS = 10_000;

/** How the API reaches KLIPY; tests put a stand-in here. */
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

const fromKlipy = (u: string | undefined) => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === KLIPY_FILES ? url.toString() : null;
  } catch {
    return null;
  }
};

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

/**
 * GIFs in chats, from KLIPY: GET /v1/gifs (trending, or a search with q) and POST /v1/gifs/send,
 * which fetches the chosen GIF and keeps it as the person's own photo, like an upload: the chat
 * shows it from our storage, and the people in it never load anything from KLIPY. Only KLIPY's
 * file host is ever fetched. Under-18s get KLIPY's strictest filter. KLIPY is told a stand-in for
 * the person (a hash), never who they are. Without KLIPY_API_KEY, `enabled` is false and there's
 * no GIF tab.
 */
export default async function gifsModule(app: FastifyInstance, ctx: AppContext) {
  const key = ctx.config.KLIPY_API_KEY;
  const dev = key === DEV_KEY && ctx.config.APP_ENV !== 'production';

  app.get('/v1/gifs', { preHandler: requireAuth, config: { rateLimit: { max: 300, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    if (!key) return { enabled: false, items: [], next: null };
    const q = parse(searchQuery, req.query);
    const page = q.page ?? 1;
    const age = ageOf(u.birthDate ?? null);
    const filter = age !== null && age < 18 ? 'high' : 'medium';
    if (dev) return { enabled: true, ...(await devPage(q.q, page)) };
    const cacheKey = `${filter}|${(q.q ?? '').toLowerCase()}|${page}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return { enabled: true, ...hit.body };
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
      content_filter: filter,
      format_filter: 'gif,webp',
      customer_id: createHash('sha256').update(`yapilapi-gif:${u.id}`).digest('hex').slice(0, 32),
    });
    if (q.q) params.set('q', q.q);
    const url = `${KLIPY_API}/${encodeURIComponent(key)}/gifs/${q.q ? 'search' : 'trending'}?${params}`;
    let data: { result?: boolean; data?: { data?: KlipyItem[]; has_next?: boolean } };
    try {
      const res = await gifNetwork.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`KLIPY ${res.status}`);
      data = (await res.json()) as typeof data;
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'GIF search failed');
      throw new AppError(502, 'gifs_unavailable', "GIFs couldn't load. Try again in a moment.");
    }
    const items = (data.data?.data ?? []).map(toGif).filter((g): g is Gif => !!g);
    const body = { items, next: data.data?.has_next ? page + 1 : null };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: Date.now(), body });
    return { enabled: true, ...body };
  });

  app.post('/v1/gifs/send', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    if (!key) throw new AppError(404, 'gifs_off', 'GIFs are not available.');
    const { url, title } = parse(sendBody, req.body);
    const from = fromKlipy(url);
    if (!from) throw new AppError(400, 'not_a_gif', 'That GIF can’t be sent.');
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
    await enqueue(ctx.db, 'media.process', { mediaId: rows[0].id, filename: 'klipy.gif' });
    reply.code(201);
    return { media: { id: rows[0].id, kind: rows[0].kind, url: rows[0].url, altText: rows[0].alt_text } };
  });
}
