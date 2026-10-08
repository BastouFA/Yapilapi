import { z } from 'zod';
import { MAP_LAYERS, MAP_MAX_SPAN, MAP_PRESENCE_DURATIONS } from './city-map.ts';

/** Near you requests, checked by the API (city-map.ts has the rest, without zod, for the phone). */

const offMap = 'That place isn’t on the map.';
const lat = z.coerce.number().finite().min(-90, offMap).max(90, offMap);
const lng = z.coerce.number().finite().min(-180, offMap).max(180, offMap);
/** An IANA time zone name ("Africa/Lagos"); one the server doesn't know counts as UTC. */
const timeZone = z.string().trim().max(64).optional();

/** GET /v1/map: what's in this box, for these layers (comma-separated; all of them when left out). */
export const mapQuerySchema = z
  .object({
    south: lat,
    west: lng,
    north: lat,
    east: lng,
    layers: z
      .string()
      .max(100)
      .optional()
      .transform((s) => (s ? [...new Set(s.split(',').map((x) => x.trim()))] : [...MAP_LAYERS]))
      .pipe(z.array(z.enum(MAP_LAYERS)).max(MAP_LAYERS.length)),
    /** The viewer's time zone, for what "today" means. */
    tz: timeZone,
  })
  .refine((b) => b.north > b.south && b.east > b.west, { message: offMap })
  .refine((b) => b.north - b.south <= MAP_MAX_SPAN + 1e-6 && b.east - b.west <= MAP_MAX_SPAN + 1e-6, { message: 'Zoom in to see what’s here.' });
export type MapQuery = z.output<typeof mapQuerySchema>;

/**
 * PUT /v1/map/presence: show me to my friends on the map, around here, for this long. Without
 * `duration` while it's on, only the point moves (the end stays); while it's off, it's for an hour.
 */
export const mapPresenceSchema = z.object({
  lat: z.number().finite().min(-90, offMap).max(90, offMap),
  lng: z.number().finite().min(-180, offMap).max(180, offMap),
  duration: z.enum(MAP_PRESENCE_DURATIONS).optional(),
  timeZone,
});
export type MapPresenceInput = z.input<typeof mapPresenceSchema>;
