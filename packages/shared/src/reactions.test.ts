import { describe, expect, it } from 'vitest';
import { favouriteReactions, inTone, QUICK_REACTIONS, REACTION_GROUPS, readTone, rememberReaction, RECENT_REACTIONS_MAX, withTone } from './reactions.ts';

describe('reactions', () => {
  it('fills the bar with the usual six until you have favourites, and puts yours first', () => {
    expect(favouriteReactions([])).toEqual([...QUICK_REACTIONS]);
    expect(favouriteReactions(['🔥', '❤️'])).toEqual(['🔥', '❤️', '😂', '😮', '😢', '👍']);
  });

  it('keeps the latest first, once each, up to the limit', () => {
    let recent: string[] = [];
    for (const e of ['🔥', '😂', '🔥']) recent = rememberReaction(recent, e);
    expect(recent).toEqual(['🔥', '😂']);
    const many = REACTION_GROUPS[0]!.emojis.slice(0, 30).reduce<string[]>((r, e) => rememberReaction(r, e), []);
    expect(many).toHaveLength(RECENT_REACTIONS_MAX);
  });

  it('puts hands and people in your skin colour, and leaves everything else alone', () => {
    expect(withTone('👍', '🏾')).toBe('👍🏾');
    expect(withTone('✌️', '🏽')).toBe('✌🏽');
    expect(withTone('🏃', '🏻')).toBe('🏃🏻');
    expect(withTone('👍🏾', '🏼')).toBe('👍🏼');
    expect(withTone('👍🏾', '')).toBe('👍');
    expect(withTone('✌️', '')).toBe('✌️');
    expect(withTone('❤️', '🏾')).toBe('❤️');
    expect(withTone('😂', '🏾')).toBe('😂');
    expect(withTone('🧠', '🏾')).toBe('🧠');
    expect(withTone('🇳🇬', '🏾')).toBe('🇳🇬');
  });

  it('shows the bar in your skin colour', () => {
    expect(favouriteReactions([], '🏾')).toEqual(['❤️', '😂', '😮', '😢', '👍🏾', '🙏🏾']);
    expect(favouriteReactions(['👍🏻'], '🏾')).toEqual(['👍🏾', '❤️', '😂', '😮', '😢', '🙏🏾']);
  });

  it('counts one emoji once whatever its colour', () => {
    expect(inTone(['👍', '👍🏾'], '🏽')).toEqual(['👍🏽']);
    expect(rememberReaction(['👍', '🔥'], '👍🏾')).toEqual(['👍🏾', '🔥']);
    expect(rememberReaction(['✌️'], '✌🏽')).toEqual(['✌🏽']);
  });

  it('reads back only a real skin colour', () => {
    expect(readTone('🏾')).toBe('🏾');
    expect(readTone(null)).toBe('');
    expect(readTone('nonsense')).toBe('');
  });

  it('lists every emoji once', () => {
    const all = REACTION_GROUPS.flatMap((g) => g.emojis);
    expect(new Set(all).size).toBe(all.length);
  });
});
