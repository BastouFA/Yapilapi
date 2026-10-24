import { z } from 'zod';
import {
  LAUNCH_CITIES,
  STASH_AUDIENCES,
  STASH_DURATIONS,
  STASH_GIFT_MAX,
  STASH_HINT_MAX,
  STASH_KINDS,
  STASH_REACTIONS,
  STASH_TEXT_MAX,
  STASH_THANKS_MAX,
  STASH_TITLE_MAX,
} from './stash.ts';

/** Stash requests, checked by the API (stash.ts has the rest, without zod, for the phone). */

const offMap = 'That place isn’t on the map.';
const lat = z.number().finite().min(-90, offMap).max(90, offMap);
const lng = z.number().finite().min(-180, offMap).max(180, offMap);

/** Where the device is now, and how sure it is (metres). The API refuses one less accurate than STASH_MAX_ACCURACY. */
export const stashPositionSchema = z.object({ lat, lng, accuracy: z.number().finite().min(0).max(100_000) });
export type StashPosition = z.input<typeof stashPositionSchema>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => s || undefined);

const stashBody = {
  kind: z.enum(STASH_KINDS),
  title: optionalText(STASH_TITLE_MAX),
  hint: optionalText(STASH_HINT_MAX),
  /** A note's words, or the line that goes with the rest. */
  body: optionalText(STASH_TEXT_MAX),
  /** A gift: revealed on opening. */
  giftCode: optionalText(STASH_GIFT_MAX),
  /** A photo or video you uploaded (POST /v1/media), once it's processed. */
  mediaId: z.string().uuid().optional(),
  /** A voice note: a clip recorded for a Yap (POST /v1/voice). */
  voiceId: z.string().uuid().optional(),
  /** A song from the music picker: a library sound or a catalogue song, and the part that plays. */
  music: z
    .object({
      soundId: z.string().uuid().optional(),
      trackId: z.string().uuid().optional(),
      startMs: z.number().int().min(0).max(3_600_000).default(0),
      durationMs: z.number().int().min(5_000).max(30_000).default(15_000),
    })
    .refine((m) => !!m.soundId !== !!m.trackId, { message: 'Choose a song.' })
    .optional(),
  audience: z.enum(STASH_AUDIENCES),
  /** `person`: who it's for. */
  recipientId: z.string().uuid().optional(),
  /** `squad`: which one. */
  squadId: z.string().uuid().optional(),
  duration: z.enum(STASH_DURATIONS),
  /** Only the first person to find it can open it. */
  firstOnly: z.boolean().default(false),
};

const contentOk = (s: { kind: string; body?: string; giftCode?: string; mediaId?: string; voiceId?: string; music?: unknown }) =>
  s.kind === 'text'
    ? !!s.body
    : s.kind === 'gift'
      ? !!s.giftCode
      : s.kind === 'photo' || s.kind === 'video'
        ? !!s.mediaId
        : s.kind === 'voice'
          ? !!s.voiceId
          : !!s.music;

/**
 * POST /v1/stashes: hide a stash here (`position`: where the device is now). What goes in depends
 * on `kind`; who can open it on `audience`.
 */
export const hideStashSchema = z
  .object({ ...stashBody, position: stashPositionSchema })
  .refine(contentOk, { message: 'Add what goes in the stash.', path: ['body'] })
  .refine((s) => s.audience !== 'person' || !!s.recipientId, { message: 'Choose who it’s for.', path: ['recipientId'] })
  .refine((s) => s.audience !== 'squad' || !!s.squadId, { message: 'Choose a squad.', path: ['squadId'] });
export type HideStashInput = z.input<typeof hideStashSchema>;

/** POST /v1/admin/stashes: the team hides a launch stash for everyone at a chosen point (seed mode). */
export const seedStashSchema = z
  .object({ ...stashBody, audience: z.literal('everyone').default('everyone'), point: z.object({ lat, lng }) })
  .refine(contentOk, { message: 'Add what goes in the stash.', path: ['body'] });
export type SeedStashInput = z.input<typeof seedStashSchema>;

/** POST /v1/stashes/:id/open: try to open it from here. */
export const openStashSchema = stashPositionSchema;

/** GET /v1/stashes/near: around a point (yours, or the map's middle), nearest first. */
export const stashNearSchema = z.object({
  lat: z.coerce.number().finite().min(-90, offMap).max(90, offMap),
  lng: z.coerce.number().finite().min(-180, offMap).max(180, offMap),
});

/** POST /v1/stashes/:id/thanks: one of the quick thank-yous, a few words, or both. */
export const stashThanksSchema = z
  .object({ reaction: z.enum(STASH_REACTIONS).optional(), text: optionalText(STASH_THANKS_MAX) })
  .refine((x) => x.reaction || x.text, { message: 'Choose a thank-you or write one.', path: ['text'] });
export type StashThanksInput = z.input<typeof stashThanksSchema>;

/** GET /v1/stashes/explorers: this month's top explorers in a launch city. */
export const stashExplorersSchema = z.object({ city: z.enum(LAUNCH_CITIES.map((c) => c.key) as [string, ...string[]]) });

/** PUT /v1/me/stash-settings. */
export const stashSettingsSchema = z.object({ showCounts: z.boolean(), explorerLists: z.boolean(), nearbyNotify: z.boolean() }).partial();
export type StashSettingsInput = z.input<typeof stashSettingsSchema>;
