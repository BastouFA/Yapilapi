import { cx } from '../utils';

/** The YAPILAPI mark: a saffron sun rising behind a lagoon "Y" stem that opens into two ember arms. Original artwork. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-hidden="true"
      focusable="false"
      className={cx('yl-logo-mark', className)}
    >
      <rect width="48" height="48" rx="15" className="yl-logo-mark__bg" />
      <circle cx="24" cy="30" r="11" className="yl-logo-mark__sun" />
      <path
        d="M13 12.500 24 27M35 12.500 24 27M24 27v11"
        className="yl-logo-mark__y"
        fill="none"
        strokeWidth="5.500"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({
  name,
  size = 32,
  showWordmark = true,
  className,
}: {
  name: string;
  size?: number;
  showWordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={cx('yl-logo', className)}>
      <LogoMark size={size} />
      {showWordmark ? (
        <span className="yl-logo__word">{name}</span>
      ) : (
        <span className="yl-sr-only">{name}</span>
      )}
    </span>
  );
}
