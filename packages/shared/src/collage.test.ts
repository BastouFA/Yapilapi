import { describe, expect, it } from 'vitest';
import {
  cellRect,
  COLLAGE_BACKGROUNDS,
  COLLAGE_GAPS,
  COLLAGE_LAYOUTS,
  COLLAGE_MAX_PHOTOS,
  COLLAGE_MIN_PHOTOS,
  COLLAGE_RADII,
  COLLAGE_SHAPES,
  COLLAGE_SIZES,
  collageInk,
  collageLayoutsFor,
  coverBox,
  coverCrop,
  defaultCollage,
  dragFocus,
  swapCells,
  turnedBounds,
  withLayout,
} from './collage.ts';
import { collageSchema } from './collage-schemas.ts';
import { CATALOGS } from './i18n.ts';
import { contrastRatio } from './profile-style.ts';

const EPS = 1e-9;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('collage layouts', () => {
  it('has at least 10 layouts, and at least two for every number of photos from 2 to 9', () => {
    expect(COLLAGE_LAYOUTS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(COLLAGE_LAYOUTS.map((l) => l.id)).size).toBe(COLLAGE_LAYOUTS.length);
    for (let n = COLLAGE_MIN_PHOTOS; n <= COLLAGE_MAX_PHOTOS; n++) expect(collageLayoutsFor(n).length, `${n} photos`).toBeGreaterThanOrEqual(2);
    expect(COLLAGE_LAYOUTS.every((l) => l.cells.length >= COLLAGE_MIN_PHOTOS && l.cells.length <= COLLAGE_MAX_PHOTOS)).toBe(true);
    // Every layout has a name in the catalogue.
    for (const l of COLLAGE_LAYOUTS) expect(CATALOGS.en![l.name]).toBeTruthy();
  });

  for (const layout of COLLAGE_LAYOUTS) {
    it(`${layout.id}: every cell stays inside the canvas`, () => {
      for (const c of layout.cells) {
        expect(c.w).toBeGreaterThan(0);
        expect(c.h).toBeGreaterThan(0);
        expect(c.x).toBeGreaterThanOrEqual(-EPS);
        expect(c.y).toBeGreaterThanOrEqual(-EPS);
        expect(c.x + c.w).toBeLessThanOrEqual(1 + EPS);
        expect(c.y + c.h).toBeLessThanOrEqual(1 + EPS);
      }
      // Turned scrapbook photos, print edge included, stay on the canvas in every shape.
      for (const shape of COLLAGE_SHAPES) {
        const { width, height } = COLLAGE_SIZES[shape];
        layout.cells.forEach((_, i) => {
          const r = cellRect(layout, i, width, height, 'wide', 'round');
          const b = turnedBounds({
            left: r.left - r.frame,
            top: r.top - r.frame,
            width: r.width + 2 * r.frame,
            height: r.height + 2 * r.frame,
            rotate: r.rotate,
          });
          expect(b.left, `${shape} cell ${i}`).toBeGreaterThanOrEqual(0);
          expect(b.top, `${shape} cell ${i}`).toBeGreaterThanOrEqual(0);
          expect(b.right, `${shape} cell ${i}`).toBeLessThanOrEqual(width);
          expect(b.bottom, `${shape} cell ${i}`).toBeLessThanOrEqual(height);
        });
      }
    });

    if (!layout.scrapbook)
      it(`${layout.id}: cells don't overlap, aren't turned and fill the canvas`, () => {
        const cells = layout.cells;
        for (let i = 0; i < cells.length; i++) {
          expect(cells[i]!.rotate ?? 0).toBe(0);
          for (let j = i + 1; j < cells.length; j++) {
            const a = cells[i]!;
            const b = cells[j]!;
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            expect(ox <= EPS || oy <= EPS, `cells ${i} and ${j}`).toBe(true);
          }
        }
        expect(cells.reduce((n, c) => n + c.w * c.h, 0)).toBeCloseTo(1, 9);
        // In pixels too, with gaps: no two photos touch.
        for (const gap of COLLAGE_GAPS)
          for (const shape of COLLAGE_SHAPES) {
            const { width, height } = COLLAGE_SIZES[shape];
            const rects = cells.map((_, i) => cellRect(layout, i, width, height, gap, 'none'));
            for (let i = 0; i < rects.length; i++)
              for (let j = i + 1; j < rects.length; j++) {
                const a = rects[i]!;
                const b = rects[j]!;
                const ox = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
                const oy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
                expect(ox <= 0 || oy <= 0, `${gap} ${shape} ${i}/${j}`).toBe(true);
              }
          }
      });
  }

  it('scrapbook layouts turn their photos a little and have a print edge', () => {
    const books = COLLAGE_LAYOUTS.filter((l) => l.scrapbook);
    expect(books).toHaveLength(COLLAGE_MAX_PHOTOS - COLLAGE_MIN_PHOTOS + 1);
    for (const l of books) {
      expect(l.cells.every((c) => c.rotate && Math.abs(c.rotate) <= 5)).toBe(true);
      expect(cellRect(l, 0, 1000, 1000, 'wide', 'none').frame).toBeGreaterThan(0);
    }
  });

  it('puts the same gap between photos as around the edge', () => {
    const [layout] = collageLayoutsFor(2).filter((l) => l.id === 'side-by-side');
    const a = cellRect(layout!, 0, 1000, 1000, 'wide', 'none');
    const b = cellRect(layout!, 1, 1000, 1000, 'wide', 'none');
    expect(a.left).toBe(35);
    expect(b.left - (a.left + a.width)).toBe(35);
    expect(1000 - (b.left + b.width)).toBe(35);
    expect(cellRect(layout!, 0, 1000, 1000, 'none', 'none')).toMatchObject({ left: 0, top: 0, width: 500, height: 1000, radius: 0, frame: 0 });
    // Rounding never goes past half the photo.
    expect(cellRect(layout!, 0, 1000, 100, 'none', 'round').radius).toBeLessThanOrEqual(50);
  });
});

