import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx, mergeRefs, useIsomorphicLayoutEffect, useOutsidePress } from '../utils';
import { CheckIcon } from './icons';

export interface MenuItemDef {
  id: string;
  label: ReactNode;
  /** Plain-text label for typeahead (defaults to `label` when it is a string). */
  textValue?: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** When set the item is a `menuitemradio` (single choice) with this state. */
  checked?: boolean;
  /** Render a separator line above this item. */
  separatorBefore?: boolean;
}

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  /** The trigger element (e.g. <IconButton/>). It receives aria-haspopup/expanded/controls, ref and onClick/onKeyDown. */
  trigger: ReactElement<Record<string, unknown>>;
  items: MenuItemDef[];
  align?: 'start' | 'end';
  className?: string;
}

/**
 * WAI-ARIA menu button: Enter/Space/ArrowDown opens, arrows/Home/End move, letters typeahead, Escape closes and
 * restores focus to the trigger, Tab closes. Opens upward when there is no room below.
 */
export function Menu({ label, trigger, items, align = 'end', className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);
  useOutsidePress([wrapRef], () => close(false), open);

  const enabledItems = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
  const focusAt = (idx: number) => {
    const els = enabledItems();
    if (els.length) els[(idx + els.length) % els.length]!.focus();
  };

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (list) {
      const r = list.getBoundingClientRect();
      const below = window.innerHeight - (triggerRef.current?.getBoundingClientRect().bottom ?? 0);
      const above = triggerRef.current?.getBoundingClientRect().top ?? 0;
      setFlip(r.height > below && above > below);
    }
  }, [open]);

  useEffect(() => {
    if (open) focusAt(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const els = enabledItems();
    const i = els.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusAt(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusAt(i - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(-1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          const ta = typeahead.current;
          ta.text = now - ta.at > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
          ta.at = now;
          const match = els.find((el) => (el.dataset['text'] ?? '').startsWith(ta.text));
          match?.focus();
        }
    }
  };

  if (!isValidElement(trigger)) throw new Error('<Menu trigger> must be a React element');
  const triggerProps = trigger.props;
  const triggerEl = cloneElement(trigger, {
    ref: mergeRefs(triggerRef, (trigger as unknown as { ref?: React.Ref<HTMLElement> }).ref),
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (e: React.MouseEvent) => {
      (triggerProps['onClick'] as ((e: React.MouseEvent) => void) | undefined)?.(e);
      setOpen((o) => !o);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      (triggerProps['onKeyDown'] as ((e: React.KeyboardEvent) => void) | undefined)?.(e);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
    },
  });

  return (
    <span ref={wrapRef} className={cx('yl-menu', className)}>
      {triggerEl}
      {open ? (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onListKeyDown}
          className={cx(
            'yl-menu__list',
            align === 'end' ? 'yl-menu__list--end' : 'yl-menu__list--start',
            flip && 'yl-menu__list--up',
          )}
        >
          {items.map((item) => (
            <div
              key={item.id}
              role="none"
              className={cx('yl-menu__row', item.separatorBefore && 'yl-menu__row--sep')}
            >
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                aria-disabled={item.disabled || undefined}
                data-text={(
                  item.textValue ?? (typeof item.label === 'string' ? item.label : '')
                ).toLowerCase()}
                tabIndex={-1}
                className={cx('yl-menu__item', item.danger && 'yl-menu__item--danger')}
                onClick={() => {
                  if (item.disabled) return;
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon ? (
                  <span className="yl-menu__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span className="yl-menu__text">{item.label}</span>
                {item.checked ? <CheckIcon size={16} className="yl-menu__check" /> : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}
