import type { Pool, PoolClient } from 'pg';
import { enqueue, type JobHandler } from './jobs.ts';
import { safeFetch, type SafeFetchDeps } from './safe-fetch.ts';

type Q = Pool | PoolClient;

/**
 * Site icons for profile links. The server fetches `https://<host>/favicon.ico` itself, through
 * safeFetch like webhooks (https only, connections only to addresses checked as public, each
 * redirect checked again), keeps
 * only a small image it recognises by its bytes, and serves it from /v1/link-icons/:host. Browsers
 * and phones never contact the linked site just to show a profile.
 */

/** Largest icon kept. */
export const LINK_ICON_MAX_BYTES = 32 * 1024;
/** How long an icon (or knowing a site has none) is kept before asking again. */
export const LINK_ICON_TTL_DAYS = 7;
const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 4_000;

export type LinkIconDeps = SafeFetchDeps;

/** The host whose icon a link shows: lower case, no port. Null for anything that isn't a web address. */
export function iconHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return /^[a-z0-9.-]{1,253}$/.test(h) && h.includes('.') ? h : null;
  } catch {
    return null;
  }
}

/** What kind of image these bytes are, from their first bytes (never from what the site says). SVG is refused: it can carry script. */
export function sniffIcon(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (b.length < 4) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Read at most `max` bytes of a response; null if it is longer. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max + 1);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * Fetch one site's icon safely. Returns the image and its type, or null when there is none we'd
 * show. Never throws for anything the site does.
 */
export async function fetchLinkIcon(host: string, deps: LinkIconDeps = {}): Promise<{ image: Buffer; mime: string } | null> {
  try {
    // https only, no credentials, and the connection goes only to addresses checked as public (each redirect too).
    const res = await safeFetch(
      `https://${host}/favicon.ico`,
      {
        headers: { accept: 'image/*', 'user-agent': 'YAPILAPI-LinkIcons/1' },
        maxRedirects: MAX_REDIRECTS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      deps,
    );
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readCapped(res, LINK_ICON_MAX_BYTES);
    if (!bytes) return null;
    const mime = sniffIcon(bytes);
    return mime ? { image: Buffer.from(bytes), mime } : null;
  } catch {
    // Unreachable, unsafe, too slow or too big: no icon.
  }
  return null;
}

/** Fetch icons for hosts we have none for yet (or only a week-old answer), and keep the answer either way. */
export async function refreshLinkIcons(db: Q, hosts: string[], deps: LinkIconDeps = {}): Promise<void> {
  const unique = [...new Set(hosts.map((h) => h.toLowerCase()))].filter((h) => iconHost(`https://${h}/`) === h);
  if (!unique.length) return;
  const { rows } = await db.query<{ host: string }>(`SELECT host FROM link_icons WHERE host = ANY($1) AND fetched_at > now() - make_interval(days => $2)`, [
    unique,
    LINK_ICON_TTL_DAYS,
  ]);
  const fresh = new Set(rows.map((r) => r.host));
  for (const host of unique.filter((h) => !fresh.has(h))) {
    const icon = await fetchLinkIcon(host, deps);
    await db.query(
      `INSERT INTO link_icons (host, image, mime, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (host) DO UPDATE SET image = EXCLUDED.image, mime = EXCLUDED.mime, fetched_at = now()`,
      [host, icon?.image ?? null, icon?.mime ?? null],
    );
  }
}

/** Queue fetching icons for these links' hosts (the job worker does the fetching, never the request). */
export async function queueLinkIcons(db: Q, urls: string[]): Promise<void> {
  const hosts = [...new Set(urls.map(iconHost).filter((h): h is string => !!h))];
  if (hosts.length) await enqueue(db, 'profile.link_icons', { hosts });
}

/** Which of these hosts have an icon to show. */
export async function hostsWithIcons(db: Q, hosts: string[]): Promise<Set<string>> {
  if (!hosts.length) return new Set();
  const { rows } = await db.query<{ host: string }>(`SELECT host FROM link_icons WHERE host = ANY($1) AND image IS NOT NULL`, [hosts]);
  return new Set(rows.map((r) => r.host));
}

export function linkIconJobHandlers(db: Pool, deps: LinkIconDeps = {}): Record<string, JobHandler> {
  return {
    'profile.link_icons': async (payload: { hosts?: unknown }) => {
      const hosts = Array.isArray(payload.hosts) ? payload.hosts.filter((h): h is string => typeof h === 'string').slice(0, 10) : [];
      await refreshLinkIcons(db, hosts, deps);
    },
  };
}
