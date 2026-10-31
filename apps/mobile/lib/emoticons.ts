import type { TextInput } from 'react-native';
import { replaceTypedEmoticon } from '../../../packages/shared/src/emoticons';

/**
 * For a TextInput's onChangeText: when the character just typed finished an emoticon (":)" then a
 * space), the text with the emoji in its place and where the caret goes; null otherwise. `prev` is
 * the text before the change and `caret` where the caret is thought to be after it (it's worked out
 * from the two texts when not known or when it doesn't fit). After a swap in the middle of the
 * text, `input`'s caret is put back after the typed character; at the end it stays at the end.
 */
export function swapEmoticon(prev: string, next: string, input?: TextInput | null, caret?: number) {
  const swapped = (caret !== undefined ? replaceTypedEmoticon(prev, next, caret) : null) ?? replaceTypedEmoticon(prev, next);
  if (swapped && swapped.caret < swapped.text.length) {
    requestAnimationFrame(() => input?.setSelection?.(swapped.caret, swapped.caret));
  }
  return swapped;
}
