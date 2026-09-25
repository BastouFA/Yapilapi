import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../utils';

// ------------------------------------------------------------------ VisuallyHidden / SkipLink
export function VisuallyHidden({
  as: Tag = 'span',
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: 'span' | 'div' | 'p' | 'h2' | 'h3' | 'label' }) {
  const T = Tag as 'span';
  return (
    <T className="yl-sr-only" {...rest}>
      {children}
    </T>
  );
}

/** First focusable element on the page: jumps past navigation to the main landmark. */
export function SkipLink({ href = '#main', children }: { href?: string; children: ReactNode }) {
  return (
    <a className="yl-skip-link" href={href}>
      {children}
    </a>
  );
}

// ------------------------------------------------------------------ Spinner
export function Spinner({
  label,
  size = 'md',
  className,
}: {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span role="status" className={cx('yl-spinner', `yl-spinner--${size}`, className)}>
      <span className="yl-spinner__ring" aria-hidden="true" />
      <span className="yl-sr-only">{label}</span>
    </span>
  );
}

// ------------------------------------------------------------------ Button
export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Class names for anything that should look like a button (e.g. a router <Link>). */
export const buttonClass = (
  o: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {},
): string =>
  cx(
    'yl-btn',
    `yl-btn--${o.variant ?? 'primary'}`,
    `yl-btn--${o.size ?? 'md'}`,
    o.fullWidth && 'yl-btn--block',
    o.className,
  );

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Screen-reader text announced while loading (required for localisation). */
  loadingLabel?: string;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    loading,
    loadingLabel,
    fullWidth,
    leadingIcon,
    trailingIcon,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, fullWidth, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="yl-btn__spinner" aria-hidden="true" /> : leadingIcon}
      <span className="yl-btn__label">{children}</span>
      {loading && loadingLabel ? (
        <span className="yl-sr-only" role="status">
          {loadingLabel}
        </span>
      ) : null}
      {!loading ? trailingIcon : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  /** Accessible name. Required: icon-only buttons have no visible text. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'soft' | 'primary' | 'secondary';
  size?: ButtonSize;
  /** Toggle state (aria-pressed). */
  pressed?: boolean | undefined;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', pressed, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx('yl-iconbtn', `yl-iconbtn--${variant}`, `yl-iconbtn--${size}`, className)}
      {...rest}
    >
      {icon}
    </button>
  );
});

// ------------------------------------------------------------------ Badge
export type BadgeTone =
  'neutral' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; icon?: ReactNode }) {
  return (
    <span className={cx('yl-badge', `yl-badge--${tone}`, className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ Card
export function Card({
  as: Tag = 'div',
  padding = 'md',
  interactive,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article' | 'li';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  interactive?: boolean;
}) {
  const T = Tag as 'div';
  return (
    <T
      className={cx(
        'yl-card',
        `yl-card--pad-${padding}`,
        interactive && 'yl-card--interactive',
        className,
      )}
      {...rest}
    >
      {children}
    </T>
  );
}

// ------------------------------------------------------------------ Skeleton
/** Decorative loading placeholder. Sizes are preset classes (no inline styles, so strict CSPs stay happy). */
export function Skeleton({
  shape = 'text',
  width,
  height,
  className,
}: {
  shape?: 'text' | 'rect' | 'circle' | 'pebble';
  width?: 'xs' | 'sm' | 'md' | 'lg' | 'full';
  height?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'yl-skeleton',
        `yl-skeleton--${shape}`,
        width && `yl-skeleton--w-${width}`,
        height && `yl-skeleton--h-${height}`,
        className,
      )}
    />
  );
}

// ------------------------------------------------------------------ EmptyState / ErrorState
export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 2,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const H = `h${headingLevel}` as 'h2';
  return (
    <div className="yl-state">
      {icon ? (
        <div className="yl-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <H className="yl-state__title">{title}</H>
      {description ? <p className="yl-state__desc">{description}</p> : null}
      {action ? <div className="yl-state__action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  referenceLabel,
  requestId,
  icon,
}: {
  title: string;
  description?: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
  referenceLabel?: string;
  requestId?: string | null;
  icon?: ReactNode;
}) {
  return (
    <div className="yl-state yl-state--error" role="alert">
      {icon ? (
        <div className="yl-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h2 className="yl-state__title">{title}</h2>
      {description ? <p className="yl-state__desc">{description}</p> : null}
      {onRetry && retryLabel ? (
        <div className="yl-state__action">
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
      {requestId && referenceLabel ? (
        <p className="yl-state__ref">
          {referenceLabel}: <code>{requestId}</code>
        </p>
      ) : null}
    </div>
  );
}
