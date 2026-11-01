import { herePoint, type LatLng, type PlaceArea } from '@yapilapi/shared';

/**
 * Naming the area a point is in, for "Where you are" when tagging a post (GET /v1/places/here):
 * reverse geocoding with OpenStreetMap's Nominatim (GEOCODE_URL; empty turns it off).
 *
 * Nominatim's public service asks for at most one request a second, a User-Agent that says who we
 * are, and caching (https://operations.osmfoundation.org/policies/nominatim/). So:
 * - answers are kept for a day, by the point rounded to 3 decimal places (about 100 metres) and the
 *   language, and only that rounded point is ever sent;
 * - at most one request a second for the whole server: when one went out less than a second ago, the
 *   answer is "can't tell" (null) rather than a queue, and the apps still show the place pages near you;
 * - a request that takes more than 4 seconds is given up.
 * Nothing is logged or kept about who asked or where.
 */
export interface Geocoder {
  enabled: boolean;
  /** The area at this point, named in `locale` where the map has it; null when it can't be told. */
  reverse(p: LatLng, locale: string): Promise<PlaceArea | null>;
  /** Where a city is (its middle), for the map's "Search a city" when it has no place pages yet. */
  city?(name: string, locale: string): Promise<{ city: string; lat: number; lng: number } | null>;
}

const USER_AGENT = 'YAPILAPI/1.0 (+https://yapilapi.com)';
const TIMEOUT_MS = 4_000;
const MIN_GAP_MS = 1_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5_000;

type Address = Record<string, string | undefined>;
const first = (a: Address, keys: string[]) => keys.map((k) => a[k]?.trim()).find((v): v is string => !!v) ?? null;

/** A Nominatim jsonv2 reverse answer as an area, or null when it names nothing usable. */
export function areaFromNominatim(body: unknown): PlaceArea | null {
  if (!body || typeof body !== 'object' || 'error' in body) return null;
  const b = body as { lat?: unknown; lon?: unknown; address?: Address };
  const lat = Number(b.lat);
  const lng = Number(b.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const a = b.address && typeof b.address === 'object' ? b.address : {};
  const city = first(a, ['city', 'town', 'village', 'county']);
  const name = first(a, ['neighbourhood', 'suburb', 'quarter']) ?? first(a, ['city', 'town', 'village']);
  if (!name) return null;
  const cc = (a.country_code ?? '').trim().toUpperCase();
  // The area's point, kept no finer than the point that was asked about.
  const at = herePoint({ lat, lng });
  return { name: name.slice(0, 120), city: city ? city.slice(0, 100) : null, country: /^[A-Z]{2}$/.test(cc) ? cc : null, lat: at.lat, lng: at.lng };
}

export function nominatimGeocoder(opts: { baseUrl: string; fetch?: typeof fetch; now?: () => number; log?: (msg: string, err?: unknown) => void }): Geocoder {
  const base = opts.baseUrl.trim().replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { area: PlaceArea | null; until: number }>();
  const cities = new Map<string, { found: { city: string; lat: number; lng: number } | null; until: number }>();
  let lastSent = -Infinity;

  function remember(key: string, area: PlaceArea | null) {
    cache.delete(key);
    cache.set(key, { area, until: now() + CACHE_TTL_MS });
    // A Map keeps insertion order: the first key is the oldest.
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }

  return {
    enabled: !!base,
    async reverse(p, locale) {
      if (!base) return null;
      const at = herePoint(p);
      const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale) ? locale : 'en';
      const key = `${at.lat.toFixed(3)},${at.lng.toFixed(3)},${lang}`;
      const kept = cache.get(key);
      if (kept && kept.until > now()) return kept.area;
      if (kept) cache.delete(key);
      if (now() - lastSent < MIN_GAP_MS) return null;
      lastSent = now();
      const url = new URL(`${base}/reverse`);
      for (const [k, v] of Object.entries({ format: 'jsonv2', lat: String(at.lat), lon: String(at.lng), zoom: '16', 'accept-language': lang }))
        url.searchParams.set(k, v);
      try {
        const res = await doFetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
          opts.log?.(`Reverse geocoding answered HTTP ${res.status}`);
          return null;
        }
        const area = areaFromNominatim(await res.json());
        // "Nothing here" (the sea) is kept too; failures aren't, so the next try can work.
        remember(key, area);
        return area;
      } catch (e) {
        opts.log?.('Reverse geocoding failed', e);
        return null;
      }
    },
    async city(name, locale) {
      const q = name.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!base || !q) return null;
      const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale) ? locale : 'en';
      const key = `city:${q.toLowerCase()},${lang}`;
      const kept = cities.get(key);
      if (kept && kept.until > now()) return kept.found;
      if (now() - lastSent < MIN_GAP_MS) return null;
      lastSent = now();
      const url = new URL(`${base}/search`);
      for (const [k, v] of Object.entries({ format: 'jsonv2', q, limit: '1', featureType: 'settlement', 'accept-language': lang })) url.searchParams.set(k, v);
      try {
        const res = await doFetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        const hit = ((await res.json()) as { lat?: string; lon?: string; name?: string }[])[0];
        const lat = Number(hit?.lat);
        const lng = Number(hit?.lon);
        const found = hit && Number.isFinite(lat) && Number.isFinite(lng) ? { city: (hit.name || q).slice(0, 100), lat, lng } : null;
        cities.delete(key);
        cities.set(key, { found, until: now() + CACHE_TTL_MS });
        while (cities.size > CACHE_MAX) cities.delete(cities.keys().next().value!);
        return found;
      } catch (e) {
        opts.log?.('City search failed', e);
        return null;
      }
    },
  };
}
