import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { areaFromNominatim, nominatimGeocoder } from '../src/lib/geocode.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * "Where you are" when tagging a post (GET and POST /v1/places/here, lib/geocode.ts). The geocoder
 * gets a fake fetch and clock, so nothing leaves the machine. Each test works in its own part of
 * the world (spot(n)), away from the other test files' places.
 */

interface Call {
  url: URL;
  headers: Record<string, string>;
}
let calls: Call[] = [];
let clock = 1_000_000;
/** What the fake Nominatim answers next: a body, an HTTP status, or a thrown error. */
let answer: { body?: unknown; status?: number; fail?: boolean } = {};

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: new URL(String(input)), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
  if (answer.fail) throw new Error('network down');
  return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const nominatim = (address: Record<string, string>, lat = '6.5', lon = '3.3') => ({ lat, lon, address, display_name: 'somewhere' });

let t: BuiltApp;
let off: BuiltApp;
let u: TestUser;
beforeAll(async () => {
  t = await testApp({}, { geocoder: nominatimGeocoder({ baseUrl: 'https://geo.example.test/', fetch: fakeFetch, now: () => clock }) });
  // As tests run by default: GEOCODE_URL unset is off.
  off = await testApp();
  u = await signUp(t.app);
});
afterAll(async () => {
  await t.close();
  await off.close();
});
beforeEach(() => {
  calls = [];
  answer = {};
  // Past the one-request-a-second limit, so each test's first lookup goes out.
  clock += 5_000;
});

/** A part of the world of its own for each test (3 decimal places, as the apps send it). */
const spot = (n: number) => ({ lat: Number((-54.2 + n * 0.21).toFixed(3)), lng: Number((-37.4 + n * 0.23).toFixed(3)) });
/** About `north` and `east` metres from p. */
const from = (p: { lat: number; lng: number }, north: number, east = 0) => ({
  lat: p.lat + north / 111_195,
  lng: p.lng + east / (111_195 * Math.cos((p.lat * Math.PI) / 180)),
});
const here = (who: TestUser | null, p: { lat: number; lng: number }, app = t) => as(app.app, who).get(`/v1/places/here?lat=${p.lat}&lng=${p.lng}`);
async function place(at: { lat: number; lng: number }, name: string, city = 'Grytviken') {
  const r = await as(t.app, u).post('/v1/places', { name, category: 'venue', city, ...at });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.place.id as string;
}

