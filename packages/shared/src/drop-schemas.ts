import { z } from 'zod';
import { DROP_COVER_ALT_MAX, DROP_DESCRIPTION_MAX, DROP_MAX_ITEMS, DROP_MAX_PER_BUYER, DROP_MAX_QUANTITY, DROP_TITLE_MAX } from './drops.ts';

/** Drop forms, checked by the API (drops.ts has the rest, without zod, so the phone app can use it). */

const uuid = z.string().uuid();
const when = z.string().datetime({ offset: true, message: 'Choose a date and time.' });

export const dropItemInputSchema = z.object({
  productId: uuid,
  quantity: z.number().int().min(1).max(DROP_MAX_QUANTITY).nullable().optional(),
  perBuyerLimit: z.number().int().min(1).max(DROP_MAX_PER_BUYER).nullable().optional(),
});

const items = z
  .array(dropItemInputSchema)
  .min(1, 'Add at least one product.')
  .max(DROP_MAX_ITEMS, `A drop can have up to ${DROP_MAX_ITEMS} products.`)
  .refine((list) => new Set(list.map((i) => i.productId)).size === list.length, 'Each product can be added once.');

export const createDropSchema = z.object({
  title: z.string().trim().min(1, 'Give your drop a name.').max(DROP_TITLE_MAX),
  description: z.string().trim().max(DROP_DESCRIPTION_MAX).default(''),
  startsAt: when,
  endsAt: when.nullable().optional(),
  items,
});

export const updateDropSchema = z
  .object({
    title: z.string().trim().min(1, 'Give your drop a name.').max(DROP_TITLE_MAX).optional(),
    description: z.string().trim().max(DROP_DESCRIPTION_MAX).optional(),
    startsAt: when.optional(),
    endsAt: when.nullable().optional(),
    items: items.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change something first.' });

export const dropCoverSchema = z.object({ mediaId: uuid, altText: z.string().trim().max(DROP_COVER_ALT_MAX).optional() });
