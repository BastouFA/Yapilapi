import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '@yapilapi/shared/error-messages';
import { fromAcceptLanguage, translateDetails, translateMessage } from '../src/lib/error-language.ts';
import { collectErrorMessages } from './error-messages.ts';

// Every English error message in the source (read like a lint rule, test/error-messages.ts) needs
// an entry in every language table in packages/shared/src/locales/errors/. A new message fails
// here until it is translated; a message that is gone from the source must leave the tables too.
const { messages, unresolved } = collectErrorMessages();
const slots = (s: string) => [...s.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();

describe('error message translations', () => {
  it('reads every error message in the source', () => {
    // A message the collector can't read (built somewhere it can't follow) can't be checked:
    // write it where it is thrown, or teach test/error-messages.ts to follow it.
    expect(unresolved).toEqual([]);
    expect(messages.size).toBeGreaterThan(900);
  });

  for (const [lang, table] of Object.entries(ERROR_MESSAGES)) {
    describe(lang, () => {
      it('translates every message', () => {
        const missing = [...messages.keys()].filter((m) => !(m in table)).map((m) => `${m}  (${messages.get(m)![0]})`);
        expect(missing).toEqual([]);
      });

      it('has no messages the API no longer sends', () => {
        expect(Object.keys(table).filter((m) => !messages.has(m))).toEqual([]);
      });

      it('keeps the same {slots}, and the voice', () => {
        for (const [english, text] of Object.entries(table)) {
          expect(slots(text), `${lang}: ${english}`).toEqual(slots(english));
          expect(text.trim(), `${lang}: ${english}`).not.toBe('');
          if (!english.includes('!')) expect(text, `${lang}: ${english}`).not.toMatch(/[!¡]/);
          expect(text, `${lang}: ${english}`).not.toMatch(/\p{Extended_Pictographic}/u);
        }
      });
    });
  }
});

describe('translateMessage', () => {
  it('translates a message, fills a template and leaves unknown messages in English', () => {
    expect(translateMessage('Log in to continue.', 'fr')).toBe(ERROR_MESSAGES.fr!['Log in to continue.']);
    expect(translateMessage('Log in to continue.', 'fr-CA')).toBe(ERROR_MESSAGES.fr!['Log in to continue.']);
    expect(translateMessage('Log in to continue.', 'en')).toBe('Log in to continue.');
    expect(translateMessage('Log in to continue.', 'de')).toBe(ERROR_MESSAGES.de!['Log in to continue.']);
    expect(translateMessage('Log in to continue.', 'ur-PK')).toBe(ERROR_MESSAGES.ur!['Log in to continue.']);
    expect(translateMessage('Log in to continue.', 'nl')).toBe('Log in to continue.');
    expect(translateMessage('Not a message the API writes.', 'fr')).toBe('Not a message the API writes.');

    const template = 'We just sent a code. You can ask for another in {wait} seconds.';
    const french = translateMessage('We just sent a code. You can ask for another in 42 seconds.', 'fr');
    expect(french).toBe(ERROR_MESSAGES.fr![template]!.replace('{wait}', '42'));
    expect(french).toContain('42');
  });

  it('translates a value that is itself a message', () => {
    // "Line {line}: {message}" around a caption file's own error.
    const inner = 'A WebVTT file must start with "WEBVTT".';
    const out = translateMessage(`Line 1: ${inner}`, 'fr');
    expect(out).toBe(ERROR_MESSAGES.fr!['Line {line}: {message}']!.replace('{line}', '1').replace('{message}', ERROR_MESSAGES.fr![inner]!));
  });

  it('translates field messages and keeps the rest of details', () => {
    const d = translateDetails({ fields: { password: 'Incorrect.', n: 3 }, kind: 'x' }, 'es');
    expect(d).toEqual({ fields: { password: ERROR_MESSAGES.es!['Incorrect.'], n: 3 }, kind: 'x' });
    expect(translateDetails(undefined, 'es')).toBeUndefined();
    expect(translateDetails({ retryAfterSeconds: 5 }, 'es')).toEqual({ retryAfterSeconds: 5 });
  });

  it('reads Accept-Language by preference', () => {
    expect(fromAcceptLanguage('fr-CA,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(fromAcceptLanguage('nl-NL,nl;q=0.9,pt-BR;q=0.8')).toBe('pt');
    expect(fromAcceptLanguage('de-DE,de;q=0.9,pt-BR;q=0.8')).toBe('de');
    expect(fromAcceptLanguage('zh-Hans-CN,zh;q=0.9')).toBe('zh');
    expect(fromAcceptLanguage('ja,en;q=0.5')).toBe('ja');
    expect(fromAcceptLanguage('en;q=0.5,ar;q=0.9')).toBe('ar');
    expect(fromAcceptLanguage('nl, *;q=0.1')).toBeUndefined();
    expect(fromAcceptLanguage('')).toBeUndefined();
  });
});
