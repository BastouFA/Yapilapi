/**
 * Whether Enter sends a chat message. On a computer it does (Shift+Enter starts a new line). On a
 * touch phone or tablet the keyboard's Return key starts a new line, as in other messaging apps, and
 * the Send button sends.
 */
export function enterSends(): boolean {
  return !(typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches);
}
