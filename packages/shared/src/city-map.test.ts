import { describe, expect, it } from 'vitest';
import {
  MAP_MAX_SPAN,
  byDistance,
  clampZoom,
  clusterItems,
  marketPoint,
  panBy,
  project,
  queryBox,
  screenPoint,
  tilesFor,
  tileUrl,
  unproject,
  viewBox,
  type MapItem,
} from './city-map.ts';

const LAGOS = { lat: 6.52437, lng: 3.37921 };
const item = (key: string, lat: number, lng: number): MapItem => ({
  key,
  layer: 'today',
  title: key,
  subtitle: null,
  point: { lat, lng },
  approximate: false,
  at: null,
  endsAt: null,
  thumbUrl: null,
  count: null,
  user: null,
  target: { kind: 'event', id: key },
});

describe('city map maths', () => {
  it('projects and comes back to the same point', () => {
    const p = project(LAGOS, 13);
    const back = unproject(p.x, p.y, 13);
    expect(back.lat).toBeCloseTo(LAGOS.lat, 9);
    expect(back.lng).toBeCloseTo(LAGOS.lng, 9);
  });

  it('puts the centre in the middle of the view, and moves the right way when dragged', () => {
    expect(screenPoint(LAGOS, LAGOS, 14, 800, 600)).toEqual({ x: 400, y: 300 });
    // Dragging to the right shows what's to the west.
    expect(panBy(LAGOS, 14, 100, 0).lng).toBeLessThan(LAGOS.lng);
    expect(panBy(LAGOS, 14, 0, 100).lat).toBeGreaterThan(LAGOS.lat);
  });

  it('covers the view with tiles and builds their addresses', () => {
    const tiles = tilesFor(LAGOS, 13, 800, 600);
    expect(tiles.length).toBeGreaterThanOrEqual(12);
    expect(tiles.every((t) => t.z === 13 && t.left > -256 && t.left < 800 && t.top > -256 && t.top < 600)).toBe(true);
    expect(tileUrl('https://t/{z}/{x}/{y}.png', { z: 13, x: 4172, y: 3955 })).toBe('https://t/13/4172/3955.png');
  });

  it('asks for at most MAP_MAX_SPAN each way, around the same centre', () => {
    const huge = viewBox(LAGOS, 8, 3000, 2000);
    const q = queryBox(huge);
    expect(q.north - q.south).toBeLessThanOrEqual(MAP_MAX_SPAN + 1e-9);
    expect(q.east - q.west).toBeLessThanOrEqual(MAP_MAX_SPAN + 1e-9);
    expect((q.north + q.south) / 2).toBeCloseTo((huge.north + huge.south) / 2, 4);
    const small = queryBox(viewBox(LAGOS, 15, 400, 300));
    expect(small.north - small.south).toBeLessThan(0.02);
  });

  it('groups pins close together on screen, and splits them when zoomed in', () => {
    const items = [item('a', 6.5244, 3.3792), item('b', 6.5245, 3.3793), item('c', 6.6, 3.45)];
    const far = clusterItems(items, LAGOS, 11, 800, 600);
    expect(far.find((c) => c.items.length === 2)).toBeDefined();
    const close = clusterItems(items, LAGOS, 18, 800, 600);
    expect(close.every((c) => c.items.length === 1)).toBe(true);
    // Off screen: no pin.
    expect(close.map((c) => c.items[0]!.key)).not.toContain('c');
  });

  it('keeps Market points on a coarse grid, the same however often', () => {
    const p = marketPoint({ lat: 6.51234, lng: 3.37891 });
    expect(marketPoint(p)).toEqual(p);
    expect(marketPoint({ lat: 6.5125, lng: 3.379 })).toEqual(p);
  });

  it('sorts nearest first and keeps zoom in range', () => {
    const items = [item('far', 6.6, 3.4), item('near', 6.525, 3.38)];
    expect(byDistance(items, LAGOS).map((i) => i.key)).toEqual(['near', 'far']);
    expect(clampZoom(3)).toBe(10);
    expect(clampZoom(25)).toBe(18);
  });
});
