import { describe, expect, it } from 'vitest';
import { contactHashInput, emailsIn, normalizeEmail } from './contacts.ts';

describe('contact normalization', () => {
  it('trims and lower-cases emails and rejects things that are not emails', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });

  it('finds every address in pasted text once', () => {
    const text = 'Ada <ADA@example.com>, bob@example.org; ada@example.com\n"Chi" chi@mail.example.ng.';
    expect(emailsIn(text)).toEqual(['ada@example.com', 'bob@example.org', 'chi@mail.example.ng']);
  });

  it('builds the string to hash with the kind, so phone numbers can join later', () => {
    expect(contactHashInput('s', 'email', 'ada@example.com')).toBe('s:email:ada@example.com');
    expect(contactHashInput('s', 'phone', '+2348012345678')).toBe('s:phone:+2348012345678');
  });
});
