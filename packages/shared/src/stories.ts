import { z } from 'zod';
import type { PublicUser } from './types.ts';

/**
 * Story stickers. Each has a position on the frame, relative to its size
 * (0–1 from the start edge and the top), a scale and a rotation.
 */
const placement = {
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(0.5).max(2.5).default(1),
  rotation: z.number().min(-180).max(180).default(0),
};

const short = (max: number) => z.string().trim().min(1).max(max);

/** Stickers as the author sends them. The server gives each an id and fills in names, domains and places. */
export const storyStickerInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mention'),
    ...placement,
    username: z
      .string()
      .trim()
      .transform((s) => s.replace(/^@/, ''))
      .pipe(z.string().min(3).max(30)),
  }),
  z.object({
    type: z.literal('hashtag'),
    ...placement,
    tag: z
      .string()
      .trim()
      .transform((s) => s.replace(/^#/, ''))
      .pipe(z.string().regex(/^[\p{L}\p{M}\p{N}_]{2,40}$/u, 'Tags are 2 to 40 letters, numbers or underscores.')),
  }),
  z.object({ type: z.literal('poll'), ...placement, question: z.string().trim().max(80).default(''), options: z.tuple([short(30), short(30)]) }),
  z.object({ type: z.literal('question'), ...placement, prompt: short(80) }),
  z.object({ type: z.literal('slider'), ...placement, prompt: short(80), emoji: short(8) }),
  z.object({ type: z.literal('countdown'), ...placement, title: short(60), endsAt: z.string().datetime({ offset: true }) }),
  z.object({
    type: z.literal('link'),
    ...placement,
    url: z
      .string()
      .trim()
      .url()
      .max(2000)
      .refine((u) => /^https?:\/\//i.test(u), 'Use a web address starting with http:// or https://.'),
    label: z.string().trim().max(40).default(''),
  }),
  z.object({ type: z.literal('place'), ...placement, placeId: z.string().uuid() }),
]);
export type StoryStickerInput = z.input<typeof storyStickerInputSchema>;

/** Interactive stickers: at most one of each on a story. */
export const INTERACTIVE_STICKERS = ['poll', 'question', 'slider', 'countdown', 'link'] as const;

export const storyStickersSchema = z
  .array(storyStickerInputSchema)
  .max(10)
  .default([])
  .refine((list) => INTERACTIVE_STICKERS.every((k) => list.filter((s) => s.type === k).length <= 1), {
    message: 'A story can have one poll, one question, one slider, one countdown and one link.',
  });

interface Placed {
  id: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** A sticker as a viewer gets it: what to show, and for interactive ones, where they stand. */
export type StorySticker = Placed &
  (
    | { type: 'mention'; user: PublicUser }
    | { type: 'hashtag'; tag: string }
    | {
        type: 'poll';
        question: string;
        options: [string, string];
        /** Your vote (0 or 1), or null. */
        voted: number | null;
        /** Percentages for each option, once you've voted (and always for the author). */
        results?: [number, number];
        votes?: number;
      }
    | { type: 'question'; prompt: string; /** How many answers you've sent. */ answered: number }
    | {
        type: 'slider';
        prompt: string;
        emoji: string;
        /** Your answer (0–1), or null. */ mine: number | null;
        /** The author only. */ average?: number | null;
        count?: number;
      }
    | { type: 'countdown'; title: string; endsAt: string; /** You asked to be reminded. */ reminding: boolean }
    | { type: 'link'; url: string; domain: string; label: string }
    | { type: 'place'; placeId: string; name: string; city: string | null }
  );

/**
 * A story shown inside something else (a message or a reshare). It opens only
 * for people who can see the story; for everyone else it's just "not available".
 */
export type StoryCard =
  | {
      id: string;
      available: true;
      author: PublicUser;
      body: string;
      mediaUrl: string | null;
      mediaKind: 'image' | 'video' | 'audio' | null;
      posterUrl: string | null;
      expiresAt: string | null;
    }
  | { id: string; available: false };

/** What the author sees in "Seen by" for each interactive sticker. */
export type StickerResults =
  | { stickerId: string; type: 'poll'; options: [string, string]; counts: [number, number]; percents: [number, number]; votes: number }
  | { stickerId: string; type: 'slider'; emoji: string; prompt: string; average: number | null; count: number }
  | { stickerId: string; type: 'question'; prompt: string; answers: { id: string; user: PublicUser; text: string; createdAt: string }[] }
  | { stickerId: string; type: 'countdown'; title: string; endsAt: string; reminders: number };

/** Host of a link, without "www.", for showing on a link sticker. */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Percentages for two counts that add up to 100 (or 0 and 0 with no votes). */
export function pollPercents(counts: [number, number]): [number, number] {
  const total = counts[0] + counts[1];
  if (!total) return [0, 0];
  const a = Math.round((counts[0] / total) * 100);
  return [a, 100 - a];
}
