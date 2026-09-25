import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx, getFocusable, useOutsidePress } from '../utils';

export interface PopoverProps {
  /** Visible text or content of the trigger button. */
  triggerContent: ReactNode;
  /** Accessible label of the popover panel. */
  label: string;
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  align?: 'start' | 'end';
  /** Extra props for the trigger, e.g. data-testid. */
  triggerProps?: Record<string, string>;
}

/** Non-modal disclosure popover: trigger has aria-expanded/controls; Escape/outside click close and restore focus. */
export function Popover({
  triggerContent,
  label,
  children,
  onOpenChange,
  triggerClassName,
  align = 'start',
  triggerProps,
}: PopoverProps) {
  const [open, setOpenState] = useState(false);
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (v: boolean, restore = false) => {
      setOpenState(v);
      onOpenChange?.(v);
      if (!v && restore) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  useOutsidePress([wrapRef], () => setOpen(false), open);

  useEffect(() => {
    if (open)
      (panelRef.current && (getFocusable(panelRef.current)[0] ?? panelRef.current))?.focus();
  }, [open]);

  return (
    <span ref={wrapRef} className="yl-popover">
      <button
        ref={triggerRef}
        type="button"
        className={cx('yl-popover__trigger', triggerClassName)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        {...triggerProps}
      >
        {triggerContent}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className={cx(
            'yl-popover__panel',
            align === 'end' ? 'yl-popover__panel--end' : 'yl-popover__panel--start',
          )}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false, true);
            }
          }}
        >
          {typeof children === 'function'
            ? children({ close: () => setOpen(false, true) })
            : children}
        </div>
      ) : null}
    </span>
  );
}
