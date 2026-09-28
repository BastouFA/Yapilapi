import { z } from 'zod';
import {
  COLLAGE_BACKGROUND_IDS,
  COLLAGE_DEFAULTS,
  COLLAGE_GAPS,
  COLLAGE_LAYOUT_IDS,
  COLLAGE_MAX_PHOTOS,
  COLLAGE_MAX_ZOOM,
  COLLAGE_MIN_PHOTOS,
  COLLAGE_RADII,
  COLLAGE_SHAPES,
  collageLayout,
} from './collage.ts';

/** The collage request, checked by the API (collage.ts has the rest, without zod, so the phone app can use it). */

const share = z.number().finite().min(0).max(1);

export const collageCellSchema = z.object({
  mediaId: z.string().uuid(),
  focusX: share.default(0.5),
  focusY: share.default(0.5),
  zoom: z.number().finite().min(1).max(COLLAGE_MAX_ZOOM).default(1),
});

export const collageSchema = z
  .object({
    /**
     * Made by the app once per "Use collage" tap and sent again on a retry: the same key gives back the
     * same collage instead of making a second one.
     */
    clientKey: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, dashes and underscores.'),
    layout: z.enum(COLLAGE_LAYOUT_IDS),
    shape: z.enum(COLLAGE_SHAPES).default('square'),
    gap: z.enum(COLLAGE_GAPS).default(COLLAGE_DEFAULTS.gap),
    radius: z.enum(COLLAGE_RADII).default(COLLAGE_DEFAULTS.radius),
    background: z.enum(COLLAGE_BACKGROUND_IDS).default(COLLAGE_DEFAULTS.background),
    cells: z
      .array(collageCellSchema)
      .min(COLLAGE_MIN_PHOTOS, `Choose at least ${COLLAGE_MIN_PHOTOS} photos.`)
      .max(COLLAGE_MAX_PHOTOS, `A collage can have up to ${COLLAGE_MAX_PHOTOS} photos.`)
      .refine((cells) => new Set(cells.map((c) => c.mediaId)).size === cells.length, 'Use each photo once.'),
    altText: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    const layout = collageLayout(v.layout);
    if (layout && layout.cells.length !== v.cells.length)
      ctx.addIssue({ code: 'custom', path: ['cells'], message: `This layout takes ${layout.cells.length} photos.` });
  });
export type CollageInput = z.input<typeof collageSchema>;
