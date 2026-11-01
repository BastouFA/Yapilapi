import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS, searchEmojis } from './emoji-data.ts';
import { favouriteReactions, inTone, QUICK_REACTIONS, readTone, rememberReaction, RECENT_REACTIONS_MAX, withTone } from './reactions.ts';

describe('reactions', () => {
  it('fills the bar with the usual six until you have favourites, and puts yours first', () => {
    expect(favouriteReactions([])).toEqual([...QUICK_REACTIONS]);
    expect(favouriteReactions(['🔥', '❤️'])).toEqual(['🔥', '❤️', '😂', '😮', '😢', '👍']);
  });

  it('keeps the latest first, once each, up to the limit', () => {
    let recent: string[] = [];
    for (const e of ['🔥', '😂', '🔥']) recent = rememberReaction(recent, e);
    expect(recent).toEqual(['🔥', '😂']);
    const many = EMOJI_GROUPS[0]!.entries.slice(0, 30).reduce<string[]>((r, e) => rememberReaction(r, e.emoji), []);
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

  it('lists every emoji once, in the kinds people know', () => {
    const all = EMOJI_GROUPS.flatMap((g) => g.entries.map((e) => e.emoji));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(1500);
    expect(EMOJI_GROUPS.map((g) => g.id)).toEqual(['smileys', 'animals', 'food', 'activity', 'travel', 'objects', 'symbols', 'flags']);
    for (const e of ['😀', '❤️', '👍', '🐶', '🍕', '⚽', '🚗', '💡', '✅', '🇳🇬', '🇹🇬', '🇫🇷']) expect(all).toContain(e);
    expect(all.some((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e))).toBe(false);
  });

  it('finds emojis by their name', () => {
    expect(searchEmojis('thumbs up').map((e) => e.emoji)).toContain('👍');
    expect(searchEmojis('PIZZA').map((e) => e.emoji)).toEqual(['🍕']);
    expect(searchEmojis('flag nigeria').map((e) => e.emoji)).toEqual(['🇳🇬']);
    expect(searchEmojis('   ')).toEqual([]);
    expect(searchEmojis('zzzz')).toEqual([]);
  });

  it('puts the colour in the right place in joined emojis, and never on two people', () => {
    expect(withTone('🧑‍⚕️', '🏽')).toBe('🧑🏽‍⚕️');
    expect(withTone('🏃‍♀️', '🏾')).toBe('🏃🏾‍♀️');
    expect(withTone('⛹️‍♂️', '🏿')).toBe('⛹🏿‍♂️');
    expect(withTone('🧑‍🤝‍🧑', '🏽')).toBe('🧑‍🤝‍🧑');
    expect(withTone('👨‍👩‍👧', '🏽')).toBe('👨‍👩‍👧');
  });
});
