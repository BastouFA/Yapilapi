import type { MusicLicence } from '@yapilapi/shared';
import { musicCredit } from '@yapilapi/shared';
import { clipSeconds, httpUrl, ProviderError, type MusicProvider, type ProviderQuery, type ProviderTrack } from './types.ts';

/**
 * Jamendo: independent music under Creative Commons licences (hundreds of thousands of songs).
 * Needs a free client id (JAMENDO_CLIENT_ID, from https://devportal.jamendo.com).
 *
 * Only songs whose licence allows this use are offered:
 * - "No derivatives" (ND) licences are left out: putting a song under a video or a photo post is an
 *   adaptation under Creative Commons, which ND doesn't allow.
 * - "Share alike" (SA) licences are left out: the post would have to be shared under the same licence,
 *   which people here don't agree to when they post.
 * - "Non commercial" (NC) songs are for personal accounts only; business accounts get songs whose
 *   licence allows commercial use (CC BY, or public domain).
 * Every use shows the credit the licence asks for ("Title by Artist · CC BY 4.0").
 */
export function jamendoProvider(opts: { clientId: string; baseUrl?: string; fetch?: typeof fetch }): MusicProvider {
  const base = (opts.baseUrl || 'https://api.jamendo.com/v3.0').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;

  async function tracks(params: Record<string, string>, filtered = true): Promise<ProviderTrack[]> {
    const url = new URL(`${base}/tracks/`);
    const all: Record<string, string> = {
      client_id: opts.clientId,
      format: 'json',
      include: 'licenses',
      audioformat: 'mp32',
      imagesize: '200',
      // Leave out licences that don't allow this use (see above); each song's licence is checked here too.
      ...(filtered ? { ccnd: 'false', ccsa: 'false' } : {}),
      ...params,
    };
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    } catch (e) {
      throw new ProviderError('jamendo', (e as Error).message);
    }
    if (!res.ok) throw new ProviderError('jamendo', `HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { headers?: { status?: string; error_message?: string }; results?: unknown[] } | null;
    if (!body || body.headers?.status !== 'success' || !Array.isArray(body.results))
      throw new ProviderError('jamendo', body?.headers?.error_message || 'unexpected answer');
    return body.results.map(toTrack).filter((x): x is ProviderTrack => !!x);
  }

  const common = (o: ProviderQuery): Record<string, string> => ({
    limit: String(Math.min(50, Math.max(1, o.limit))),
    ...(o.commercialOnly ? { ccnc: 'false' } : {}),
  });

  return {
    id: 'jamendo',
    label: 'Jamendo',
    kind: 'creative_commons',
    enabled: !!opts.clientId,
    search: (q, o) => tracks({ ...common(o), search: q, order: 'relevance' }),
    trending: (o) => tracks({ ...common(o), order: 'popularity_week' }),
    getTrack: async (externalId) => {
      if (!/^\d{1,12}$/.test(externalId)) return null;
      // Asked by id without the licence filters, so a song whose licence changed shows up and is checked (and refused) here.
      const found = await tracks({ id: externalId, limit: '1' }, false);
      return found[0] ?? null;
    },
  };
}

/** "http://creativecommons.org/licenses/by-nc/3.0/" → the licence as used here; null when it doesn't allow this use. */
export function jamendoLicence(ccUrl: unknown, credit: { title: string; artist: string }): MusicLicence | null {
  if (typeof ccUrl !== 'string') return null;
  const url = ccUrl.replace(/^http:/i, 'https:');
  let name: string;
  let commercialUse: boolean;
  if (/publicdomain\/zero/i.test(url)) {
    name = 'CC0 1.0';
    commercialUse = true;
  } else {
    const m = url.match(/licenses\/([a-z-]+)\/(\d+(?:\.\d+)?)/i);
    if (!m) return null;
    const parts = m[1]!.toLowerCase().split('-');
    if (parts[0] !== 'by') return null;
    // No derivatives and share alike don't allow this use (see jamendoProvider).
    if (parts.includes('nd') || parts.includes('sa')) return null;
    commercialUse = !parts.includes('nc');
    name = `CC ${parts.join('-').toUpperCase()} ${m[2]}`;
  }
  return {
    name,
    url,
    commercialUse,
    regions: null,
    excludedRegions: [],
    maxClipSeconds: clipSeconds(30),
    attribution: musicCredit({ ...credit, licenceName: name }),
    expiresAt: null,
    // We keep references only; Creative Commons would allow copies, but nothing needs them.
    cacheAllowed: false,
  };
}

function toTrack(raw: unknown): ProviderTrack | null {
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : null;
  const title = typeof r.name === 'string' ? r.name.trim() : '';
  const artist = typeof r.artist_name === 'string' ? r.artist_name.trim() : '';
  if (!id || !title || !artist) return null;
  const licence = jamendoLicence(r.license_ccurl, { title, artist });
  if (!licence) return null;
  const seconds = Number(r.duration);
  return {
    externalId: id,
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    album: typeof r.album_name === 'string' && r.album_name.trim() ? r.album_name.trim().slice(0, 200) : null,
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    coverUrl: httpUrl(r.album_image) ?? httpUrl(r.image),
    previewUrl: httpUrl(r.audio),
    licence,
  };
}
