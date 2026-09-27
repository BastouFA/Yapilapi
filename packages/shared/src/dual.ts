import { z } from 'zod';

/**
 * "Both sides" photos: a back camera photo with the front camera photo in a rounded corner.
 * The web camera draws it in the browser and the API draws it with sharp, both from this layout,
 * so what the preview shows is what gets posted.
 */
export const DUAL_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type DualCorner = (typeof DUAL_CORNERS)[number];

/** Front photo width as a share of the picture's width; margin as a share of the picture's width; radius and border as shares of the small photo's width. */
export const DUAL_LAYOUT = { width: 0.3, margin: 0.04, radius: 0.12, border: 0.02 } as const;

export const dualComposeSchema = z.object({
  /** The back camera photo (the big one). */
  backId: z.string().uuid(),
  /** The front camera photo (the small one in the corner). */
  frontId: z.string().uuid(),
  corner: z.enum(DUAL_CORNERS).default('top-left'),
});
export type DualComposeInput = z.input<typeof dualComposeSchema>;

/** Where the small photo goes on a picture of `width` × `height`, for a front photo of `frontWidth` × `frontHeight`. */
export function dualInsetBox(width: number, height: number, frontWidth: number, frontHeight: number, corner: DualCorner) {
  const w = Math.max(8, Math.round(width * DUAL_LAYOUT.width));
  const h = Math.max(8, Math.min(Math.round(height * 0.6), Math.round((w * frontHeight) / Math.max(1, frontWidth))));
  const margin = Math.round(width * DUAL_LAYOUT.margin);
  const left = corner.endsWith('left') ? margin : width - margin - w;
  const top = corner.startsWith('top') ? margin : height - margin - h;
  return { left, top, width: w, height: h, radius: Math.round(w * DUAL_LAYOUT.radius), border: Math.max(1, Math.round(w * DUAL_LAYOUT.border)) };
}

/** The corner nearest a point on the picture (0–1 from the left and the top), for dragging the small photo. */
export const nearestDualCorner = (x: number, y: number): DualCorner => `${y < 0.5 ? 'top' : 'bottom'}-${x < 0.5 ? 'left' : 'right'}`;
