import { z } from 'zod';
import { MAX_SQUAD_MEMBERS, SQUAD_COLORS, SQUAD_RULES } from './constants.ts';

/** Squad requests, checked by the API (squads.ts has the rest, without zod, for the phone). */

const name = z.string().trim().min(1).max(SQUAD_RULES.nameMax);
const people = z.array(z.string().uuid());

/** A new squad: a name, a colour or cover photo, and the people to invite (2 to 9). */
export const squadCreateSchema = z.object({
  name,
  color: z.enum(SQUAD_COLORS).default('coral'),
  /** One of your own processed photos. */
  coverMediaId: z.string().uuid().optional(),
  userIds: people.min(SQUAD_RULES.minInvites).max(MAX_SQUAD_MEMBERS - 1),
});
export type SquadCreateInput = z.input<typeof squadCreateSchema>;

/** Rename it, or change its cover (owner and admins). `coverMediaId: null` goes back to the colour. */
export const squadEditSchema = z
  .object({ name: name.optional(), color: z.enum(SQUAD_COLORS).optional(), coverMediaId: z.string().uuid().nullable().optional() })
  .refine((v) => v.name !== undefined || v.color !== undefined || v.coverMediaId !== undefined, { message: 'Nothing to change.' });
export type SquadEditInput = z.input<typeof squadEditSchema>;

/** Invite more people (each accepts or declines). */
export const squadInviteSchema = z.object({ userIds: people.min(1).max(MAX_SQUAD_MEMBERS - 1) });

/** Make someone an admin or a member again (the owner). */
export const squadRoleSchema = z.object({ role: z.enum(['admin', 'member']) });
