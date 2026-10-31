import { z } from 'zod';
import { CURRENCIES } from './constants.ts';
import { PLAN_ANSWERS, PLAN_PLACE_KINDS, PLAN_RULES } from './plans.ts';

/** Go out together requests, checked by the API (plans.ts has the rest, without zod, for the phone). */

const people = z.array(z.string().uuid()).max(PLAN_RULES.maxPeople);

/** Where: a place, event or stash by id, or words. */
const place = z
  .object({
    kind: z.enum(PLAN_PLACE_KINDS),
    id: z.string().uuid().optional(),
    name: z.string().trim().max(PLAN_RULES.placeMax).optional(),
  })
  .refine((p) => (p.kind === 'text' ? !!p.name : !!p.id), { message: 'Choose a place or write where.' });

/** A new plan: what, when, optionally where and details, and the friends (or a squad) to invite. */
export const planCreateSchema = z.object({
  title: z.string().trim().min(1).max(PLAN_RULES.titleMax),
  startsAt: z.string().datetime({ offset: true }),
  place: place.nullable().optional(),
  note: z.string().trim().max(PLAN_RULES.noteMax).optional(),
  userIds: people.default([]),
  squadId: z.string().uuid().optional(),
});
export type PlanCreateInput = z.input<typeof planCreateSchema>;

/** The maker changes what, when, where or the details. `place: null` takes the place off. */
export const planEditSchema = z
  .object({
    title: z.string().trim().min(1).max(PLAN_RULES.titleMax).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    place: place.nullable().optional(),
    note: z.string().trim().max(PLAN_RULES.noteMax).optional(),
  })
  .refine((v) => v.title !== undefined || v.startsAt !== undefined || v.place !== undefined || v.note !== undefined, { message: 'Nothing to change.' });
export type PlanEditInput = z.input<typeof planEditSchema>;

export const planAnswerSchema = z.object({ answer: z.enum(PLAN_ANSWERS) });

/** Invite more friends, or a squad you're in. */
export const planInviteSchema = z
  .object({ userIds: people.default([]), squadId: z.string().uuid().optional() })
  .refine((v) => v.userIds.length > 0 || !!v.squadId, { message: 'Choose who to invite.' });

/** "I'm free" until a time (from 15 minutes to 18 hours from now), with a few words. */
export const freeNowSchema = z.object({
  until: z.string().datetime({ offset: true }),
  note: z.string().trim().max(PLAN_RULES.freeNoteMax).optional(),
});
export type FreeNowInput = z.input<typeof freeNowSchema>;

/** An expense: what for, how much (in cents), who paid, and who it's split equally between. */
export const planExpenseSchema = z.object({
  title: z.string().trim().min(1).max(PLAN_RULES.expenseTitleMax),
  amountCents: z.number().int().min(1).max(PLAN_RULES.maxExpenseCents),
  currency: z.string().length(3).toUpperCase().pipe(z.enum(CURRENCIES)),
  paidBy: z.string().uuid(),
  splitWith: z.array(z.string().uuid()).min(1).max(PLAN_RULES.maxPeople),
});
export type PlanExpenseInput = z.input<typeof planExpenseSchema>;

/** "Paid back": one of the two marks that `from` paid `to` this much. */
export const planSettlementSchema = z.object({
  from: z.string().uuid(),
  to: z.string().uuid(),
  amountCents: z
    .number()
    .int()
    .min(1)
    .max(PLAN_RULES.maxExpenseCents * PLAN_RULES.maxExpenses),
  currency: z.string().length(3).toUpperCase().pipe(z.enum(CURRENCIES)),
});
export type PlanSettlementInput = z.input<typeof planSettlementSchema>;
