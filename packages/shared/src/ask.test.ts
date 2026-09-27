import { describe, expect, it } from 'vitest';
import { askedByKey } from './ask.ts';
import { PROFILE_TABS, profileTabs } from './profile-style.ts';
import { askBoxSchema, askQuestionSchema, answerQuestionSchema, updateProfileSchema } from './schemas.ts';

const ada = { id: 'a', username: 'ada', displayName: 'Ada', avatarUrl: null, mode: 'personal' as const };

describe('ask me', () => {
  it('labels who asked, never naming someone who hid their name', () => {
    expect(askedByKey({ askedWithoutName: false, asker: ada })).toBe('ask.card.askedBy');
    expect(askedByKey({ askedWithoutName: true, asker: null })).toBe('ask.card.askedWithoutName');
    // Even if an asker slipped through, a question without a name says so.
    expect(askedByKey({ askedWithoutName: true, asker: ada })).toBe('ask.card.askedWithoutName');
    expect(askedByKey({ askedWithoutName: false, asker: null })).toBe('ask.card.askedBySomeone');
  });

  it('checks questions, answers and the box', () => {
    expect(askQuestionSchema.safeParse({ body: '  Hi?  ' }).data).toEqual({ body: 'Hi?', hideName: false });
    expect(askQuestionSchema.safeParse({ body: 'x'.repeat(301) }).success).toBe(false);
    expect(askQuestionSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(answerQuestionSchema.safeParse({ answer: 'Yes', share: { visibility: 'private' } }).success).toBe(false);
    expect(answerQuestionSchema.safeParse({ answer: 'Yes', share: { visibility: 'friends' } }).success).toBe(true);
    expect(askBoxSchema.safeParse({ prompt: 'Ask me about film photography' }).data).toEqual({ prompt: 'Ask me about film photography' });
    expect(askBoxSchema.safeParse({ prompt: 'visit https://example.com' }).success).toBe(false);
    expect(askBoxSchema.safeParse({ prompt: '' }).data).toEqual({ prompt: null });
  });

  it('adds Answers to the profile tabs without breaking saved lists', () => {
    expect(PROFILE_TABS.at(-1)).toBe('answers');
    expect(profileTabs(['posts', 'shop'])).toEqual(['posts', 'shop']);
    expect(updateProfileSchema.safeParse({ tabs: [...PROFILE_TABS] }).success).toBe(true);
  });
});
