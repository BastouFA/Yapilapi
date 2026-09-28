/**
 * The letters shown in place of a photo: the first letter of the first and last words of a name
 * ("Ada Lovelace" → "AL"), or one letter for communities and the like. Words are read by
 * character, not by UTF-16 unit, so a name starting with an emoji or a letter outside the basic
 * plane never leaves half a character behind, and leading punctuation or symbols ("[Dev data]
 * Cooks", "(Lagos) runners") are skipped. The web, the phone and the design system share this.
 */

const LETTER = /[\p{L}\p{N}]/u;

/** The first letter or number in a word, with any marks that belong to it, or '' when it has none. */
function firstLetter(word: string): string {
  const chars = Array.from(word);
  const i = chars.findIndex((c) => LETTER.test(c));
  if (i < 0) return '';
  let out = chars[i]!;
  // Combining marks that follow (e.g. a Yoruba "Ọ̀") stay with their letter.
  for (let j = i + 1; j < chars.length && /\p{M}/u.test(chars[j]!); j++) out += chars[j];
  return out.toLocaleUpperCase();
}

/** Up to `max` initials (2 for people, 1 for a community's mark); '?' when the name has no letters at all. */
export function initialsOf(name: string, max: 1 | 2 = 2): string {
  const words = name.trim().split(/\s+/).map(firstLetter).filter(Boolean);
  if (!words.length) return '?';
  if (max === 1 || words.length === 1) return words[0]!;
  return words[0]! + words.at(-1)!;
}
