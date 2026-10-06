import { describe, expect, it } from 'vitest';
import { t } from './i18n.ts';
import { topicName } from './topic-names.ts';

describe('topicName', () => {
  it('names starter topics in the reader’s language and keeps made-up ones as stored', () => {
    expect(topicName('football', 'Football', (k) => t(k, 'fr'))).toBe('Football');
    expect(topicName('cooking', 'Cooking', (k) => t(k, 'fr'))).toBe('Recettes');
    expect(topicName('music', 'Music', (k) => t(k, 'ar'))).toBe('موسيقى');
    expect(topicName('knitting', 'Knitting', (k) => t(k, 'fr'))).toBe('Knitting');
  });
});
