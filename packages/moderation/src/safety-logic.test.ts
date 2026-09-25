import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRIKE_POLICY,
  activeStrikePoints,
  checkImpersonation,
  escalate,
  normalizeForDuplicate,
  scoreSpam,
  similarity,
  skeleton,
  strikePointsFor,
  type BehaviorSample,
} from './index.js';

describe('strike escalation ladder', () => {
  it('awards points by severity', () => {
    expect(strikePointsFor('low')).toBe(1);
    expect(strikePointsFor('high')).toBe(2);
    expect(strikePointsFor('critical')).toBe(3);
  });

  it('walks the ladder as points accumulate', () => {
    expect(escalate({ activePoints: 0, severity: 'low' })).toMatchObject({
      action: 'warning',
      totalPoints: 1,
      days: null,
    });
    expect(escalate({ activePoints: 1, severity: 'low' })).toMatchObject({
      action: 'limit_reach',
      days: 3,
      totalPoints: 2,
    });
    expect(escalate({ activePoints: 2, severity: 'low' })).toMatchObject({
      action: 'suspension',
      days: 3,
    });
    expect(escalate({ activePoints: 4, severity: 'low' })).toMatchObject({
      action: 'suspension',
      days: 14,
    });
  });

  it('never auto-applies a ban: it is returned as a recommendation with the strongest automatic action', () => {
    const r = escalate({ activePoints: 6, severity: 'low' });
    expect(r.recommendation).toEqual({ action: 'ban', days: null });
    expect(r.action).toBe('suspension');
    expect(r.days).toBe(14);
  });

  it('applies zero-tolerance categories immediately, regardless of history', () => {
    const r = escalate({ activePoints: 0, severity: 'low', categories: ['minor_safety'] });
    expect(r).toMatchObject({ action: 'suspension', days: 30, reason: 'immediate_category' });
    // Unknown categories do not matter.
    expect(escalate({ activePoints: 0, severity: 'low', categories: ['spam'] }).action).toBe(
      'warning',
    );
  });

  it('an immediate category never weakens a stronger ladder result', () => {
    const r = escalate({ activePoints: 4, severity: 'low', categories: ['threat'] });
    // ladder says suspension 14d (5 points); threat says 14d too; result stays a suspension of at least 14 days
    expect(r.action).toBe('suspension');
    expect(r.days).toBeGreaterThanOrEqual(14);
  });

  it('decays old strikes and ignores revoked ones', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const day = 86_400_000;
    const pts = activeStrikePoints(
      [
        { points: 2, at: new Date(now.getTime() - 10 * day) },
        { points: 3, at: new Date(now.getTime() - 100 * day) }, // outside the 90 day window
        { points: 1, at: new Date(now.getTime() - 5 * day), revoked: true },
      ],
      now,
    );
    expect(pts).toBe(2);
  });

  it('supports a custom ladder', () => {
    const policy = {
      ...DEFAULT_STRIKE_POLICY,
      ladder: [{ minPoints: 1, action: 'suspension' as const, days: 1 }],
      humanOnly: [],
    };
    expect(escalate({ activePoints: 0, severity: 'low' }, policy)).toMatchObject({
      action: 'suspension',
      days: 1,
    });
  });
});

const base: BehaviorSample = {
  surface: 'comment',
  postsLastHour: 0,
  commentsLast10Min: 1,
  messagesLast10Min: 0,
  followsLastHour: 0,
  duplicateCount: 1,
  accountAgeHours: 500,
};

