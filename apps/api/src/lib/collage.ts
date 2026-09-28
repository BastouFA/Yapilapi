import sharp, { type OverlayOptions } from 'sharp';
import { cellRect, collageBackgroundHex, collageLayout, COLLAGE_FRAME_COLOR, COLLAGE_SIZES, coverCrop, type CollageSpec } from '@yapilapi/shared';

/**
 * The collage renderer. Cells, gaps, corners, print edges and each photo's crop all come from
 * @yapilapi/shared (collage.ts), the same arithmetic the web and phone previews use, so what the
 * preview shows is what gets posted. Photos are read at full quality (upright, capped at
 * COLLAGE_SOURCE_EDGE on the long side) and the result is a JPEG with no metadata: sharp only
 * writes EXIF, GPS or ICC data when asked to, and it never is here.
 */

/** Each photo is scaled down to this long edge before it is cut: enough for a 3× zoom into a half-canvas cell. */
export const COLLAGE_SOURCE_EDGE = 4096;
/** Photos bigger than this (in pixels) are refused before they are decoded. */
export const COLLAGE_MAX_INPUT_PIXELS = 100_000_000;
/** One photo's stored file, and all of them together, can be up to this big. */
export const COLLAGE_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const COLLAGE_MAX_TOTAL_BYTES = 150 * 1024 * 1024;

/** A filled rounded rectangle: the print edge, or an opaque mask to cut a photo's corners. */
const roundedRect = (width: number, height: number, r: number, fill = '#fff') =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${r}" ry="${r}" fill="${fill}"/></svg>`,
  );

/**
 * Draw a collage. `read(i)` gives the stored file of the photo in cell i; photos are read one at a
 * time so nine large ones are never all in memory at once. Returns a JPEG the size of the shape.
 */
export async function renderCollage(spec: CollageSpec, read: (index: number) => Promise<Buffer>): Promise<{ data: Buffer; width: number; height: number }> {
  const layout = collageLayout(spec.layout);
  if (!layout || layout.cells.length !== spec.cells.length) throw new Error('The layout does not match the photos.');
  const { width, height } = COLLAGE_SIZES[spec.shape];
  const background = collageBackgroundHex(spec.background);
  const tiles: OverlayOptions[] = [];
  for (const [i, cell] of spec.cells.entries()) {
    const r = cellRect(layout, i, width, height, spec.gap, spec.radius);
    // Upright and capped; see-through parts (PNGs) take the background colour.
    const upright = await sharp(await read(i), { failOn: 'none', limitInputPixels: COLLAGE_MAX_INPUT_PIXELS })
      .autoOrient()
      .resize({ width: COLLAGE_SOURCE_EDGE, height: COLLAGE_SOURCE_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: iw, height: ih, channels } = upright.info;
    const crop = coverCrop(iw, ih, r.width, r.height, cell.focusX, cell.focusY, cell.zoom ?? 1);
    // The photo's corners are cut inside the print edge, so the edge keeps an even width all round.
    const inner = Math.max(0, r.radius - r.frame);
    let photo = sharp(upright.data, { raw: { width: iw, height: ih, channels } })
      .extract(crop)
      .resize(r.width, r.height, { fit: 'fill' });
    if (inner > 0) photo = photo.ensureAlpha().composite([{ input: roundedRect(r.width, r.height, inner), blend: 'dest-in' }]);
    const cut = await photo.png({ compressionLevel: 1 }).toBuffer();

    if (!r.frame && !r.rotate) {
      tiles.push({ input: cut, left: r.left, top: r.top });
      continue;
    }
    // Scrapbook: a white print edge round the photo, then the whole print turned about its centre.
    const pw = r.width + 2 * r.frame;
    const ph = r.height + 2 * r.frame;
    let print = await sharp(roundedRect(pw, ph, r.radius, COLLAGE_FRAME_COLOR))
      .composite([{ input: cut, left: r.frame, top: r.frame }])
      .png({ compressionLevel: 1 })
      .toBuffer();
    let size = { width: pw, height: ph };
    if (r.rotate) {
      const turned = await sharp(print)
        .rotate(r.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 1 })
        .toBuffer({ resolveWithObject: true });
      print = turned.data;
      size = { width: turned.info.width, height: turned.info.height };
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    tiles.push({
      input: print,
      left: Math.min(width - size.width, Math.max(0, Math.round(cx - size.width / 2))),
      top: Math.min(height - size.height, Math.max(0, Math.round(cy - size.height / 2))),
    });
  }
  const data = await sharp({ create: { width, height, channels: 3, background } })
    .composite(tiles)
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { data, width, height };
}

/** Keys in a fixed order, so a stored spec (jsonb reorders keys) compares equal to the one sent again. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
