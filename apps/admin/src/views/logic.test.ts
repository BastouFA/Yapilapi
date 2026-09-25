import { describe, expect, it } from 'vitest';
import { auditFilters, EMPTY_AUDIT_FORM, toIso } from './Audit';
import { groupCells, isAnalyticsTab, sumCells } from './Analytics';
import { decisionsFor } from './MiniApps';
import { PAYMENT_TABS } from './Payments';

describe('audit filters', () => {
  it('drops empty fields and trims the rest', () => {
    expect(
      auditFilters({
        ...EMPTY_AUDIT_FORM,
        actionPrefix: ' moderation. ',
        targetType: 'moderation_case',
      }),
    ).toEqual({ actionPrefix: 'moderation.', targetType: 'moderation_case' });
    expect(auditFilters(EMPTY_AUDIT_FORM)).toEqual({});
  });

  it('never sends an actor id the API would reject', () => {
    expect(auditFilters({ ...EMPTY_AUDIT_FORM, actorId: 'not-a-uuid' })).toEqual({});
    const id = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
    expect(auditFilters({ ...EMPTY_AUDIT_FORM, actorId: ` ${id} ` })).toEqual({ actorId: id });
  });

  it('converts local date-times to ISO instants and ignores garbage', () => {
    expect(toIso('2026-09-21T10:30')).toMatch(/^2026-09-2[01]T\d\d:30:00\.000Z$/);
    expect(toIso('')).toBeUndefined();
    expect(toIso('yesterday-ish')).toBeUndefined();
    expect(auditFilters({ ...EMPTY_AUDIT_FORM, from: 'nope' })).toEqual({});
  });
});

describe('analytics helpers (small counts are suppressed, never zero)', () => {
  it('sums only the cells that are known', () => {
    expect(sumCells([1, null, 6])).toBe(7);
    expect(sumCells([null, null])).toBe(0);
  });

  it('keeps a group suppressed when every one of its cells is suppressed', () => {
    const rows = [
      { k: 'a', v: null },
      { k: 'a', v: null },
      { k: 'b', v: 5 },
      { k: 'b', v: null },
      { k: 'c', v: 6 },
      { k: 'c', v: 7 },
    ];
    expect(
      groupCells(
        rows,
        (r) => r.k,
        (r) => r.v,
      ),
    ).toEqual([
      { key: 'a', value: null },
      { key: 'b', value: 5 },
      { key: 'c', value: 13 },
    ]);
  });

  it('recognises only real analytics sections', () => {
    expect(isAnalyticsTab('msa')).toBe(true);
    expect(isAnalyticsTab('users')).toBe(false);
    expect(isAnalyticsTab('../secrets')).toBe(false);
  });
});

describe('mini app review decisions', () => {
  it('only offers transitions the API accepts', () => {
    expect(decisionsFor('in_review')).toEqual(['approve', 'reject']);
    expect(decisionsFor('published')).toEqual(['suspend']);
    expect(decisionsFor('suspended')).toEqual(['reinstate']);
    expect(decisionsFor('draft')).toEqual([]);
    expect(decisionsFor('rejected')).toEqual([]);
  });
});

describe('payments sections', () => {
  it('has an overview plus five finance queues', () => {
    expect([...PAYMENT_TABS]).toEqual([
      'overview',
      'orders',
      'refunds',
      'payouts',
      'disputes',
      'reconciliation',
    ]);
  });
});
