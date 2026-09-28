import { describe, expect, it } from 'vitest';
import { initialsOf } from './initials.ts';

describe('initials in place of a photo', () => {
  it('takes the first and last words', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('amara grace obi')).toBe('AO');
    expect(initialsOf('  Tunde  ')).toBe('T');
    expect(initialsOf('Keyboard Cooks', 1)).toBe('K');
  });

  it('skips punctuation and symbols in front of a word', () => {
    expect(initialsOf('[Dev data] Keyboard Cooks', 1)).toBe('D');
    expect(initialsOf('[Dev data] Keyboard Cooks')).toBe('DC');
    expect(initialsOf('(Lagos) runners')).toBe('LR');
    expect(initialsOf('@ada')).toBe('A');
  });

  it('never splits a character', () => {
    // An emoji first: skipped, not cut in half.
    expect(initialsOf('😀 Ada')).toBe('A');
    expect(initialsOf('𝒜da Obi')).toBe('𝒜O');
    // A letter with its combining marks.
    expect(initialsOf('Ọ̀ṣun Bello')).toBe('Ọ̀B');
    expect(initialsOf('سارة حداد')).toBe('سح');
  });

  it('says ? when there is no letter at all', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('😀 🎉')).toBe('?');
    expect(initialsOf('[ ]', 1)).toBe('?');
  });
});