describe('behaviour-based spam scoring', () => {
  it('leaves normal usage alone, even at a healthy pace', () => {
    expect(
      scoreSpam({
        ...base,
        commentsLast10Min: 12,
        text: 'Great point, thanks for sharing this with everyone',
      }).level,
    ).toBe('ok');
    expect(
      scoreSpam({ ...base, surface: 'post', postsLastHour: 10, text: 'Weekend hike photos' }).level,
    ).toBe('ok');
  });

  it('flags velocity', () => {
    expect(scoreSpam({ ...base, commentsLast10Min: 30 })).toMatchObject({
      reasons: ['comment_velocity'],
      level: 'ok',
    });
    expect(scoreSpam({ ...base, commentsLast10Min: 45 }).level).toBe('suspicious');
    expect(scoreSpam({ ...base, surface: 'follow', followsLastHour: 90 }).level).toBe('suspicious');
  });

  it('short repeated text is not duplicate spam, long repeated text is', () => {
    expect(scoreSpam({ ...base, duplicateCount: 20, text: 'lol' }).score).toBe(0);
    const t = 'Check out my amazing new store with the cheapest deals ever';
    expect(scoreSpam({ ...base, duplicateCount: 3, text: t }).level).toBe('ok');
    expect(scoreSpam({ ...base, duplicateCount: 5, text: t }).level).toBe('suspicious');
    expect(scoreSpam({ ...base, duplicateCount: 9, text: t }).level).toBe('suspicious');
    expect(scoreSpam({ ...base, duplicateCount: 12, text: t }).level).toBe('spam');
  });

  it('combines signals into spam', () => {
    const r = scoreSpam({
      ...base,
      surface: 'message',
      messagesLast10Min: 70,
      duplicateCount: 9,
      duplicateTargets: 9,
      accountAgeHours: 2,
      text: 'Win big now https://a.example/x https://b.example/y',
    });
    expect(r.level).toBe('spam');
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reasons).toEqual(expect.arrayContaining(['message_velocity', 'duplicate_content']));
  });

  it('flags link and mention stuffing', () => {
    const links = Array.from({ length: 8 }, (_, i) => `https://x.example/${i}`).join(' ');
    expect(scoreSpam({ ...base, text: links }).reasons).toContain('link_stuffing');
    const mentions = Array.from({ length: 10 }, (_, i) => `@user_${i}abc`).join(' ');
    expect(scoreSpam({ ...base, text: mentions }).reasons).toContain('mention_stuffing');
  });

  it('normalizes text so trivial variations count as duplicates', () => {
    expect(normalizeForDuplicate('Buy NOW!!! https://a.example/1 code 123')).toBe(
      normalizeForDuplicate('buy now https://b.example/2 code 999'),
    );
  });
});

describe('impersonation check', () => {
  const protectedIds = [
    {
      id: 'b1',
      kind: 'business' as const,
      username: 'acme-coffee',
      displayName: 'Acme Coffee Roasters',
    },
    { id: 's1', kind: 'staff' as const, username: 'yl_support', displayName: 'YAPILAPI Support' },
  ];

  it('folds homoglyphs and separators', () => {
    expect(skeleton('4cme_C0ffee')).toBe(skeleton('acme coffee'));
    expect(similarity('abc', 'abc')).toBe(1);
  });

  it('flags lookalikes as high risk', () => {
    const r = checkImpersonation({ username: 'acme_c0ffee' }, protectedIds);
    expect(r.risk).toBe('high');
    expect(r.best).toMatchObject({ identityId: 'b1', field: 'username' });
  });

  it('flags protected names embedded in a longer name', () => {
    const r = checkImpersonation({ displayName: 'Official YAPILAPI Support Team' }, protectedIds);
    expect(r.risk).toBe('high');
    expect(r.best?.identityId).toBe('s1');
  });

  it('flags near misses with low risk and ignores unrelated names', () => {
    expect(checkImpersonation({ username: 'acmecoffeee2' }, protectedIds).risk).not.toBe('none');
    expect(checkImpersonation({ username: 'sunny_bakes' }, protectedIds).risk).toBe('none');
  });

  it('does not flag the identity itself or very short names', () => {
    expect(checkImpersonation({ username: 'acme-coffee' }, protectedIds).risk).toBe('none');
    expect(
      checkImpersonation({ username: 'abc' }, [{ id: 'x', kind: 'staff', username: 'abd' }]).risk,
    ).toBe('none');
  });

  it('can exclude the account being checked', () => {
    expect(
      checkImpersonation({ username: 'acme_c0ffee' }, protectedIds, { exclude: new Set(['b1']) })
        .risk,
    ).toBe('none');
  });
});

import { canTransition, pipelineFor } from './pipeline.js';

describe('moderation pipeline model', () => {
  it('derives the path for each state', () => {
    expect(pipelineFor({ state: 'review', decided: false }).path).toEqual([
      'content',
      'analysis',
      'risk',
      'review',
    ]);
    expect(pipelineFor({ state: 'escalated', decided: false }).current).toBe('escalate');
    expect(pipelineFor({ state: 'appealed', decided: true }).path.at(-1)).toBe('appeal');
    expect(pipelineFor({ state: 'resolved', decided: true }).path).toEqual([
      'content',
      'analysis',
      'risk',
      'review',
      'final',
    ]);
  });
  it('only allows legal transitions', () => {
    expect(canTransition('review', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'appealed')).toBe(true);
    expect(canTransition('appealed', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'review')).toBe(false);
    expect(canTransition('appealed', 'review')).toBe(false);
    expect(canTransition('normal', 'escalated')).toBe(false);
  });
});
