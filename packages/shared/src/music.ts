import { z } from 'zod';

/**
 * Music from the catalogue: in-app sounds (original audio people made) and songs from outside
 * providers. Every song carries the licence it came with, and a song is only offered, attached or
 * played where that licence allows it: personal or business use, the country, and how long a part.
 */

/** Where a song comes from. 'library' is the in-app sounds; the others are catalogue providers. */
export const MUSIC_SOURCES = ['library', 'jamendo', 'licensed', 'dev'] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];

/** The picker's tabs. */
export const MUSIC_TABS = ['for_you', 'trending', 'saved', 'original'] as const;
export type MusicTab = (typeof MUSIC_TABS)[number];

/** A post or a reel plays a part of 5 to 30 seconds (a story up to 15: STORY_MUSIC_MAX_MS). */
export const MUSIC_CLIP_MIN_MS = 5_000;
export const MUSIC_CLIP_MAX_MS = 30_000;
export const MUSIC_CLIP_DEFAULT_MS = 15_000;

/** What a provider's licence lets people do with a song here. */
export interface MusicLicence {
  /** "CC BY 4.0", "Original sound", or the partner's licence name. */
  name: string;
  /** The licence text, when there is one to link to. */
  url: string | null;
  /** Business accounts may use it (posts that promote something). */
  commercialUse: boolean;
  /** Countries (ISO 3166-1 alpha-2) where it may be used and played; null for everywhere. */
  regions: string[] | null;
  /** Countries where it may not, even when `regions` is null. */
  excludedRegions: string[];
  /** The longest part a post, reel or story may play. */
  maxClipSeconds: number;
  /** The credit the licence asks for, shown wherever the song plays. */
  attribution: string | null;
  /** After this time it may no longer be used or played. */
  expiresAt: string | null;
  /** Whether the licence lets us keep a copy of the audio (we still only keep a reference). */
  cacheAllowed: boolean;
}

/** Why a song can't be used (or played) here. 'unavailable': its provider is switched off here for now. */
export type MusicBlock = 'commercial' | 'region' | 'clip' | 'expired' | 'withdrawn' | 'unavailable';

/**
 * Check one use of a song against its licence. `countries` are the ones known for the person
 * (chosen, and reported by the network): each must be allowed. When a song is limited to some
 * countries and none is known, it isn't allowed: we can't show it is.
 */
export function licenceBlock(
  licence: MusicLicence,
  use: { commercial: boolean; countries: (string | null | undefined)[]; clipMs?: number; now?: Date },
): MusicBlock | null {
  const now = use.now ?? new Date();
  if (licence.expiresAt && new Date(licence.expiresAt).getTime() <= now.getTime()) return 'expired';
  if (use.commercial && !licence.commercialUse) return 'commercial';
  const countries = [...new Set(use.countries.filter((c): c is string => !!c && /^[A-Z]{2}$/.test(c)))];
  if (countries.some((c) => licence.excludedRegions.includes(c))) return 'region';
  if (licence.regions) {
    if (!countries.length) return 'region';
    if (countries.some((c) => !licence.regions!.includes(c))) return 'region';
  }
  if (use.clipMs !== undefined && use.clipMs > licence.maxClipSeconds * 1000) return 'clip';
  return null;
}

/** The longest part a song may play in a post or reel (`max`), or a story (pass STORY_MUSIC_MAX_MS). */
export const maxClipMs = (licence: Pick<MusicLicence, 'maxClipSeconds'>, max = MUSIC_CLIP_MAX_MS) =>
  Math.max(MUSIC_CLIP_MIN_MS, Math.min(max, licence.maxClipSeconds * 1000));

/** The credit line in English, as the API gives it: "Title by Artist · CC BY 4.0". Apps build it in the reader's language. */
export const musicCredit = (t: { title: string; artist: string; licenceName: string }) => `${t.title} by ${t.artist} · ${t.licenceName}`;

/** A song or sound in the music picker, and on its page. */
export interface MusicTrack {
  source: MusicSource;
  /** A sound's id ('library') or a catalogue song's id. */
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  coverUrl: string | null;
  /** Plays the song for choosing the part (players play only the part they need). */
  previewUrl: string | null;
  licence: MusicLicence;
  /** "Title by Artist · CC BY 4.0". */
  attribution: string;
  /** The longest part it may play in a post or reel. */
  maxClipMs: number;
  /** Posts, reels and stories using it. */
  uses: number;
  saved: boolean;
  /** Whether you may use it now (your account type and country, and whether it is still offered). */
  canUse: boolean;
  blocked?: MusicBlock;
}

/** A catalogue provider, as the picker lists them. */
export interface MusicSourceInfo {
  id: MusicSource;
  /** "Original sounds", "Jamendo", or the partner's name. */
  label: string;
  kind: 'original' | 'creative_commons' | 'licensed' | 'dev';
  enabled: boolean;
}

/** Why music on a post or story doesn't play for this viewer. */
export type MusicUnavailable = 'region' | 'withdrawn' | 'unavailable';

/** Music on a post (photo, carousel, text) or a reel, as a viewer gets it. */
export interface PostMusic {
  source: MusicSource;
  /** Opens the sound's page ('library') or the song's page. */
  id: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  /** Null when it can't play here (see `unavailable`). */
  audioUrl: string | null;
  startMs: number;
  durationMs: number;
  style: 'compact';
  licenceName: string | null;
  licenceUrl: string | null;
  /** "Title by Artist · CC BY 4.0" for catalogue songs. */
  attribution: string | null;
  unavailable?: MusicUnavailable;
}

const startMs = z
  .number()
  .int()
  .min(0)
  .max(60 * 60 * 1000);

/** Music added to a post or a reel: a sound or a catalogue song, and the part that plays. */
export const postMusicInputSchema = z
  .object({
    soundId: z.string().uuid().optional(),
    trackId: z.string().uuid().optional(),
    /** Where the part starts in the song. */
    startMs,
    durationMs: z.number().int().min(MUSIC_CLIP_MIN_MS).max(MUSIC_CLIP_MAX_MS).default(MUSIC_CLIP_DEFAULT_MS),
    style: z.literal('compact').default('compact'),
  })
  .refine((m) => !!m.soundId !== !!m.trackId, { message: 'Choose a sound or a song.', path: ['trackId'] });
export type PostMusicInput = z.input<typeof postMusicInputSchema>;

/** A stable, made-up waveform for a song (the picker's scrubber): `n` bar heights between 0.2 and 1. */
export function waveformBars(seed: string, n = 48): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    const r = ((h >>> 0) % 1000) / 1000;
    // A gentle shape so it reads as music: louder in the middle, some rhythm.
    const shape = 0.55 + 0.35 * Math.sin((i / n) * Math.PI) + 0.1 * Math.sin(i * 1.7);
    out.push(Math.max(0.2, Math.min(1, 0.25 + 0.75 * r * shape)));
  }
  return out;
}
