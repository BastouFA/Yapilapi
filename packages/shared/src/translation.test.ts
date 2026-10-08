import { describe, expect, it } from 'vitest';
import { translateBatchSchema } from './schemas.ts';
import { needsTranslation, TRANSLATION_BATCH_MAX, understoodLanguages, worthTranslating } from './translation.ts';

describe('automatic translation helpers', () => {
  it('skips text with nothing to translate: emoji, tags, names, links, numbers, one capitalised word', () => {
    for (const text of ['', '   ', '😀🎉', '👍🏽', '#tbt @ada https://example.com', 'www.example.com 2026', 'Lagos', 'Ada', '!!!', 'x'])
      expect(worthTranslating(text)).toBe(false);
    for (const text of ['Bonjour à tous', 'merci', 'Merci beaucoup @ada', 'Habari za leo', '谢谢大家', 'مرحبا بالجميع', 'Ẹ káàárọ̀ o'])
      expect(worthTranslating(text)).toBe(true);
  });

  it('never translates what the reader understands, and always counts the app language', () => {
    expect(understoodLanguages('pt-BR', ['fr', 'fr', 'yo'])).toEqual(['pt', 'fr', 'yo']);
    expect(needsTranslation('fr', 'en', ['fr'])).toBe(false);
    expect(needsTranslation('fr', 'en')).toBe(true);
    expect(needsTranslation('en', 'en-GB', [])).toBe(false);
  });

  it('asks about up to TRANSLATION_BATCH_MAX items at once', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const ok = translateBatchSchema.safeParse({ target: 'EN', items: [{ kind: 'post', id }] });
    expect(ok.success && ok.data.target).toBe('en');
    expect(translateBatchSchema.safeParse({ target: 'en', items: [] }).success).toBe(false);
    expect(
      translateBatchSchema.safeParse({ target: 'en', items: Array.from({ length: TRANSLATION_BATCH_MAX + 1 }, () => ({ kind: 'post', id })) }).success,
    ).toBe(false);
    expect(translateBatchSchema.safeParse({ target: 'xx', items: [{ kind: 'post', id }] }).success).toBe(false);
  });
});
