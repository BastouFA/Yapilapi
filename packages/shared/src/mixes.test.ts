import { describe, expect, it } from 'vitest';
import { addMixSongsSchema, createMixSchema, reorderMixSchema } from './mix-schemas.ts';
import { mixPlayMs, moveItem, nextPlayable, previousPlayable } from './mixes.ts';
import { PROFILE_TABS, profileTabs } from './profile-style.ts';
import { REPORT_TARGETS } from './constants.ts';

const part = { audioUrl: 'https://audio.test/a.mp3', startMs: 0, durationMs: 30_000 };

describe('mixes', () => {
  it('skips songs that can’t play, both ways', () => {
    const songs = [{ play: null }, { play: part }, { play: null }, { play: part }];
    expect(nextPlayable(songs, 0)).toBe(1);
    expect(nextPlayable(songs, 2)).toBe(3);
    expect(nextPlayable(songs, 4)).toBe(-1);
    expect(previousPlayable(songs, 3)).toBe(1);
    expect(previousPlayable(songs, 1)).toBe(-1);
    expect(mixPlayMs(songs)).toBe(60_000);
  });

  it('moves one song and keeps the rest in order', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('checks forms', () => {
    const id = '0b0e6a8e-7f0e-4c7a-9a55-6f7a1b2c3d4e';
    expect(createMixSchema.safeParse({ title: ' ' }).success).toBe(false);
    expect(createMixSchema.parse({ title: 'Road trip' })).toMatchObject({ visibility: 'followers', songs: [], description: '' });
    expect(addMixSongsSchema.safeParse({ songs: [{ trackId: id, soundId: id }] }).success).toBe(false);
    expect(addMixSongsSchema.safeParse({ songs: [{ soundId: id }] }).success).toBe(true);
    expect(reorderMixSchema.safeParse({ songIds: [id, id] }).success).toBe(false);
  });

  it('adds Mixes at the end of the profile tabs, and mixes to what can be reported', () => {
    expect(PROFILE_TABS.at(-1)).toBe('mixes');
    expect(profileTabs(['answers', 'posts'])).toEqual(['answers', 'posts']);
    expect(REPORT_TARGETS).toContain('mix');
    expect(REPORT_TARGETS).toContain('drop');
  });
});
