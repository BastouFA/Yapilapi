import { z } from 'zod';
import { ECHO_BALANCE_DEFAULT, ECHO_CUT_MAX_MS, ECHO_CUT_MIN_MS, ECHO_LAYOUTS, ECHO_PERMISSIONS } from './echoes.ts';
import { REEL_LONGEST_MS } from './reels.ts';

/** The echo request, checked by the API (echoes.ts has the rest, without zod, so the phone app can use it). */

const ms = z.number().int().min(0).max(REEL_LONGEST_MS);

export const echoCreateSchema = z
  .object({
    /** Your video: one you uploaded or recorded in the app (only your own). */
    mediaId: z.string().uuid(),
    layout: z.enum(ECHO_LAYOUTS).default('side'),
    /** "Echo after": this part of their reel plays first, 1 to 15 seconds. */
    cut: z.object({ startMs: ms, endMs: ms }).nullable().default(null),
    /** 0 is only their sound, 100 only yours. */
    balance: z.number().int().min(0).max(100).default(ECHO_BALANCE_DEFAULT),
    /** Leave their sound out. */
    muteTheirs: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (!v.cut) return;
    const len = v.cut.endMs - v.cut.startMs;
    if (len < ECHO_CUT_MIN_MS) ctx.addIssue({ code: 'custom', message: 'Keep at least 1 second of their reel.', path: ['cut', 'endMs'] });
    if (len > ECHO_CUT_MAX_MS) ctx.addIssue({ code: 'custom', message: 'The part that plays first can be up to 15 seconds.', path: ['cut', 'endMs'] });
  });
export type EchoCreateInput = z.input<typeof echoCreateSchema>;

export const echoSettingsSchema = z.object({ allowEchoes: z.enum(ECHO_PERMISSIONS) });
