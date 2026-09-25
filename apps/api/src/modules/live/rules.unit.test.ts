import { describe, expect, it } from 'vitest';
import {
  can,
  canTransition,
  cleanTerms,
  clampReactionCount,
  foldText,
  hostingRefusal,
  isMuted,
  matchesBlockedTerm,
  outranks,
  scheduleRefusal,
  sessionOffsetMs,
  slowModeWaitMs,
  validateClipRange,
  validatePoll,
  validateVote,
  type LiveAction,
  type LiveRole,
} from './rules.js';

describe('lifecycle', () => {
  it('only moves forward', () => {
    expect(canTransition('scheduled', 'live')).toBe(true);
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('live', 'ended')).toBe(true);
    expect(canTransition('live', 'cancelled')).toBe(false);
    expect(canTransition('ended', 'live')).toBe(false);
    expect(canTransition('cancelled', 'live')).toBe(false);
    expect(canTransition('scheduled', 'ended')).toBe(false);
  });
});

describe('permission matrix', () => {
  const actions: LiveAction[] = [
    'start',
    'cancel',
    'edit',
    'manage_team',
    'end',
    'settings',
    'moderate',
    'hide_message',
    'poll',
    'answer',
    'products',
    'marker',
    'clip',
    'recording',
    'chat',
    'react',
    'ask',
    'vote',
  ];
  const allowed = (r: LiveRole) => actions.filter((a) => can(r, a));
  it('host can do everything', () => expect(allowed('host')).toEqual(actions));
  it('co-hosts run the room and may end it but do not own the session', () => {
    expect(can('cohost', 'end')).toBe(true);
    for (const a of ['start', 'cancel', 'edit', 'manage_team', 'recording'] as const)
      expect(can('cohost', a)).toBe(false);
    expect(can('cohost', 'moderate')).toBe(true);
  });
  it('moderators only moderate and take part', () => {
    expect(allowed('moderator')).toEqual([
      'moderate',
      'hide_message',
      'answer',
      'chat',
      'react',
      'ask',
      'vote',
    ]);
  });
  it('the audience only takes part', () =>
    expect(allowed('audience')).toEqual(['chat', 'react', 'ask', 'vote']));
  it('moderation goes down the ladder only', () => {
    expect(outranks('host', 'cohost')).toBe(true);
    expect(outranks('cohost', 'moderator')).toBe(true);
    expect(outranks('moderator', 'audience')).toBe(true);
    expect(outranks('cohost', 'cohost')).toBe(false);
    expect(outranks('cohost', 'host')).toBe(false);
    expect(outranks('audience', 'audience')).toBe(false);
  });
});

describe('chat filters', () => {
  it('folds case, accents and simple leetspeak', () => {
    expect(foldText('  Ｂ4dWörd!! ')).toBe('badword');
    expect(foldText('h3ll0  w0rld')).toBe('hello world');
  });
  it('validates and folds a term list', () => {
    expect(cleanTerms(['Spoiler', 'spoiler', 'NO  way'])).toEqual(['spoiler', 'no way']);
    expect(cleanTerms(['a'])).toBeNull();
    expect(cleanTerms(['x'.repeat(41)])).toBeNull();
    expect(cleanTerms(Array.from({ length: 51 }, (_, i) => `term${i}`))).toBeNull();
  });
  it('matches whole words, phrases and squashed spacing, but not innocent substrings', () => {
    const terms = ['cat', 'spoiler', 'big secret'];
    expect(matchesBlockedTerm('I love my cat!', terms)).toBe(true);
    expect(matchesBlockedTerm('category theory', terms)).toBe(false);
    expect(matchesBlockedTerm('s p o i l e r', terms)).toBe(true);
    expect(matchesBlockedTerm('the Big   Secret is out', terms)).toBe(true);
    expect(matchesBlockedTerm('nothing here', terms)).toBe(false);
    expect(matchesBlockedTerm('anything', [])).toBe(false);
  });
  it('slow mode waits only for the audience', () => {
    const now = new Date('2026-01-01T00:00:10Z');
    const last = new Date('2026-01-01T00:00:05Z');
    expect(slowModeWaitMs(last, now, 10, 'audience')).toBe(5000);
    expect(slowModeWaitMs(last, now, 3, 'audience')).toBe(0);
    expect(slowModeWaitMs(null, now, 10, 'audience')).toBe(0);
    expect(slowModeWaitMs(last, now, 10, 'cohost')).toBe(0);
    expect(slowModeWaitMs(last, now, 0, 'audience')).toBe(0);
  });
  it('mutes expire', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(isMuted(new Date('2026-01-01T00:01:00Z'), now)).toBe(true);
    expect(isMuted(new Date('2025-12-31T23:59:00Z'), now)).toBe(false);
    expect(isMuted(null, now)).toBe(false);
  });
});

