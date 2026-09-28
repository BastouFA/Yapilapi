import { musicCredit, type MusicLicence } from '@yapilapi/shared';
import { clipSeconds, countryList, httpUrl, ProviderError, type MusicProvider, type ProviderQuery, type ProviderTrack } from './types.ts';

/**
 * A commercial music licensing partner: the way to offer mainstream and major-label music once the
 * business has signed a catalogue deal (see docs/operations/music.md). No deal is assumed: this
 * adapter stays off until MUSIC_LICENSED_API_URL and MUSIC_LICENSED_API_KEY are set.
 *
 * It expects a small JSON API, with `Authorization: Bearer <key>`:
 *   GET {base}/v1/search?q=&limit=&country=&commercial=   → { "tracks": [Track] }
 *   GET {base}/v1/trending?limit=&country=&commercial=    → { "tracks": [Track] }
 *   GET {base}/v1/tracks/{id}                             → { "track": Track }, 404 or status "withdrawn" when taken down
 * where Track is
 *   { "id", "title", "artist", "album"?, "durationMs"?, "artworkUrl"?, "previewUrl",
 *     "status"?: "active" | "withdrawn",
 *     "licence": { "name"?, "commercialUse", "territories": ["NG", ...] | null, "excludedTerritories"?,
 *                  "maxClipSeconds", "attribution"?, "expiresAt"?, "cacheAllowed"?, "derivatives"? } }
 * A partner whose API looks different is mapped here, in `toTrack` and the three calls, and nowhere else.
 * `previewUrl` is the partner's clip or stream address: players load it directly and play only the
 * licensed part, so nothing is proxied or stored here.
 */
export function licensedProvider(opts: { baseUrl: string; apiKey: string; name?: string; fetch?: typeof fetch }): MusicProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;

  async function call(path: string, params: Record<string, string> = {}): Promise<unknown | null> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${opts.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (e) {
      throw new ProviderError('licensed', (e as Error).message);
    }
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new ProviderError('licensed', `HTTP ${res.status}`);
    return res.json().catch(() => {
      throw new ProviderError('licensed', 'unexpected answer');
    });
  }

  const params = (o: ProviderQuery): Record<string, string> => ({
    limit: String(Math.min(50, Math.max(1, o.limit))),
    commercial: o.commercialOnly ? 'true' : 'false',
    ...(o.country ? { country: o.country } : {}),
  });
  const list = (body: unknown) => {
    const tracks = (body as { tracks?: unknown[] } | null)?.tracks;
    if (!Array.isArray(tracks)) throw new ProviderError('licensed', 'unexpected answer');
    return tracks.map(toTrack).filter((x): x is ProviderTrack => !!x);
  };

  return {
    id: 'licensed',
    label: opts.name?.trim() || 'Licensed catalogue',
    kind: 'licensed',
    enabled: !!(opts.baseUrl && opts.apiKey),
    search: async (q, o) => list(await call('/v1/search', { ...params(o), q })),
    trending: async (o) => list(await call('/v1/trending', params(o))),
    getTrack: async (externalId) => {
      if (!/^[\w.:-]{1,200}$/.test(externalId)) return null;
      const body = (await call(`/v1/tracks/${encodeURIComponent(externalId)}`)) as { track?: unknown } | null;
      return body?.track ? toTrack(body.track) : null;
    },
  };
}

function toTrack(raw: unknown): ProviderTrack | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const l = (r.licence ?? {}) as Record<string, unknown>;
  const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : null;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const artist = typeof r.artist === 'string' ? r.artist.trim() : '';
  // Anything without a clear licence, or taken down, is not offered.
  if (!id || !title || !artist || r.status === 'withdrawn' || typeof l.commercialUse !== 'boolean') return null;
  const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 80) : 'Licensed';
  const expires = typeof l.expiresAt === 'string' && !Number.isNaN(Date.parse(l.expiresAt)) ? new Date(l.expiresAt).toISOString() : null;
  const licence: MusicLicence = {
    name,
    url: httpUrl(l.url),
    commercialUse: l.commercialUse,
    regions: l.territories === null || l.territories === undefined ? null : countryList(l.territories),
    excludedRegions: countryList(l.excludedTerritories),
    maxClipSeconds: clipSeconds(l.maxClipSeconds),
    attribution:
      typeof l.attribution === 'string' && l.attribution.trim() ? l.attribution.trim().slice(0, 300) : musicCredit({ title, artist, licenceName: name }),
    expiresAt: expires,
    cacheAllowed: l.cacheAllowed === true,
    // Echoes of a reel keep the song only when the partner says so.
    derivatives: l.derivatives === true,
  };
  const ms = Number(r.durationMs);
  return {
    externalId: id,
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    album: typeof r.album === 'string' && r.album.trim() ? r.album.trim().slice(0, 200) : null,
    durationMs: Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null,
    coverUrl: httpUrl(r.artworkUrl),
    previewUrl: httpUrl(r.previewUrl),
    licence,
  };
}
