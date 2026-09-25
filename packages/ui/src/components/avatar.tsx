import { useState } from 'react';
import { useLowBandwidth } from '../context';
import { cx } from '../utils';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const TONES = 6;
function toneFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % TONES;
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]!][0] ?? '?';
  const second = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + second).toLocaleUpperCase();
}

/**
 * A "pebble" (soft rounded square) with the person's photo or their initials. In low-bandwidth mode photos are
 * not requested at all; initials are always available and always meet AA contrast.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  className,
  decorative = false,
}: {
  name: string;
  src?: string | null | undefined;
  size?: AvatarSize;
  className?: string;
  decorative?: boolean;
}) {
  const lowBw = useLowBandwidth();
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !lowBw && !failed;
  return (
    <span
      className={cx(
        'yl-avatar',
        `yl-avatar--${size}`,
        `yl-avatar--tone-${toneFor(name)}`,
        className,
      )}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {showImage ? (
        <img
          src={src!}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="yl-avatar__img"
        />
      ) : (
        <span aria-hidden="true" className="yl-avatar__initials">
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
