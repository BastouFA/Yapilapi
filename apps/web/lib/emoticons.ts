import { replaceTypedEmoticon } from '@yapilapi/shared';

/** What a key press types: a character or a new line. A paste, a spell-check swap or text an IME is still composing isn't. */
const TYPED = new Set(['insertText', 'insertLineBreak', 'insertParagraph']);

type Change = { currentTarget: HTMLInputElement | HTMLTextAreaElement; nativeEvent: Event };

/**
 * For a text box's onChange: the new value, with an emoticon just finished (":)" then a space)
 * turned into the emoji. `prev` is the value before the change. When it swaps one, the box takes
 * the new text and the caret at once, so the controlled re-render that follows leaves both alone.
 */
export function withEmoticons(e: Change, prev: string): string {
  const el = e.currentTarget;
  const input = e.nativeEvent as Partial<InputEvent>;
  if (input.isComposing || (input.inputType !== undefined && !TYPED.has(input.inputType))) return el.value;
  const swapped = replaceTypedEmoticon(prev, el.value, el.selectionStart ?? undefined);
  if (!swapped) return el.value;
  el.value = swapped.text;
  el.setSelectionRange(swapped.caret, swapped.caret);
  // Once more after React has rendered, in case anything moved it meanwhile.
  requestAnimationFrame(() => {
    if (document.activeElement === el && el.value === swapped.text) el.setSelectionRange(swapped.caret, swapped.caret);
  });
  return swapped.text;
}
