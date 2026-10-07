import { describe, expect, it } from 'vitest';
import { compactCount, fullCount, milestoneFor, milestoneNoticeText } from './post-stats.ts';
import { t, tp } from './i18n.ts';

describe('post numbers', () => {
  it('writes counts short in the reader’s language, and whole under 1,000', () => {
    expect(compactCount(999, 'en')).toBe('999');
    expect(compactCount(1234, 'en')).toBe('1.2K');
    expect(compactCount(12_345_678, 'en')).toBe('12.3M');
    expect(compactCount(3400, 'fr').replace(/\s/g, ' ')).toBe('3,4 k');
    expect(compactCount(-5, 'en')).toBe('0');
    expect(fullCount(1234, 'en')).toBe('1,234');
  });

  it('finds the highest milestone passed', () => {
    expect(milestoneFor(99)).toBeNull();
    expect(milestoneFor(100)).toBe(100);
    expect(milestoneFor(54_321)).toBe(10_000);
    expect(milestoneFor(2_000_000)).toBe(100_000);
  });

  it('says a milestone in words, with the number written for the reader', () => {
    const tr = (key: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(key, 'en', vars);
    expect(milestoneNoticeText({ type: 'post_milestone', data: { metric: 'views', threshold: 1000, format: 'reel' } }, tr, 'en')).toBe(
      'Your reel passed 1,000 views',
    );
    expect(milestoneNoticeText({ type: 'post_milestone', data: { metric: 'likes', threshold: 100, format: 'post' } }, tr, 'en')).toBe(
      'Your post passed 100 likes',
    );
    expect(milestoneNoticeText({ type: 'post_reaction', data: {} }, tr, 'en')).toBeNull();
  });

  it('lets a plural sentence use the number as written for the reader', () => {
    expect(tp('post.stats.views', 1234, 'en', { count: '1.2K' })).toBe('1.2K views');
    expect(tp('post.stats.views', 1, 'en')).toBe('1 view');
  });
});
