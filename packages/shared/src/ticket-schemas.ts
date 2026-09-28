import { z } from 'zod';
import { CHECK_IN_METHODS, TICKET_CODE_LENGTH } from './tickets.ts';

/** Ticket and check-in forms, checked by the API (tickets.ts has the rest, without zod, so the phone app can use it). */

const uuid = z.string().uuid();

/**
 * Check someone in: a scanned token, a typed backup code, or a ticket picked from the guest list
 * (exactly one). `clientRef` and `scannedAt` come with check-ins a browser kept while offline: the
 * same clientRef sent again is the same check-in, and scannedAt is when it happened at the door.
 */
export const checkInSchema = z
  .object({
    token: z.string().trim().min(8).max(120).optional(),
    code: z
      .string()
      .trim()
      .max(TICKET_CODE_LENGTH + 4)
      .optional(),
    ticketId: uuid.optional(),
    method: z.enum(CHECK_IN_METHODS).optional(),
    clientRef: z
      .string()
      .max(64)
      .regex(/^[\w-]+$/)
      .optional(),
    scannedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => [v.token, v.code, v.ticketId].filter((x) => x !== undefined).length === 1, {
    message: 'Scan a ticket, type its code or pick a guest.',
    path: ['code'],
  });

/** Give your ticket to a friend. */
export const transferTicketSchema = z.object({ userId: uuid });

/** The host adds a co-host (a friend), who can check people in and see the guest list. */
export const addCohostSchema = z.object({ userId: uuid });

export const guestListQuerySchema = z.object({
  q: z.string().trim().max(60).optional(),
  filter: z.enum(['all', 'in', 'waiting']).default('all'),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CheckInInput = z.infer<typeof checkInSchema>;
