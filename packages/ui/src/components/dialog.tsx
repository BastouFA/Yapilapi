import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, getFocusable, trapTab } from '../utils';
import { IconButton } from './primitives';
import { CloseIcon } from './icons';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Accessible name of the close button (required for localisation). */
  closeLabel: string;
  /** `dialog` is centred; `sheet` slides up from the bottom on phones and docks to the end edge on wide screens. */
  variant?: 'dialog' | 'sheet';
  /** Footer actions (buttons). */
  footer?: ReactNode;
  /** Clicking the scrim / pressing Esc closes. Set false for destructive confirmations mid-request. */
  dismissible?: boolean;
  /** Element that should receive focus first (defaults to the first focusable element in the body). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * Modal dialog: role="dialog" + aria-modal, labelled by its title, focus moves in on open and is trapped,
 * Escape closes, focus returns to the opener, page scroll is locked and the rest of the page is made inert.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  closeLabel,
  variant = 'dialog',
  footer,
  dismissible = true,
  initialFocusRef,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current!;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Make the rest of the app inert while the modal is open.
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(document.body.children) as HTMLElement[]) {
      if (el.contains(panel) || el.hasAttribute('data-yl-portal')) continue;
      if (!el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        inerted.push(el);
      }
    }

    const focusTarget =
      initialFocusRef?.current ??
      getFocusable(panel).find((el) => !el.hasAttribute('data-dialog-close')) ??
      panel;
    focusTarget.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onCloseRef.current();
      } else trapTab(panel, e);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      for (const el of inerted) el.removeAttribute('inert');
      if (opener && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dismissible]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className={cx('yl-dialog-root', `yl-dialog-root--${variant}`)} data-yl-portal="">
      <div
        className="yl-dialog-scrim"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx('yl-dialog', `yl-dialog--${variant}`, className)}
      >
        <div className="yl-dialog__header">
          <h2 id={titleId} className="yl-dialog__title">
            {title}
          </h2>
          <IconButton
            label={closeLabel}
            icon={<CloseIcon />}
            onClick={onClose}
            disabled={!dismissible}
            data-dialog-close=""
            size="sm"
          />
        </div>
        {description ? (
          <p id={descId} className="yl-dialog__desc">
            {description}
          </p>
        ) : null}
        <div className="yl-dialog__body">{children}</div>
        {footer ? <div className="yl-dialog__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet(props: Omit<DialogProps, 'variant'>) {
  return <Dialog {...props} variant="sheet" />;
}
