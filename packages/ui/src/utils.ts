import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type RefCallback,
  type MutableRefObject,
} from 'react';

export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as MutableRefObject<T | null>).current = node;
    }
  };
}

export function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (v: T) => void,
): [T, (v: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : inner;
  const set = useCallback(
    (v: T) => {
      if (!isControlled) setInner(v);
      onChange?.(v);
    },
    [isControlled, onChange],
  );
  return [value, set];
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** Keep Tab / Shift+Tab inside `container`. Returns a keydown handler. */
export function trapTab(container: HTMLElement, e: KeyboardEvent | React.KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const items = getFocusable(container);
  if (items.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Call `handler` when a pointer press lands outside every element in `refs`. */
export function useOutsidePress(
  refs: Array<React.RefObject<HTMLElement | null>>,
  handler: () => void,
  enabled: boolean,
): void {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && refs.some((r) => r.current?.contains(t))) return;
      saved.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

/** Text direction of the nearest element with a dir attribute (falls back to the document). */
export function isRtlElement(el: Element | null): boolean {
  if (!el) return false;
  return getComputedStyle(el).direction === 'rtl';
}
