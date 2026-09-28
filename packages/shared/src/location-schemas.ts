import { z } from 'zod';
import { LOCATION_DURATIONS, LOCATION_PRECISIONS } from './location.ts';

/** Location sharing forms, checked by the API (location.ts has the rest, without zod, so the phone app can use it). */

const lat = z.number().finite().min(-90, 'That place isn’t on the map.').max(90, 'That place isn’t on the map.');
const lng = z.number().finite().min(-180, 'That place isn’t on the map.').max(180, 'That place isn’t on the map.');
/** Metres; a device that can't say leaves it out. */
const accuracy = z.number().finite().min(0).max(100_000).optional();

/**
 * Start sharing where you are with a chat, or send it once. A live share runs for one of
 * LOCATION_DURATIONS (minutes); `point` is where you are now.
 */
export const startLocationSchema = z
  .object({
    mode: z.enum(['live', 'once']),
    minutes: z
      .number()
      .int()
      .refine((m) => (LOCATION_DURATIONS as readonly number[]).includes(m), 'Choose 15 minutes, 1 hour or 8 hours.')
      .optional(),
    precision: z.enum(LOCATION_PRECISIONS).default('precise'),
    lat,
    lng,
    accuracy,
    clientId: z.string().max(64).optional(),
  })
  .refine((v) => v.mode === 'once' || v.minutes !== undefined, { message: 'Choose 15 minutes, 1 hour or 8 hours.', path: ['minutes'] });

/** A new point on your live share (at most one every LOCATION_UPDATE_SECONDS). */
export const locationPointSchema = z.object({ lat, lng, accuracy });
