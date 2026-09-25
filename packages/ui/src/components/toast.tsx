import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../utils';
import { IconButton } from './primitives';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './icons';

export type ToastTone = 'neutral' | 'success' | 'danger' | 'info';
export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms before auto-dismiss; 0 = sticky. Default 6000 (errors 9000). */
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}
interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (t: ToastInput) => number;
  dismiss: (id: number) => void;
}
const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const c = useContext(ToastContext);
  if (!c) throw new Error('useToast() requires <ToastProvider>');
  return c;
}

const ICONS = { neutral: InfoIcon, info: InfoIcon, success: CheckIcon, danger: AlertIcon } as const;

/**
 * Toasts are announced through persistent live regions: `role="status"` (polite) for normal messages and
 * `role="alert"` (assertive) for errors. Timers pause while a toast is hovered or focused.
 */
export function ToastProvider({
  children,
  regionLabel,
  dismissLabel,
}: {
  children: ReactNode;
  regionLabel: string;
  dismissLabel: string;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setItems((l) => [...l.slice(-3), { ...t, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const polite = items.filter((t) => t.tone !== 'danger');
  const assertive = items.filter((t) => t.tone === 'danger');
  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted
        ? createPortal(
            <div
              className="yl-toast-region"
              role="region"
              aria-label={regionLabel}
              data-yl-portal=""
            >
              <div role="status" aria-live="polite" aria-atomic="false" className="yl-toast-list">
                {polite.map((t) => (
                  <ToastView key={t.id} item={t} dismissLabel={dismissLabel} onDismiss={dismiss} />
                ))}
              </div>
              <div role="alert" aria-live="assertive" aria-atomic="false" className="yl-toast-list">
                {assertive.map((t) => (
                  <ToastView key={t.id} item={t} dismissLabel={dismissLabel} onDismiss={dismiss} />
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

function ToastView({
  item,
  onDismiss,
  dismissLabel,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
  dismissLabel: string;
}) {
  const tone = item.tone ?? 'neutral';
  const Icon = ICONS[tone];
  const [paused, setPaused] = useState(false);
  const duration = item.durationMs ?? (tone === 'danger' ? 9000 : 6000);
  useEffect(() => {
    if (duration === 0 || paused) return;
    const t = setTimeout(() => onDismiss(item.id), duration);
    return () => clearTimeout(t);
  }, [duration, paused, item.id, onDismiss]);
  return (
    <div
      className={cx('yl-toast', `yl-toast--${tone}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={20} className="yl-toast__icon" />
      <div className="yl-toast__body">
        <p className="yl-toast__title">{item.title}</p>
        {item.description ? <p className="yl-toast__desc">{item.description}</p> : null}
        {item.action ? (
          <button
            type="button"
            className="yl-toast__action"
            onClick={() => {
              item.action!.onClick();
              onDismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <IconButton
        label={dismissLabel}
        icon={<CloseIcon size={16} />}
        size="sm"
        onClick={() => onDismiss(item.id)}
      />
    </div>
  );
}
