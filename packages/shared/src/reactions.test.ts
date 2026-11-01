import { describe, expect, it } from 'vitest';
import { favouriteReactions, QUICK_REACTIONS, REACTION_GROUPS, rememberReaction, RECENT_REACTIONS_MAX } from './reactions.ts';

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

  it('lists every emoji once', () => {
    const all = REACTION_GROUPS.flatMap((g) => g.emojis);
    expect(new Set(all).size).toBe(all.length);
  });
});
