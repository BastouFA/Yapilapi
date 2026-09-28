import { z } from 'zod';
import { MIX_ADD_MAX, MIX_DESCRIPTION_MAX, MIX_FILTERS, MIX_SONGS_MAX, MIX_TITLE_MAX, MIX_VISIBILITIES } from './mixes.ts';

/** Mix forms, checked by the API (mixes.ts has the rest, without zod, so the phone app can use it). */

const uuid = z.string().uuid();

/** A song from the picker: an in-app sound or a catalogue song. */
export const mixSongRefSchema = z
  .object({ soundId: uuid.optional(), trackId: uuid.optional() })
  .refine((s) => !!s.soundId !== !!s.trackId, { message: 'Choose a sound or a song.', path: ['trackId'] });
export type MixSongRef = z.infer<typeof mixSongRefSchema>;

const title = z.string().trim().min(1, 'Give your mix a name.').max(MIX_TITLE_MAX, `Up to ${MIX_TITLE_MAX} characters.`);
const description = z.string().trim().max(MIX_DESCRIPTION_MAX, `Up to ${MIX_DESCRIPTION_MAX} characters.`);

export const createMixSchema = z.object({
  title,
  description: description.default(''),
  visibility: z.enum(MIX_VISIBILITIES).default('followers'),
  songs: z.array(mixSongRefSchema).max(MIX_ADD_MAX, `Add up to ${MIX_ADD_MAX} songs at a time.`).default([]),
});

export const updateMixSchema = z
  .object({ title: title.optional(), description: description.optional(), visibility: z.enum(MIX_VISIBILITIES).optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change something first.' });

export const addMixSongsSchema = z.object({
  songs: z.array(mixSongRefSchema).min(1, 'Choose a song.').max(MIX_ADD_MAX, `Add up to ${MIX_ADD_MAX} songs at a time.`),
});

/** The mix's songs in their new order: every song on it, each once. */
export const reorderMixSchema = z.object({
  songIds: z
    .array(uuid)
    .max(MIX_SONGS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Each song can be listed once.'),
});

export const shareMixSchema = z.object({ conversationId: uuid, clientId: uuid.optional() });

/** Share a mix as a post: optional words, and who sees the post. */
export const postMixSchema = z.object({
  body: z.string().trim().max(2000).default(''),
  visibility: z.enum(['public', 'followers', 'friends']).default('public'),
});

export const mixListQuerySchema = z.object({ filter: z.enum(MIX_FILTERS).default('own') });