describe('fitting a photo in a cell', () => {
  it('covers the cell and lines the focus point up like object-position', () => {
    // A wide photo in a square cell: height fits, the sides are cut.
    expect(coverBox(2000, 1000, 500, 500, 0.5, 0.5)).toMatchObject({ width: 1000, height: 500, left: -250, top: 0 });
    expect(coverBox(2000, 1000, 500, 500, 0, 0.5).left).toBeCloseTo(0);
    expect(coverBox(2000, 1000, 500, 500, 1, 0.5).left).toBe(-500);
    // Zoom is capped.
    expect(coverBox(1000, 1000, 100, 100, 0.5, 0.5, 10).width).toBeCloseTo(300);
    // The same cut in the photo's own pixels.
    expect(coverCrop(2000, 1000, 500, 500, 1, 0.5)).toEqual({ left: 1000, top: 0, width: 1000, height: 1000 });
    expect(coverCrop(2000, 1000, 500, 500, 0.5, 0.5, 2)).toEqual({ left: 750, top: 250, width: 500, height: 500 });
  });

  it('moves the focus the opposite way to a drag, within the photo', () => {
    const image = { width: 2000, height: 1000 };
    const box = { width: 500, height: 500 };
    // 500 spare pixels across: dragging 250 to the right shows the left half.
    expect(dragFocus({ x: 0.5, y: 0.5 }, 250, 0, image, box)).toEqual({ x: 0, y: 0.5 });
    expect(dragFocus({ x: 0.5, y: 0.5 }, -1000, 0, image, box)).toEqual({ x: 1, y: 0.5 });
    // Nothing spare up and down: the vertical focus stays.
    expect(dragFocus({ x: 0.5, y: 0.2 }, 0, 80, image, box).y).toBe(0.2);
  });
});

describe('editing a collage', () => {
  it('starts from the first layout for the number of photos, swaps photos and changes layout', () => {
    const spec = defaultCollage([id(1), id(2), id(3)])!;
    expect(spec).toMatchObject({ layout: collageLayoutsFor(3)[0]!.id, shape: 'square', gap: 'thin', radius: 'none', background: 'white' });
    const swapped = swapCells({ ...spec, cells: spec.cells.map((c, i) => ({ ...c, focusX: i / 10 })) }, 0, 2);
    expect(swapped.cells.map((c) => c.mediaId)).toEqual([id(3), id(2), id(1)]);
    expect(swapped.cells[0]!.focusX).toBe(0.2);
    expect(withLayout(spec, 'scrapbook-3').layout).toBe('scrapbook-3');
    // A layout for another number of photos is ignored.
    expect(withLayout(spec, 'grid-4').layout).toBe(spec.layout);
    expect(defaultCollage([id(1)])).toBeNull();
  });
});

describe('backgrounds', () => {
  it('have an ink colour that reads on them at 4.5:1 or more', () => {
    for (const b of COLLAGE_BACKGROUNDS) expect(contrastRatio(b.hex, collageInk(b.id)), b.id).toBeGreaterThanOrEqual(4.5);
    expect(collageInk('white')).toBe('#000000');
    expect(collageInk('black')).toBe('#FFFFFF');
  });
});

describe('collage request', () => {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ mediaId: id(i + 1) }));

  it('fills in the defaults', () => {
    const v = collageSchema.parse({ clientKey: 'abcdefgh12', layout: 'grid-4', cells: cells(4) });
    expect(v).toMatchObject({ shape: 'square', gap: 'thin', radius: 'none', background: 'white' });
    expect(v.cells[0]).toEqual({ mediaId: id(1), focusX: 0.5, focusY: 0.5, zoom: 1 });
  });

  it('refuses layouts, shapes, colours and cells that do not fit', () => {
    const ok = { clientKey: 'abcdefgh12', layout: 'grid-4', cells: cells(4) };
    expect(collageSchema.safeParse({ ...ok, layout: 'grid-5' }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, cells: cells(3) }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, layout: 'grid-9', cells: cells(10) }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, cells: [...cells(3), { mediaId: id(1) }] }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, shape: 'landscape' }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, background: '#ff0000' }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, gap: 'huge' }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, cells: [{ mediaId: id(1), focusX: 1.5 }, ...cells(4).slice(1)] }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, cells: [{ mediaId: id(1), zoom: 4 }, ...cells(4).slice(1)] }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, clientKey: 'short' }).success).toBe(false);
    expect(collageSchema.safeParse({ ...ok, clientKey: 'has spaces in it' }).success).toBe(false);
    expect(collageSchema.safeParse(ok).success).toBe(true);
  });
});