describe('GET /v1/places/here', () => {
  it('needs you to be signed in, and a point', async () => {
    expect((await here(null, spot(1))).status).toBe(401);
    expect((await as(t.app, u).get('/v1/places/here')).status).toBe(400);
    expect((await as(t.app, u).get('/v1/places/here?lat=95&lng=3')).status).toBe(400);
    expect((await as(t.app, u).get('/v1/places/here?lat=6&lng=abc')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('suggests the place pages within a kilometre, nearest first, five at most', async () => {
    const p = spot(2);
    const far = await place(from(p, 1500), 'Far pier');
    const mid = await place(from(p, 600), 'Whaling museum');
    const close = await place(from(p, 150, 50), 'Corner café');
    const gone = await place(from(p, 100), 'Closed shop');
    await t.ctx.db.query(`UPDATE places SET deleted_at = now() WHERE id = $1`, [gone]);
    const r = await here(u, p);
    expect(r.status).toBe(200);
    const ids = r.body.nearby.map((x: { id: string }) => x.id);
    expect(ids).toEqual([close, mid]);
    expect(ids).not.toContain(far);
    expect(r.body.nearby[0]).toMatchObject({ name: 'Corner café', city: 'Grytviken' });
    expect(r.body.nearby[0].distanceM).toBeGreaterThan(140);
    expect(r.body.nearby[0].distanceM).toBeLessThan(170);
    expect(r.body.nearby[1].distanceM).toBeGreaterThan(580);
    expect(r.body.nearby[1].distanceM).toBeLessThan(620);

    for (let i = 0; i < 5; i++) await place(from(p, 300 + i * 20), `Stall ${i}`);
    const many = await here(u, p);
    expect(many.body.nearby).toHaveLength(5);
    const metres = many.body.nearby.map((x: { distanceM: number }) => x.distanceM);
    expect([...metres].sort((a, b) => a - b)).toEqual(metres);
  });

  it("names the area from the geocoder, in the person's language, with the area's own point", async () => {
    const p = spot(3);
    const fr = await signUp(t.app);
    await t.ctx.db.query(`UPDATE profiles SET locale = 'fr' WHERE user_id = $1`, [fr.id]);
    answer = { body: nominatim({ neighbourhood: 'Yaba', suburb: 'Mainland', city: 'Lagos', country_code: 'ng' }, '6.51234567', '3.37891234') };
    const precise = { lat: p.lat + 0.000444, lng: p.lng - 0.000333 };
    const r = await here(fr, precise);
    expect(r.status).toBe(200);
    expect(r.body.area).toEqual({ name: 'Yaba', city: 'Lagos', country: 'NG', lat: 6.512, lng: 3.379 });
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.origin + url.pathname).toBe('https://geo.example.test/reverse');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('zoom')).toBe('16');
    expect(url.searchParams.get('accept-language')).toBe('fr');
    // Only the point rounded to 3 decimal places goes out.
    expect(Number(url.searchParams.get('lat'))).toBe(Number(precise.lat.toFixed(3)));
    expect(Number(url.searchParams.get('lon'))).toBe(Number(precise.lng.toFixed(3)));
    expect(headers['user-agent']).toBe('YAPILAPI/1.0 (+https://yapilapi.com)');

    // The same rounded point again: from the cache, even within the same second.
    const again = await here(fr, { lat: p.lat + 0.0001, lng: p.lng - 0.0002 });
    expect(again.body.area).toMatchObject({ name: 'Yaba' });
    expect(calls).toHaveLength(1);
  });

  it('leaves the area out when it was asked less than a second ago, when it fails, and when it names nothing', async () => {
    answer = { body: nominatim({ suburb: 'Ikeja', city: 'Lagos', country_code: 'ng' }) };
    expect((await here(u, spot(4))).body.area).toMatchObject({ name: 'Ikeja' });
    // Another point at once: not sent (no queue), and the place pages still come.
    const p = spot(5);
    const id = await place(from(p, 50), 'Busy bar');
    const busy = await here(u, p);
    expect(busy.status).toBe(200);
    expect(busy.body.area).toBeNull();
    expect(busy.body.nearby.map((x: { id: string }) => x.id)).toEqual([id]);
    expect(calls).toHaveLength(1);

    clock += 2_000;
    answer = { fail: true };
    expect((await here(u, spot(6))).body.area).toBeNull();
    clock += 2_000;
    answer = { status: 503 };
    expect((await here(u, spot(7))).body.area).toBeNull();
    clock += 2_000;
    answer = { body: { error: 'Unable to geocode' } };
    expect((await here(u, spot(8))).body.area).toBeNull();
    expect(calls).toHaveLength(4);
    // A failure isn't kept: the next try asks again.
    clock += 2_000;
    answer = { body: nominatim({ town: 'Badagry', county: 'Badagry', country_code: 'ng' }) };
    expect((await here(u, spot(6))).body.area).toMatchObject({ name: 'Badagry', city: 'Badagry', country: 'NG' });
    expect(calls).toHaveLength(5);
  });

  it("doesn't suggest the area's own place page twice", async () => {
    const p = spot(9);
    await place(from(p, 80), 'Yaba', 'Lagos');
    const other = await place(from(p, 120), 'Tejuosho market', 'Lagos');
    answer = { body: nominatim({ neighbourhood: 'Yaba', city: 'Lagos', country_code: 'ng' }) };
    const r = await here(u, p);
    expect(r.body.area).toMatchObject({ name: 'Yaba', city: 'Lagos' });
    expect(r.body.nearby.map((x: { id: string }) => x.id)).toEqual([other]);
  });

  it('gives no area when reverse geocoding is off (GEOCODE_URL unset in tests, or off)', async () => {
    const someone = await signUp(off.app);
    const r = await here(someone, spot(10), off);
    expect(r.status).toBe(200);
    expect(r.body.area).toBeNull();
    expect(Array.isArray(r.body.nearby)).toBe(true);
    expect(off.ctx.geocoder.enabled).toBe(false);
  });
});

describe('POST /v1/places/here', () => {
  const area = (n: number, extra: Record<string, unknown> = {}) => ({ name: `Area ${n}`, city: 'Lomé', country: 'tg', ...spot(n), ...extra });

  it('needs you to be signed in, and a name and point', async () => {
    expect((await as(t.app, null).post('/v1/places/here', area(11))).status).toBe(401);
    for (const bad of [
      { ...area(11), name: '' },
      { ...area(11), name: 'x'.repeat(121) },
      { ...area(11), lat: 91 },
      { ...area(11), lng: undefined },
      { ...area(11), country: 'TGO' },
    ])
      expect((await as(t.app, u).post('/v1/places/here', bad)).status).toBe(400);
  });

  it('makes an area page the first time, and uses it again for the same area', async () => {
    const first = await as(t.app, u).post('/v1/places/here', area(12));
    expect(first.status).toBe(201);
    expect(first.body.place).toMatchObject({ name: 'Area 12', category: 'area', city: 'Lomé', country: 'TG' });
    const row = await t.ctx.db.query(`SELECT created_by FROM places WHERE id = $1`, [first.body.place.id]);
    expect(row.rows[0].created_by).toBe(u.id);

    // Someone else, a little way off, the name in other letters: the same page.
    const other = await signUp(t.app);
    const again = await as(t.app, other).post('/v1/places/here', { ...area(12, from(spot(12), 1200, 900)), name: 'AREA 12', city: 'lomé' });
    expect(again.status).toBe(200);
    expect(again.body.place.id).toBe(first.body.place.id);

    // Far away, or in another city: a page of its own.
    const far = await as(t.app, u).post('/v1/places/here', area(12, from(spot(12), 8000)));
    expect(far.status).toBe(201);
    expect(far.body.place.id).not.toBe(first.body.place.id);
    const elsewhere = await as(t.app, u).post('/v1/places/here', area(12, { city: 'Kpalimé' }));
    expect(elsewhere.body.place.id).not.toBe(first.body.place.id);
  });

  it('uses a place page of another kind with the same name and city', async () => {
    const id = await place(from(spot(13), 400), 'Old Town', 'Grytviken');
    const r = await as(t.app, u).post('/v1/places/here', { name: 'old town', city: 'Grytviken', ...spot(13) });
    expect(r.status).toBe(200);
    expect(r.body.place.id).toBe(id);
    expect(r.body.place.category).toBe('venue');
  });

  it('makes one page when two people tag a new area at once', async () => {
    const other = await signUp(t.app);
    const [a, b] = await Promise.all([as(t.app, u).post('/v1/places/here', area(14)), as(t.app, other).post('/v1/places/here', area(14))]);
    expect(a.body.place.id).toBe(b.body.place.id);
  });

  it("isn't a kind anyone can make with the place form", async () => {
    const r = await as(t.app, u).post('/v1/places', { name: 'My area', category: 'area', city: 'Lomé' });
    expect(r.status).toBe(400);
  });
});

describe('areaFromNominatim', () => {
  it('names the neighbourhood, else the suburb or quarter, else the town; the city from city, town, village or county', () => {
    expect(areaFromNominatim(nominatim({ quarter: 'Bè', city: 'Lomé', country_code: 'tg' }))).toMatchObject({ name: 'Bè', city: 'Lomé', country: 'TG' });
    expect(areaFromNominatim(nominatim({ village: 'Aného', county: 'Lacs', country_code: 'tg' }))).toMatchObject({ name: 'Aného', city: 'Aného' });
    expect(areaFromNominatim(nominatim({ county: 'Lacs', country_code: 'x1' }))).toBeNull();
    expect(areaFromNominatim(nominatim({ suburb: 'Montmartre', city: 'Paris', country_code: 'fr' }))).toMatchObject({ name: 'Montmartre', city: 'Paris' });
    expect(areaFromNominatim(nominatim({ neighbourhood: 'Somewhere' }, 'nope', '3'))).toBeNull();
    expect(areaFromNominatim(nominatim({ neighbourhood: 'Somewhere', country_code: 'x1' }))).toMatchObject({ city: null, country: null });
    expect(areaFromNominatim(null)).toBeNull();
  });

  it('keeps answers for a day, by the rounded point and the language', async () => {
    let now = 0;
    let sent = 0;
    const g = nominatimGeocoder({
      baseUrl: 'https://geo.example.test',
      now: () => now,
      fetch: (async () => {
        sent++;
        return new Response(JSON.stringify(nominatim({ suburb: 'S', city: 'C', country_code: 'fr' })));
      }) as typeof fetch,
    });
    await g.reverse({ lat: 48.8566, lng: 2.3522 }, 'fr');
    now += 60 * 60 * 1000;
    await g.reverse({ lat: 48.8566, lng: 2.3522 }, 'fr');
    expect(sent).toBe(1);
    // Another language is another answer.
    now += 2_000;
    await g.reverse({ lat: 48.8566, lng: 2.3522 }, 'en');
    expect(sent).toBe(2);
    // A day later the answer is asked for again.
    now += 25 * 60 * 60 * 1000;
    await g.reverse({ lat: 48.8566, lng: 2.3522 }, 'fr');
    expect(sent).toBe(3);
  });
});
