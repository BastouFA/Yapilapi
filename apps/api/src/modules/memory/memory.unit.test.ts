import { describe, expect, it } from 'vitest';
import { buildRecap, recapText } from './recap.js';
import { clusterTrips, inferHome, tripKey, type GeoItem } from './trips.js';

let n = 0;
const it_ = (at: string, latitude: number, longitude: number, type = 'post'): GeoItem => ({
  type,
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  at: new Date(at),
  latitude,
  longitude,
});
// Home: London. Trip: Lisbon, then Berlin months later.
const home = (day: number, h = 10) =>
  it_(
    `2026-01-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`,
    51.5 + day * 0.001,
    -0.12,
  );

describe('inferHome', () => {
  it('picks the area with the most distinct days, not the most items', () => {
    const items = [
      home(1),
      home(2),
      home(3),
      home(4),
      ...Array.from({ length: 10 }, (_, i) =>
        it_(`2026-02-10T${String(8 + i).padStart(2, '0')}:00:00Z`, 38.7, -9.14),
      ),
    ];
    const h = inferHome(items)!;
    expect(Math.round(h.latitude)).toBe(52); // London cell (51.5..), not Lisbon's 10 items on ONE day
    expect(inferHome([])).toBeNull();
  });
});

describe('clusterTrips', () => {
  it('finds a trip away from home and ignores home items', () => {
    const lisbon = [
      it_('2026-02-10T09:00:00Z', 38.72, -9.14),
      it_('2026-02-10T18:00:00Z', 38.71, -9.13),
      it_('2026-02-11T12:00:00Z', 38.75, -9.2, 'real_capture'),
      it_('2026-02-12T08:00:00Z', 38.7, -9.1, 'moment'),
    ];
    const trips = clusterTrips([home(1), home(2), home(3), home(9), ...lisbon]);
    expect(trips).toHaveLength(1);
    const t = trips[0]!;
    expect(t.items).toHaveLength(4);
    expect(t.distinctDays).toBe(3);
    expect(t.startAt.toISOString()).toBe('2026-02-10T09:00:00.000Z');
    expect(t.endAt.toISOString()).toBe('2026-02-12T08:00:00.000Z');
    expect(t.maxDistanceFromHomeKm).toBeGreaterThan(1500);
    expect(t.centroid.latitude).toBeCloseTo(38.72, 1);
  });
  it('splits trips at a long gap and drops groups that are too small', () => {
    const a = [
      it_('2026-02-10T09:00:00Z', 38.72, -9.14),
      it_('2026-02-10T12:00:00Z', 38.72, -9.14),
      it_('2026-02-11T09:00:00Z', 38.72, -9.14),
    ];
    const b = [
      it_('2026-04-01T09:00:00Z', 52.52, 13.4),
      it_('2026-04-02T09:00:00Z', 52.5, 13.4),
      it_('2026-04-03T09:00:00Z', 52.5, 13.3),
    ];
    const tiny = [
      it_('2026-03-01T09:00:00Z', 48.85, 2.35),
      it_('2026-03-01T10:00:00Z', 48.85, 2.35),
    ];
    const trips = clusterTrips([home(1), home(2), home(3), home(4), home(5), ...a, ...tiny, ...b]);
    expect(trips.map((t) => t.items.length)).toEqual([3, 3]);
    expect(trips[0]!.startAt < trips[1]!.startAt).toBe(true);
  });
  it('is deterministic and independent of input order', () => {
    const items = [
      home(1),
      home(2),
      home(3),
      it_('2026-02-10T09:00:00Z', 38.72, -9.14),
      it_('2026-02-10T11:00:00Z', 38.72, -9.14),
      it_('2026-02-11T09:00:00Z', 38.72, -9.14),
    ];
    const a = clusterTrips(items);
    const b = clusterTrips([...items].reverse());
    expect(a).toEqual(b);
    expect(a[0]!.key).toMatch(/^[0-9a-f]{24}$/);
  });
  it('key depends only on the member items', () => {
    const x = [
      { type: 'post', id: 'a' },
      { type: 'moment', id: 'b' },
    ];
    expect(tripKey(x)).toBe(tripKey([...x].reverse()));
    expect(tripKey(x)).not.toBe(tripKey([{ type: 'post', id: 'a' }]));
  });
  it('respects an explicit home, thresholds, and ignores invalid coordinates', () => {
    const near = [
      it_('2026-02-10T09:00:00Z', 51.6, -0.1),
      it_('2026-02-10T10:00:00Z', 51.6, -0.1),
      it_('2026-02-10T11:00:00Z', 51.6, -0.1),
    ];
    expect(clusterTrips(near, { home: { latitude: 51.5, longitude: -0.12 } })).toEqual([]);
    expect(clusterTrips(near, { home: { latitude: 40, longitude: -3 }, minItems: 3 })).toHaveLength(
      1,
    );
    expect(clusterTrips(near, { home: { latitude: 40, longitude: -3 }, minItems: 4 })).toEqual([]);
    expect(
      clusterTrips(
        [
          { ...near[0]!, latitude: NaN },
          { ...near[1]!, latitude: 200 },
        ],
        { minItems: 1 },
      ),
    ).toEqual([]);
    expect(clusterTrips([])).toEqual([]);
  });
  it('a gap over maxGapHours starts a new trip; within it continues', () => {
    const p = [
      it_('2026-02-10T09:00:00Z', 38.7, -9.1),
      it_('2026-02-11T20:00:00Z', 38.7, -9.1),
      it_('2026-02-13T09:00:00Z', 38.7, -9.1),
    ];
    const home0 = { latitude: 51.5, longitude: -0.12 };
    expect(clusterTrips(p, { home: home0, minItems: 2, maxGapHours: 36 })).toHaveLength(1); // 35h keeps the trip going; the 37h gap starts a group that is too small
  });
});

describe('recap', () => {
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  it('counts, date span, places and people', () => {
    const r = buildRecap(
      [
        { type: 'post', at: d('2026-06-12'), placeId: 'p1' },
        { type: 'post', at: d('2026-06-14'), placeId: 'p2' },
        { type: 'moment', at: d('2026-06-13'), placeId: 'p1' },
        { type: 'real_capture', at: null },
      ],
      { extraPlaceIds: ['p3'], peopleCount: 2 },
    );
    expect(r).toEqual({
      total: 4,
      counts: { post: 2, moment: 1, real_capture: 1 },
      dateStart: '2026-06-12',
      dateEnd: '2026-06-14',
      spanDays: 3,
      places: 3,
      people: 2,
    });
    expect(recapText(r)).toBe(
      '4 items from 2026-06-12 to 2026-06-14 (3 days): 2 posts, 1 moment, 1 Real. 3 places and 2 people.',
    );
  });
  it('handles empty, single-day and undated memories', () => {
    expect(buildRecap([])).toMatchObject({ total: 0, dateStart: null, spanDays: 0 });
    expect(recapText(buildRecap([]))).toBe('An empty memory.');
    expect(recapText(buildRecap([{ type: 'event', at: d('2026-01-01') }]))).toBe(
      '1 item on 2026-01-01: 1 event.',
    );
    expect(recapText(buildRecap([{ type: 'media', at: null }]))).toBe('1 item: 1 file.');
  });
  it('is deterministic', () => {
    const items = [
      { type: 'post', at: d('2026-06-12') },
      { type: 'moment', at: d('2026-06-12') },
    ];
    expect(buildRecap(items)).toEqual(buildRecap([...items].reverse()));
  });
});
