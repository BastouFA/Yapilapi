import { describe, expect, it } from 'vitest';
import { freeTonightUntil, owedBy, planDebts, PLAN_RULES, splitEvenly } from './plans.ts';

describe('splitEvenly', () => {
  it('splits equally, the odd cents to the first people, and always adds up', () => {
    expect(splitEvenly(1000, ['a', 'b', 'c'])).toEqual([
      { userId: 'a', shareCents: 334 },
      { userId: 'b', shareCents: 333 },
      { userId: 'c', shareCents: 333 },
    ]);
    expect(splitEvenly(600, ['a', 'a', 'b'])).toEqual([
      { userId: 'a', shareCents: 300 },
      { userId: 'b', shareCents: 300 },
    ]);
    expect(splitEvenly(0, ['a'])).toEqual([]);
    expect(splitEvenly(5, [])).toEqual([]);
  });
});

describe('planDebts', () => {
  it('simplifies who owes whom per currency, and paying back settles it', () => {
    const expenses = [
      { paidBy: 'ada', currency: 'NGN', shares: splitEvenly(9000, ['ada', 'bola', 'cleo']) },
      { paidBy: 'bola', currency: 'NGN', shares: splitEvenly(3000, ['ada', 'bola', 'cleo']) },
      { paidBy: 'cleo', currency: 'EUR', shares: splitEvenly(1000, ['ada', 'cleo']) },
    ];
    // NGN: Ada paid 9000 and owes 3000 + 1000 (+5000), Bola paid 3000 and owes 4000 (−1000), Cleo owes 4000. EUR: Ada owes Cleo 500.
    const debts = planDebts(expenses, []);
    expect(debts).toEqual([
      { from: 'ada', to: 'cleo', amountCents: 500, currency: 'EUR' },
      { from: 'cleo', to: 'ada', amountCents: 4000, currency: 'NGN' },
      { from: 'bola', to: 'ada', amountCents: 1000, currency: 'NGN' },
    ]);
    expect(owedBy(debts, 'cleo', 'ada', 'NGN')).toBe(4000);
    const after = planDebts(expenses, [{ from: 'cleo', to: 'ada', amountCents: 4000, currency: 'NGN' }]);
    expect(after.filter((d) => d.currency === 'NGN')).toEqual([{ from: 'bola', to: 'ada', amountCents: 1000, currency: 'NGN' }]);
    expect(planDebts([], [])).toEqual([]);
  });
});

describe('freeTonightUntil', () => {
  it('is midnight, or the next two hours just after it', () => {
    const evening = new Date(2026, 9, 30, 19, 0);
    expect(freeTonightUntil(evening).getTime()).toBe(new Date(2026, 9, 31, 0, 0).getTime());
    const late = new Date(2026, 9, 30, 0, 30);
    expect(freeTonightUntil(late).getTime()).toBe(late.getTime() + PLAN_RULES.freeNowHours * 3_600_000);
  });
});
