import { describe, expect, it } from 'vitest';
import {
  nextBookingStatus,
  type BookingAction,
  type BookingActor,
  type BookingStatus,
} from './booking-state.js';

const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 3_600_000);
const ALL: BookingStatus[] = [
  'requested',
  'confirmed',
  'declined',
  'cancelled',
  'completed',
  'no_show',
];
const ACTIONS: BookingAction[] = ['confirm', 'decline', 'cancel', 'complete', 'no_show'];

describe('booking state machine', () => {
  it('allows exactly the documented transitions', () => {
    expect(nextBookingStatus('requested', 'confirm', 'business', future)).toBe('confirmed');
    expect(nextBookingStatus('requested', 'decline', 'business', future)).toBe('declined');
    expect(nextBookingStatus('requested', 'cancel', 'customer', future)).toBe('cancelled');
    expect(nextBookingStatus('requested', 'cancel', 'business', future)).toBe('cancelled');
    expect(nextBookingStatus('confirmed', 'cancel', 'customer', future)).toBe('cancelled');
    expect(nextBookingStatus('confirmed', 'cancel', 'business', future)).toBe('cancelled');
    expect(nextBookingStatus('confirmed', 'complete', 'business', past)).toBe('completed');
    expect(nextBookingStatus('confirmed', 'no_show', 'business', past)).toBe('no_show');
  });

  it('never leaves a terminal state', () => {
    for (const s of ['declined', 'cancelled', 'completed', 'no_show'] as BookingStatus[]) {
      for (const a of ACTIONS)
        for (const actor of ['customer', 'business'] as BookingActor[]) {
          for (const when of [future, past])
            expect(() => nextBookingStatus(s, a, actor, when)).toThrow();
        }
    }
  });

  it('keeps business-only actions away from customers', () => {
    for (const a of ['confirm', 'decline'] as BookingAction[])
      expect(() => nextBookingStatus('requested', a, 'customer', future)).toThrow(
        /Only the business/,
      );
    for (const a of ['complete', 'no_show'] as BookingAction[])
      expect(() => nextBookingStatus('confirmed', a, 'customer', past)).toThrow(
        /Only the business/,
      );
  });

  it('respects time: no confirming expired requests, no cancelling started bookings, no completing early', () => {
    expect(() => nextBookingStatus('requested', 'confirm', 'business', past)).toThrow(/expired/);
    expect(() => nextBookingStatus('confirmed', 'cancel', 'customer', past)).toThrow(
      /already started/,
    );
    expect(() => nextBookingStatus('confirmed', 'complete', 'business', future)).toThrow(
      /not started/,
    );
    expect(() => nextBookingStatus('requested', 'complete', 'business', past)).toThrow();
    expect(() => nextBookingStatus('confirmed', 'confirm', 'business', future)).toThrow();
    expect(() => nextBookingStatus('confirmed', 'decline', 'business', future)).toThrow();
  });

  it('is total: every (status, action, actor) either returns a status or throws', () => {
    for (const s of ALL)
      for (const a of ACTIONS)
        for (const actor of ['customer', 'business'] as BookingActor[]) {
          try {
            expect(ALL).toContain(nextBookingStatus(s, a, actor, future));
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
          }
        }
  });
});
