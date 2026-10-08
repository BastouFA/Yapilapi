import { z } from 'zod';
import { CHAIN_JOIN, CHAIN_RULES } from './constants.ts';

/** Pass the Mic requests, checked by the API (pass-the-mic.ts has the rest, without zod, for the phone). */

const prompt = z.string().trim().min(1).max(CHAIN_RULES.promptMax);

/** Start a chain from one of your reels already posted. */
export const chainStartSchema = z.object({
  postId: z.string().uuid(),
  prompt,
  /** Left out: everyone for public accounts, people you follow for private and under-18 accounts. */
  whoCanJoin: z.enum(CHAIN_JOIN).optional(),
});
export type ChainStartInput = z.input<typeof chainStartSchema>;

/** The starter changes the prompt or who can take the mic ('nobody' closes it). */
export const chainEditSchema = z
  .object({ prompt: prompt.optional(), whoCanJoin: z.enum(CHAIN_JOIN).optional() })
  .refine((v) => v.prompt !== undefined || v.whoCanJoin !== undefined, { message: 'Nothing to change.' });
export type ChainEditInput = z.input<typeof chainEditSchema>;

/** Pass the mic to people (each is told, when they may take it). */
export const chainPassSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(CHAIN_RULES.passesAtOnce) });
