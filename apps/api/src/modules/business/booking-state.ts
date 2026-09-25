import { AppError } from '@yapilapi/shared';

export type BookingStatus =
  'requested' | 'confirmed' | 'declined' | 'cancelled' | 'completed' | 'no_show';
export type BookingAction = 'confirm' | 'decline' | 'cancel' | 'complete' | 'no_show';
export type BookingActor = 'customer' | 'business';

export const BOOKING_TERMINAL: readonly BookingStatus[] = [
  'declined',
  'cancelled',
  'completed',
  'no_show',
];
/** Statuses that hold a slot (and count against capacity). */
export const BOOKING_ACTIVE: readonly BookingStatus[] = ['requested', 'confirmed'];

/**
 * Booking state machine (pure).
 *
 *   requested --confirm (business)--> confirmed --complete / no_show (business, once started)--> completed | no_show
 *   requested --decline (business)--> declined
 *   requested | confirmed --cancel (customer or business, before start)--> cancelled
 *
 * Terminal states never change. Returns the next status or throws a 409/403 AppError.
 */
export function nextBookingStatus(
  current: BookingStatus,
  action: BookingAction,
  actor: BookingActor,
  startsAt: Date,
  now: Date = new Date(),
): BookingStatus {
  const started = startsAt <= now;
  const bad = (msg: string, reason: string) =>
    new AppError('conflict', msg, { reason, status: current });
  if (BOOKING_TERMINAL.includes(current))
    throw bad(`This booking is already ${current.replace('_', ' ')}`, 'booking_closed');
  switch (action) {
    case 'confirm':
    case 'decline':
      if (actor !== 'business') throw new AppError('forbidden', 'Only the business can do that');
      if (current !== 'requested')
        throw bad('Only requested bookings can be confirmed or declined', 'invalid_transition');
      if (started) throw bad('This booking request has expired', 'booking_expired');
      return action === 'confirm' ? 'confirmed' : 'declined';
    case 'cancel':
      if (started) throw bad('This booking has already started', 'booking_started');
      return 'cancelled';
    case 'complete':
    case 'no_show':
      if (actor !== 'business') throw new AppError('forbidden', 'Only the business can do that');
      if (current !== 'confirmed')
        throw bad(
          'Only confirmed bookings can be completed or marked as no-show',
          'invalid_transition',
        );
      if (!started) throw bad('The booking has not started yet', 'not_started');
      return action === 'complete' ? 'completed' : 'no_show';
  }
}
