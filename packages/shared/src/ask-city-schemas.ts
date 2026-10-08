import { z } from 'zod';
import { ASK_EXPIRIES, ASK_TEXT_MAX, ASK_TOPICS } from './ask-city.ts';
import { MAP_MAX_SPAN } from './city-map.ts';

/** Ask the city requests, checked by the API (ask-city.ts has the rest, without zod, for the phone). */

const offMap = 'That place isn’t on the map.';
const box = z
  .object({
    south: z.coerce.number().finite().min(-90, offMap).max(90, offMap),
    west: z.coerce.number().finite().min(-180, offMap).max(180, offMap),
    north: z.coerce.number().finite().min(-90, offMap).max(90, offMap),
    east: z.coerce.number().finite().min(-180, offMap).max(180, offMap),
  })
  .refine((b) => b.north > b.south && b.east > b.west, { message: offMap })
  .refine((b) => b.north - b.south <= MAP_MAX_SPAN + 1e-6 && b.east - b.west <= MAP_MAX_SPAN + 1e-6, { message: 'Zoom in to see what’s here.' });
const city = z.string().trim().min(1).max(60);

/**
 * POST /v1/ask: a question, spoken (`voiceId`, a clip recorded for a Yap) or written (`body`), about
 * an area: a place page, a city, or a city with the part of the map on screen. Never where the
 * asker is. `expires` left out: a traffic question closes after an hour, others stay open.
 */
export const askCitySchema = z
  .object({
    body: z.string().trim().max(ASK_TEXT_MAX).default(''),
    voiceId: z.string().uuid().optional(),
    topic: z.enum(ASK_TOPICS),
    area: z
      .object({ placeId: z.string().uuid().optional(), city: city.optional(), box: box.optional() })
      .refine((a) => a.placeId || a.city || a.box, { message: 'Choose a place or a city for your question.' }),
    /** `null`: no end (open for ASK_OPEN_DAYS). */
    expires: z.enum(ASK_EXPIRIES).nullable().optional(),
    /** The asker's time zone, for when "today" ends. */
    timeZone: z.string().trim().max(64).optional(),
  })
  .refine((q) => q.voiceId || q.body.length > 0, { message: 'Say or write your question.', path: ['body'] });
export type AskCityInput = z.input<typeof askCitySchema>;

/**
 * GET /v1/ask: open questions in a city (or the profile's), or with their area in a box on the
 * map, newest first with those still waiting for an answer before them.
 */
export const askListSchema = z.object({
  city: city.optional(),
  south: z.coerce.number().finite().min(-90).max(90).optional(),
  west: z.coerce.number().finite().min(-180).max(180).optional(),
  north: z.coerce.number().finite().min(-90).max(90).optional(),
  east: z.coerce.number().finite().min(-180).max(180).optional(),
  topic: z.enum(ASK_TOPICS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** PUT /v1/me/ask-settings: "Help answer questions near me". `city` left out keeps the one chosen (or the profile's). */
export const askHelperSchema = z.object({
  on: z.boolean(),
  city: city.nullable().optional(),
  topics: z.array(z.enum(ASK_TOPICS)).min(1).max(ASK_TOPICS.length).optional(),
});
export type AskHelperInput = z.input<typeof askHelperSchema>;
