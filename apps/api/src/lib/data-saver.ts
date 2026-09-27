import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Lite responses for people on Data saver or slow connections.
 *
 * A request is lite when it carries `?lite=1` (or `lite=true`) or the standard
 * `Save-Data: on` header, which browsers send by themselves when the person
 * turned on their browser's or phone's data saving. Lite responses keep every
 * field older clients rely on and only leave out heavy extras: the large photo
 * size (clients fall back to medium) and large cover photos (the medium size
 * is sent instead). Responses say `Vary: Save-Data` so caches keep both.
 */
export function isLite(req: FastifyRequest): boolean {
  const q = req.query as Record<string, unknown> | null | undefined;
  const lite = q && typeof q === 'object' ? q.lite : undefined;
  if (lite === '1' || lite === 'true') return true;
  return (
    String(req.headers['save-data'] ?? '')
      .trim()
      .toLowerCase() === 'on'
  );
}

/** Processed-size names left out of lite responses. */
const HEAVY_VARIANTS = ['large', 'hls_720'];

/** A photo or video (MediaItem), or a story, which names them mediaKind and mediaUrl. */
function isMediaLike(o: Record<string, unknown>): boolean {
  const kind = o.kind ?? o.mediaKind;
  const url = o.url ?? o.mediaUrl;
  return typeof kind === 'string' && typeof url === 'string' && !!o.variants && typeof o.variants === 'object' && !Array.isArray(o.variants);
}

function without(o: unknown, keys: string[]): unknown {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** A copy of a response body with the heavy extras taken out (see isLite). Anything that isn't plain JSON data is returned as is. */
export function liteTrim(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => liteTrim(v, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value; // Dates, Buffers, streams
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'coverUrl' && typeof v === 'string') out[k] = v.replace(/_large\.webp$/, '_medium.webp');
    else out[k] = liteTrim(v, depth + 1);
  }
  if (isMediaLike(o)) {
    out.variants = without(o.variants, HEAVY_VARIANTS);
    if (o.sizes) out.sizes = without(o.sizes, HEAVY_VARIANTS);
  }
  return out;
}

/** Wire lite responses into every JSON route. */
export function registerDataSaver(app: FastifyInstance) {
  app.addHook('preSerialization', async (req, reply, payload) => {
    const prev = reply.getHeader('vary');
    const vary = Array.isArray(prev) ? prev.join(', ') : prev ? String(prev) : '';
    if (!/\bsave-data\b/i.test(vary)) reply.header('vary', vary ? `${vary}, Save-Data` : 'Save-Data');
    return isLite(req) ? liteTrim(payload) : payload;
  });
}

/**
 * Small sizes every video should list. Videos processed before the 360p MP4 and
 * the variant list existed still have the 360p rung in their HLS ladder (v0).
 */
export function withSmallVariants<T extends { kind?: string; hlsUrl?: string | null; variants?: Record<string, string> | null }>(m: T): T {
  if (m.kind !== 'video' || !m.hlsUrl || m.variants?.hls_360 || !/\/index\.m3u8$/.test(m.hlsUrl)) return m;
  return { ...m, variants: { ...(m.variants ?? {}), hls_360: m.hlsUrl.replace(/index\.m3u8$/, 'v0.m3u8') } };
}

/** SQL for a media row's byte sizes: the original upload and every processed size. `m` is the media alias. */
export const mediaSizesSql = (m = 'm') => `(jsonb_strip_nulls(jsonb_build_object('original', ${m}.size_bytes)) || ${m}.variant_bytes)`;
