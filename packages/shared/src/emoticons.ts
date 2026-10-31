/**
 * Text emoticons turned into the real emoji as you type: ":)" and a space becomes "🙂 ". Only a
 * standalone emoticon is changed (at the start or after a space), only the one just finished by a
 * space, a new line or . , ! ?, and never inside `code`. So "12:30", "a:b", "std::vector" and
 * "http://x" stay as they are, pasting text changes nothing, and backspacing after a change just
 * edits. Sending can finish the last one ("nice :)" then Enter). The web and the phone share
 * this; the phone imports this file directly.
 */

/** Emoticon → emoji. Kept to ones that don't turn up in ordinary text (no "8)" or "B)", which number lists). */
export const EMOTICONS: Readonly<Record<string, string>> = {
  ':)': '🙂',
  ':-)': '🙂',
  ':]': '🙂',
  ':(': '🙁',
  ':-(': '🙁',
  ':D': '😄',
  ':-D': '😄',
  xD: '😆',
  XD: '😆',
  ';)': '😉',
  ';-)': '😉',
  ':P': '😛',
  ':-P': '😛',
  ':p': '😛',
  ':-p': '😛',
  ';P': '😜',
  ';p': '😜',
  ':O': '😮',
  ':-O': '😮',
  ':o': '😮',
  ':-o': '😮',
  ":'(": '😢',
  // Phones' smart punctuation types a curly apostrophe.
  ':’(': '😢',
  ':*': '😘',
  ':-*': '😘',
  '<3': '❤️',
  '</3': '💔',
  'B-)': '😎',
  '8-)': '😎',
  ':|': '😐',
  ':-|': '😐',
  ':/': '😕',
  ':-/': '😕',
  '>:(': '😠',
  '>:-(': '😠',
  '^^': '😊',
  '^_^': '😊',
  '-_-': '😑',
  T_T: '😭',
  'O:)': '😇',
  'o/': '👋',
  '\\o/': '🙌',
};

/** What finishes an emoticon: a space or new line, or a mark that ends a phrase. */
const BOUNDARY = /[\s.,!?]/;

/** True when `at` sits inside `code`: an odd number of backticks before it (``` fences count as three). */
function inCode(text: string, at: number): boolean {
  let ticks = 0;
  for (let i = 0; i < at; i++) if (text[i] === '`') ticks++;
  return ticks % 2 === 1;
}

/** The text with the emoticon ending at `end` swapped for its emoji, or null when what ends there isn't one. */
function swapEndingAt(text: string, end: number): { text: string; shift: number } | null {
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const emoji = EMOTICONS[text.slice(start, end)];
  if (!emoji || inCode(text, start)) return null;
  return { text: text.slice(0, start) + emoji + text.slice(end), shift: emoji.length - (end - start) };
}

/**
 * After one character was typed (`prev` became `next`), the text with the emoticon it finished
 * turned into the emoji, and where the caret goes; null when there's nothing to change. `caret` is
 * where the caret is in `next` (right after the typed character); without it, it's worked out from
 * the two texts. Anything but a single typed character (a paste, a deletion, a word the keyboard
 * replaced) is left alone.
 */
export function replaceTypedEmoticon(prev: string, next: string, caret?: number): { text: string; caret: number } | null {
  if (next.length !== prev.length + 1) return null;
  let at: number;
  if (caret === undefined) {
    // The furthest point the two still agree: where the character went (the later spot when
    // a repeated character makes it ambiguous, which is where the caret usually is).
    at = 0;
    while (at < prev.length && prev[at] === next[at]) at++;
  } else at = caret - 1;
  if (at < 0 || next.slice(0, at) + next.slice(at + 1) !== prev) return null;
  if (!BOUNDARY.test(next[at]!)) return null;
  const swapped = swapEndingAt(next, at);
  return swapped && { text: swapped.text, caret: at + 1 + swapped.shift };
}

/** The text with an emoticon at its very end turned into the emoji, for sending "nice :)" without a space after it. */
export function replaceFinalEmoticon(text: string): string {
  return swapEndingAt(text, text.length)?.text ?? text;
}