describe('polls, reactions, clips', () => {
  it('validates polls', () => {
    expect(validatePoll({ question: 'Q?', options: ['a', 'b'] })).toEqual({
      ok: true,
      options: ['a', 'b'],
    });
    expect(validatePoll({ question: 'Q?', options: ['a'] }).ok).toBe(false);
    expect(
      validatePoll({ question: 'Q?', options: Array.from({ length: 7 }, (_, i) => `o${i}`) }).ok,
    ).toBe(false);
    expect(validatePoll({ question: 'Q?', options: ['a', 'A'] }).ok).toBe(false);
    expect(validatePoll({ question: ' ', options: ['a', 'b'] }).ok).toBe(false);
    expect(validatePoll({ question: 'Q?', options: ['a', ''] }).ok).toBe(false);
  });
  it('validates votes', () => {
    const v = new Set(['1', '2', '3']);
    expect(validateVote(['1'], v, false)).toBeNull();
    expect(validateVote(['1', '2'], v, false)).not.toBeNull();
    expect(validateVote(['1', '2'], v, true)).toBeNull();
    expect(validateVote(['1', '1'], v, true)).not.toBeNull();
    expect(validateVote(['9'], v, false)).not.toBeNull();
    expect(validateVote([], v, true)).not.toBeNull();
  });
  it('clamps reactions', () => {
    expect(clampReactionCount(0)).toBe(1);
    expect(clampReactionCount(99)).toBe(10);
    expect(clampReactionCount(Number.NaN)).toBe(1);
    expect(clampReactionCount(3.7)).toBe(3);
  });
  it('validates clip ranges and offsets', () => {
    expect(validateClipRange(0, 500, null)).not.toBeNull();
    expect(validateClipRange(0, 700_000, null)).not.toBeNull();
    expect(validateClipRange(0, 30_000, 60_000)).toBeNull();
    expect(validateClipRange(50_000, 70_000, 60_000)).not.toBeNull();
    const s = new Date('2026-01-01T00:00:00Z');
    expect(sessionOffsetMs(null, null, s)).toBe(0);
    expect(sessionOffsetMs(s, null, new Date('2026-01-01T00:00:30Z'))).toBe(30_000);
    expect(
      sessionOffsetMs(s, new Date('2026-01-01T00:00:10Z'), new Date('2026-01-01T00:05:00Z')),
    ).toBe(10_000);
  });
});

describe('hosting limits', () => {
  it('teens never host public, subscriber-only or ticketed sessions', () => {
    expect(
      hostingRefusal({ ageBand: 'teen', visibility: 'public', ticketed: false }),
    ).not.toBeNull();
    expect(
      hostingRefusal({ ageBand: 'teen', visibility: 'subscribers', ticketed: false }),
    ).not.toBeNull();
    expect(
      hostingRefusal({ ageBand: 'teen', visibility: 'followers', ticketed: true }),
    ).not.toBeNull();
    expect(
      hostingRefusal({ ageBand: 'teen', visibility: 'followers', ticketed: false }),
    ).toBeNull();
    expect(hostingRefusal({ ageBand: 'teen', visibility: 'private', ticketed: false })).toBeNull();
    expect(hostingRefusal({ ageBand: 'adult', visibility: 'public', ticketed: true })).toBeNull();
  });
  it('schedules within a sane window', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(scheduleRefusal(new Date('2026-01-01T00:00:30Z'), now)).not.toBeNull();
    expect(scheduleRefusal(new Date('2026-01-01T00:10:00Z'), now)).toBeNull();
    expect(scheduleRefusal(new Date('2026-06-01T00:00:00Z'), now)).not.toBeNull();
  });
});
