import { describe, expect, it } from 'vitest';
import { AppError } from '@yapilapi/shared';
import {
  ENTITLED_ORDER_STATUSES,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  assertTransition,
  canTransition,
  type OrderActor,
} from './order-state.js';

describe('order state machine', () => {
  it('covers every status and only references known statuses', () => {
    for (const s of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[s]).toBeDefined();
      for (const to of Object.keys(ORDER_TRANSITIONS[s])) expect(ORDER_STATUSES).toContain(to);
    }
  });

  it('allows the documented happy path', () => {
    const path = ['pending_payment', 'paid', 'fulfilled', 'completed'] as const;
    for (let i = 0; i < path.length - 1; i++)
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    expect(canTransition('pending_payment', 'paid', 'system')).toBe(true);
    expect(canTransition('paid', 'fulfilled', 'seller')).toBe(true);
    expect(canTransition('fulfilled', 'completed', 'buyer')).toBe(true);
  });

  it('terminal states have no exits', () => {
    for (const s of TERMINAL_ORDER_STATUSES)
      expect(Object.keys(ORDER_TRANSITIONS[s])).toHaveLength(0);
    expect(() => assertTransition('cancelled', 'paid', 'system')).toThrow(AppError);
    expect(() => assertTransition('refunded', 'paid', 'system')).toThrow(AppError);
  });

  it('a paid order can never be cancelled, only refunded', () => {
    expect(canTransition('paid', 'cancelled')).toBe(false);
    expect(canTransition('fulfilled', 'cancelled')).toBe(false);
    expect(canTransition('paid', 'refunded', 'system')).toBe(true);
  });

  it('cannot skip payment or go backwards', () => {
    expect(canTransition('pending_payment', 'fulfilled')).toBe(false);
    expect(canTransition('pending_payment', 'completed')).toBe(false);
    expect(canTransition('fulfilled', 'paid')).toBe(false);
    expect(canTransition('completed', 'fulfilled')).toBe(false);
    expect(canTransition('pending_review', 'paid')).toBe(false);
    expect(canTransition('cancelled', 'pending_payment')).toBe(false);
  });

  it('enforces who may do what', () => {
    expect(canTransition('pending_payment', 'paid', 'buyer')).toBe(false);
    expect(canTransition('pending_payment', 'paid', 'seller')).toBe(false);
    expect(canTransition('pending_payment', 'cancelled', 'buyer')).toBe(true);
    expect(canTransition('pending_review', 'pending_payment', 'buyer')).toBe(false);
    expect(canTransition('pending_review', 'pending_payment', 'staff')).toBe(true);
    expect(canTransition('paid', 'fulfilled', 'buyer')).toBe(false);
    expect(canTransition('fulfilled', 'completed', 'seller')).toBe(false);
    expect(canTransition('paid', 'refunded', 'buyer')).toBe(false);
    const actors: OrderActor[] = ['buyer', 'seller', 'staff', 'system'];
    // Refund/dispute transitions are system-only (they follow money movement, never a client request).
    for (const a of actors.filter((x) => x !== 'system')) {
      expect(canTransition('paid', 'partially_refunded', a)).toBe(false);
      expect(canTransition('paid', 'disputed', a)).toBe(false);
    }
  });

  it('assertTransition maps failures to 409 and 403', () => {
    try {
      assertTransition('paid', 'pending_payment', 'system');
      throw new Error('expected');
    } catch (e) {
      expect(e).toMatchObject({
        code: 'conflict',
        status: 409,
        details: { reason: 'invalid_order_transition' },
      });
    }
    try {
      assertTransition('pending_payment', 'paid', 'buyer');
      throw new Error('expected');
    } catch (e) {
      expect(e).toMatchObject({ code: 'forbidden', status: 403 });
    }
    expect(() => assertTransition('pending_payment', 'paid', 'system')).not.toThrow();
  });

  it('disputes can be won (restoring the previous state) or lost (refund)', () => {
    for (const back of ['paid', 'fulfilled', 'completed', 'partially_refunded'] as const)
      expect(canTransition('disputed', back, 'system')).toBe(true);
    expect(canTransition('disputed', 'refunded', 'system')).toBe(true);
    expect(canTransition('disputed', 'cancelled')).toBe(false);
  });

  it('entitled statuses are those where money is held for the goods', () => {
    expect(ENTITLED_ORDER_STATUSES).toContain('paid');
    expect(ENTITLED_ORDER_STATUSES).not.toContain('refunded');
    expect(ENTITLED_ORDER_STATUSES).not.toContain('pending_payment');
  });
});
