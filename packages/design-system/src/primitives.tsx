import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './icons.tsx';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

/** Open modals, innermost last: only the top one handles Tab and Escape. */
const modalStack: HTMLElement[] = [];

/**
 * Modal focus handling for dialogs, sheets and overlays: moves focus into the
 * container (give it tabIndex={-1}), keeps Tab and Shift+Tab inside it, closes
 * on Escape and returns focus to whatever had it before when it closes.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.push(node);
    if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== node) return;
      if (e.key === 'Escape' && escape.current) {
        e.preventDefault();
        escape.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === node || !node.contains(cur))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (cur === last || !node.contains(cur))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      modalStack.splice(modalStack.indexOf(node), 1);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading,
  block,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('yp-btn', `yp-btn--${variant}`, size !== 'md' && `yp-btn--${size}`, block && 'yp-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="yp-btn__spin" aria-hidden /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} /> : null}
    </button>
  );
}

type FieldBase = { label: string; hint?: string; error?: string; className?: string };
export type TextFieldProps = FieldBase &
  ((InputHTMLAttributes<HTMLInputElement> & { multiline?: false }) | (TextareaHTMLAttributes<HTMLTextAreaElement> & { multiline: true }));

export function TextField(props: TextFieldProps) {
  const { label, hint, error, className, multiline, id: idProp, ...rest } = props as FieldBase & { multiline?: boolean; id?: string } & Record<string, unknown>;
  const auto = useId();
  const id = idProp ?? auto;
  const hintId = `${id}-hint`;
  const common = { id, className: 'yp-input', 'aria-invalid': error ? true : undefined, 'aria-describedby': error || hint ? hintId : undefined };
  return (
    <div className={cx('yp-field', className)}>
      <label className="yp-field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea {...common} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
      ) : (
        <input {...common} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
      )}
      {error ? (
        <span id={hintId} className="yp-field__error">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="yp-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  hint,
  className,
  children,
  ...rest
}: { label: string; hint?: string; className?: string; children: ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className={cx('yp-field', className)}>
      <label className="yp-field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="yp-input" {...rest}>
        {children}
      </select>
      {hint ? <span className="yp-field__hint">{hint}</span> : null}
    </div>
  );
}

export function Checkbox({ label, description, className, ...rest }: { label: ReactNode; description?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cx('yp-check', className)}>
      <input type="checkbox" {...rest} />
      <span>
        {label}
        {description ? <span className="yp-check__desc">{description}</span> : null}
      </span>
    </label>
  );
}

export function Switch({
  label,
  checked,
  defaultChecked,
  onChange,
  disabled,
  className,
}: {
  label?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const controlled = checked !== undefined;
  const [inner, setInner] = useState(!!defaultChecked);
  const on = controlled ? checked : inner;
  const id = useId();
  return (
    <span className={cx('yp-switch', className)}>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={on}
        disabled={disabled}
        onClick={() => {
          if (!controlled) setInner(!on);
          onChange?.(!on);
        }}
      />
      {label ? <label htmlFor={id}>{label}</label> : null}
    </span>
  );
}

export function Badge({
  tone = 'neutral',
  dot,
  children,
  className,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'new';
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx('yp-badge', `yp-badge--${tone}`, (dot === false || tone === 'new') && 'yp-badge--plain', className)}>{children}</span>;
}

const ALERT_ICON: Record<string, IconName> = { info: 'info', success: 'check-circle', warning: 'alert', danger: 'x-circle' };
export function Alert({
  tone = 'info',
  title,
  onDismiss,
  children,
  className,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  onDismiss?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('yp-alert', `yp-alert--${tone}`, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={ALERT_ICON[tone]!} />
      <div className="yp-alert__body">
        {title ? <strong className="yp-alert__title">{title}</strong> : null}
        {children}
      </div>
      {onDismiss ? (
        <button type="button" className="yp-alert__close" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" size={18} />
        </button>
      ) : null}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  action,
  footer,
  raised,
  onClick,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  raised?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('yp-card', raised && 'yp-card--raised', onClick && 'yp-card--interactive', className)} onClick={onClick}>
      {title || subtitle || action ? (
        <header className="yp-card__head">
          <div>
            {title ? <h3 className="yp-card__title">{title}</h3> : null}
            {subtitle ? <p className="yp-card__sub">{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      <div className="yp-card__body">{children}</div>
      {footer ? <footer className="yp-card__foot">{footer}</footer> : null}
    </section>
  );
}

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  content?: ReactNode;
}
/**
 * Tabs. Pass `content` per tab to have the panel rendered here, or render the
 * panel yourself: give it role="tabpanel", id={panelId} and
 * aria-labelledby={`${id}-${selectedTabId}`}, and pass `id` and `panelId`.
 */
