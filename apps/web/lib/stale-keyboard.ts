// An iPhone home-screen app left with the keyboard up (locked, or another app opened) comes back
// without the keyboard, but with the text box still focused and the page still laid out around the
// keyboard: a chat's message box floats halfway up the screen, over the messages. The same happens
// when the keyboard goes away while the box keeps focus. Letting go of the box and settling the
// scroll puts the page back, with the message box at the bottom.

const TEXT_FIELD =
  'textarea, [contenteditable=""], [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="file"], [type="color"])';

function focusedField(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.matches(TEXT_FIELD) ? el : null;
}

function settle(): void {
  focusedField()?.blur();
  requestAnimationFrame(() => window.scrollTo(window.scrollX, window.scrollY));
}

/** Watches for a keyboard that went away and left the page laid out around it. Phones only. */
export function watchStaleKeyboard(): () => void {
  if (typeof window === 'undefined' || !matchMedia('(hover: none) and (pointer: coarse)').matches) return () => {};
  const vv = window.visualViewport;

  let leftTyping = false;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      leftTyping = !!focusedField();
      return;
    }
    if (leftTyping) settle();
    leftTyping = false;
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted && focusedField()) settle();
  };

  // The screen's height without a keyboard: the tallest the visible area has been.
  // Turning the phone starts over.
  let full = vv?.height ?? 0;
  let width = vv?.width ?? 0;
  let keyboardUp = false;
  const onResize = () => {
    if (!vv) return;
    if (Math.abs(vv.width - width) > 1) {
      width = vv.width;
      full = vv.height;
      keyboardUp = false;
      return;
    }
    full = Math.max(full, vv.height);
    if (full - vv.height > 150) {
      keyboardUp = true;
      return;
    }
    // Back to the full height with a box still focused: the keyboard went without the page noticing.
    if (keyboardUp && full - vv.height < 60 && focusedField()) settle();
    keyboardUp = false;
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  vv?.addEventListener('resize', onResize);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    vv?.removeEventListener('resize', onResize);
  };
}
