'use client';

import Link from 'next/link';
import type { AnchorHTMLAttributes } from 'react';
import { useLowBandwidth } from '@yapilapi/ui';

/** next/link adapter for @yapilapi/ui. Prefetching is disabled in low-bandwidth mode. */
export function AppLink({
  href,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const lowBw = useLowBandwidth();
  const external = /^(https?:)?\/\//.test(href) || href.startsWith('mailto:');
  if (external) return <a href={href} {...rest} />;
  return <Link href={href} prefetch={lowBw ? false : undefined} {...rest} />;
}