export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  className,
  id,
  panelId,
}: {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  className?: string;
  id?: string;
  panelId?: string;
}) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? tabs[0]?.id);
  const cur = controlled ? value : inner;
  const auto = useId();
  const base = id ? `${id}-` : auto;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const select = (id: string) => {
    if (!controlled) setInner(id);
    onChange?.(id);
  };
  const active = tabs.find((t) => t.id === cur);
  return (
    <div className={cx('yp-tabs', className)}>
      <div
        className="yp-tabs__list"
        role="tablist"
        onKeyDown={(e) => {
          const i = tabs.findIndex((t) => t.id === cur);
          const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
          if (n === undefined) return;
          e.preventDefault();
          const next = tabs[(n + tabs.length) % tabs.length]!;
          select(next.id);
          refs.current[next.id]?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}${t.id}`}
            aria-selected={t.id === cur}
            // Only the selected tab's panel is rendered, so only it can be referenced.
            aria-controls={t.id !== cur ? undefined : t.content !== undefined ? `${base}${t.id}-panel` : panelId}
            tabIndex={t.id === cur ? 0 : -1}
            className="yp-tabs__tab"
            onClick={() => select(t.id)}
          >
            {t.label}
            {t.count !== undefined ? <span className="yp-tabs__count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {active?.content !== undefined ? (
        <div className="yp-tabs__panel" role="tabpanel" id={`${base}${active.id}-panel`} aria-labelledby={`${base}${active.id}`}>
          {active.content}
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}
export function Avatar({
  name,
  src,
  size = 'md',
  online,
  className,
}: {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  online?: boolean;
  className?: string;
}) {
  const style = size === 'xl' ? { width: 88, height: 88, fontSize: 28 } : undefined;
  return (
    <span className={cx('yp-avatar', `yp-avatar--${size === 'xl' ? 'lg' : size}`, className)} style={style} title={name} role="img" aria-label={name}>
      {src ? <img src={src} alt="" /> : initials(name)}
      {online ? <span className="yp-avatar__status" /> : null}
    </span>
  );
}
export function AvatarGroup({ children }: { children: ReactNode }) {
  return <span className="yp-avatars">{children}</span>;
}

export function Dialog({
  open,
  onClose,
  title,
  footer,
  inline,
  children,
  className,
}: {
  open: boolean;
  onClose?: () => void;
  title: string;
  footer?: ReactNode;
  inline?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, open && !inline, onClose);
  if (!open) return null;
  const box = (
    <div
      ref={ref}
      tabIndex={-1}
      role={inline ? 'group' : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-labelledby={titleId}
      className={cx('yp-dialog', inline && 'yp-dialog--inline', className)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="yp-dialog__head">
        <h2 className="yp-dialog__title" id={titleId}>
          {title}
        </h2>
      </div>
      <div className="yp-dialog__body">{children}</div>
      {footer ? <div className="yp-dialog__foot">{footer}</div> : null}
    </div>
  );
  return inline ? (
    box
  ) : (
    <div className="yp-dialog__backdrop" onClick={onClose}>
      {box}
    </div>
  );
}
