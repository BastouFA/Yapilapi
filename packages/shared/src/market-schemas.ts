import { z } from 'zod';
import {
  MARKET_AREA_MAX,
  MARKET_CATEGORIES,
  MARKET_CONDITIONS,
  MARKET_DELIVERY,
  MARKET_DESCRIPTION_MAX,
  MARKET_MAX_PHOTOS,
  MARKET_PHOTO_ALT_MAX,
  MARKET_PRICE_MAX_CENTS,
  MARKET_RADII_KM,
  MARKET_RATING_TEXT_MAX,
  MARKET_TITLE_MAX,
} from './market.ts';

/** Market forms, checked by the API (market.ts has the rest, without zod, so the phone app can use it). */

const uuid = z.string().uuid();
const lat = z.number().finite().min(-90, 'That place isn’t on the map.').max(90, 'That place isn’t on the map.');
const lng = z.number().finite().min(-180, 'That place isn’t on the map.').max(180, 'That place isn’t on the map.');
/** A place, snapped to about a kilometre by the server whatever the app sent. */
const place = z.object({ lat, lng });
/** Hundredths of the currency; null for Free. */
const price = z
  .number()
  .int('Enter a price without fractions of the smallest unit.')
  .min(1, 'Enter a price, or choose Free.')
  .max(MARKET_PRICE_MAX_CENTS, 'That price is too high.')
  .nullable();
const amount = z.number().int().min(1, 'Enter an amount.').max(MARKET_PRICE_MAX_CENTS, 'That amount is too high.');

const photos = z
  .array(z.object({ mediaId: uuid, altText: z.string().trim().max(MARKET_PHOTO_ALT_MAX).optional() }))
  .min(1, 'Add at least one photo.')
  .max(MARKET_MAX_PHOTOS, `Add up to ${MARKET_MAX_PHOTOS} photos.`)
  .refine((list) => new Set(list.map((p) => p.mediaId)).size === list.length, 'Each photo can be added once.');

const delivery = z
  .array(z.enum(MARKET_DELIVERY))
  .min(1, 'Choose at least one way to hand it over.')
  .refine((list) => new Set(list).size === list.length, 'Each option can be chosen once.');

const fields = {
  title: z.string().trim().min(3, 'Give your listing a title.').max(MARKET_TITLE_MAX),
  description: z.string().trim().max(MARKET_DESCRIPTION_MAX).default(''),
  category: z.enum(MARKET_CATEGORIES),
  condition: z.enum(MARKET_CONDITIONS),
  priceCents: price,
  photos,
  area: z.string().trim().min(2, 'Say roughly where to pick it up, like a neighbourhood or town.').max(MARKET_AREA_MAX),
  /** Where it is, roughly. Leave it out and the listing shows by area only; null on an edit removes it. */
  place: place.nullable().optional(),
  delivery,
  /** The seller says it isn't something Market doesn't allow, after the check said it might be: it waits for a moderator. */
  notProhibited: z.boolean().optional(),
};

export const createListingSchema = z.object(fields);

export const updateListingSchema = z
  .object({
    title: fields.title.optional(),
    description: z.string().trim().max(MARKET_DESCRIPTION_MAX).optional(),
    category: fields.category.optional(),
    condition: fields.condition.optional(),
    priceCents: price.optional(),
    photos: photos.optional(),
    area: fields.area.optional(),
    place: fields.place,
    delivery: delivery.optional(),
    notProhibited: fields.notProhibited,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'notProhibited' && x !== undefined), { message: 'Change something first.' });

/** Mark a listing available, reserved (for one of the people who wrote to you, or nobody in particular) or sold (to one of them, or someone else). */
export const listingStatusSchema = z.object({
  status: z.enum(['available', 'reserved', 'sold']),
  buyerId: uuid.nullable().optional(),
});

/**
 * Looking for things. `near` is where you are (from the device, snapped to about a kilometre):
 * with it, listings within `radiusKm` come nearest first. Sent in the body, so a place never ends up
 * in a URL or a log. Without it, the newest listings in your country come first.
 */
export const marketSearchSchema = z
  .object({
    near: place.optional(),
    radiusKm: z
      .number()
      .int()
      .refine((r) => (MARKET_RADII_KM as readonly number[]).includes(r), 'Choose a distance from the list.')
      .optional(),
    q: z.string().trim().max(100).optional(),
    category: z.enum(MARKET_CATEGORIES).optional(),
    conditions: z.array(z.enum(MARKET_CONDITIONS)).max(MARKET_CONDITIONS.length).optional(),
    /** In hundredths of your own currency; listings in other currencies are left out when a price is set. */
    minPriceCents: z.number().int().min(0).max(MARKET_PRICE_MAX_CENTS).optional(),
    maxPriceCents: z.number().int().min(0).max(MARKET_PRICE_MAX_CENTS).optional(),
    freeOnly: z.boolean().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).default(24),
  })
  .refine((v) => v.minPriceCents === undefined || v.maxPriceCents === undefined || v.minPriceCents <= v.maxPriceCents, {
    message: 'The lowest price is above the highest.',
    path: ['maxPriceCents'],
  });

export const makeOfferSchema = z.object({ amountCents: amount });
export const counterOfferSchema = z.object({ amountCents: amount });

export const marketRatingSchema = z.object({
  stars: z.number().int().min(1, 'Choose 1 to 5 stars.').max(5, 'Choose 1 to 5 stars.'),
  body: z.string().trim().max(MARKET_RATING_TEXT_MAX).default(''),
});
