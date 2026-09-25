import { createHash } from 'node:crypto';
import { haversineKm } from '../../lib/geo.js';

/**
 * Trip grouping heuristic (pure, unit tested). Input: geotagged items of ONE person. Output: candidate trips the person may turn into a memory.
 *
 * 1. Home = the ~50 km grid cell in which the person has items on the most distinct days (home is where life happens on many different days;
 *    a trip is a burst elsewhere), positioned at the mean of that cell's points.
 * 2. "Away" items are those more than `awayKm` (default 50) from home.
 * 3. Away items are grouped in time order; a gap longer than `maxGapHours` (default 36) starts a new trip.
 * 4. A group becomes a trip when it has at least `minItems` (default 3) items. A trip has no fixed length: a weekend and a month both qualify.
 *
 * Deterministic: same input, same output; the `key` is a hash of the member items so it stays stable when the person adds unrelated items.
 */
export interface GeoItem {
  type: string;
  id: string;
  at: Date;
  latitude: number;
  longitude: number;
}
export interface TripCandidate {
  key: string;
  startAt: Date;
  endAt: Date;
  items: Array<{ type: string; id: string }>;
  centroid: { latitude: number; longitude: number };
  distinctDays: number;
  maxDistanceFromHomeKm: number;
}
export interface TripOptions {
  awayKm?: number;
  maxGapHours?: number;
  minItems?: number;
  home?: { latitude: number; longitude: number } | undefined;
}

const CELL_DEG = 0.5;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function inferHome(items: GeoItem[]): { latitude: number; longitude: number } | null {
  if (!items.length) return null;
  const cells = new Map<string, { days: Set<string>; pts: GeoItem[] }>();
  for (const it of items) {
    const k = `${Math.floor(it.latitude / CELL_DEG)}:${Math.floor(it.longitude / CELL_DEG)}`;
    const c = cells.get(k) ?? { days: new Set<string>(), pts: [] };
    c.days.add(dayKey(it.at));
    c.pts.push(it);
    cells.set(k, c);
  }
  // Most distinct days wins; ties go to more items, then the lexicographically smaller cell (determinism).
  const best = [...cells.entries()].sort(
    (a, b) =>
      b[1].days.size - a[1].days.size ||
      b[1].pts.length - a[1].pts.length ||
      (a[0] < b[0] ? -1 : 1),
  )[0]![1];
  return {
    latitude: mean(best.pts.map((p) => p.latitude)),
    longitude: mean(best.pts.map((p) => p.longitude)),
  };
}

export const tripKey = (items: Array<{ type: string; id: string }>): string =>
  createHash('sha256')
    .update(
      items
        .map((i) => `${i.type}:${i.id}`)
        .sort()
        .join('|'),
    )
    .digest('hex')
    .slice(0, 24);

export function clusterTrips(all: GeoItem[], opts: TripOptions = {}): TripCandidate[] {
  const awayKm = opts.awayKm ?? 50;
  const gapMs = (opts.maxGapHours ?? 36) * 3_600_000;
  const minItems = opts.minItems ?? 3;
  const valid = all.filter(
    (i) =>
      Number.isFinite(i.latitude) &&
      Number.isFinite(i.longitude) &&
      Math.abs(i.latitude) <= 90 &&
      Math.abs(i.longitude) <= 180 &&
      !Number.isNaN(i.at.getTime()),
  );
  if (!valid.length) return [];
  const home = opts.home ?? inferHome(valid)!;
  const dist = (i: GeoItem) => haversineKm(home.latitude, home.longitude, i.latitude, i.longitude);
  const away = valid
    .filter((i) => dist(i) > awayKm)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));

  const groups: GeoItem[][] = [];
  for (const it of away) {
    const g = groups[groups.length - 1];
    if (g && it.at.getTime() - g[g.length - 1]!.at.getTime() <= gapMs) g.push(it);
    else groups.push([it]);
  }
  return groups
    .filter((g) => g.length >= minItems)
    .map((g) => ({
      key: tripKey(g),
      startAt: g[0]!.at,
      endAt: g[g.length - 1]!.at,
      items: g.map((i) => ({ type: i.type, id: i.id })),
      centroid: {
        latitude: mean(g.map((i) => i.latitude)),
        longitude: mean(g.map((i) => i.longitude)),
      },
      distinctDays: new Set(g.map((i) => dayKey(i.at))).size,
      maxDistanceFromHomeKm: Math.round(Math.max(...g.map(dist))),
    }));
}
