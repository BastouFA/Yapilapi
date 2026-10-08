'use client';

import Link from 'next/link';
import { BottomSheet, Icon, type IconName } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/**
 * The other ways to create, behind the Yap button (docs/product/yaps.md, "Naming"): hold the
 * button down (or right-click it, or use the small + beside it on a computer) for a post, a reel,
 * a story or a live. A tap on the Yap button itself opens the recorder.
 */
const WAYS: { href: string; icon: IconName; label: MessageKey; flag?: string }[] = [
  { href: '/camera', icon: 'image', label: 'm.create.mode.post' },
  { href: '/camera?mode=reel', icon: 'video', label: 'm.create.mode.reel' },
  { href: '/camera?mode=story', icon: 'sparkle', label: 'm.create.mode.story' },
  { href: '/live', icon: 'signal', label: 'm.live.title', flag: 'LIVE' },
];

export function CreateMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, flags, locale } = useSession();
  return (
    <BottomSheet open={open} onClose={onClose} title={t('nav.createMore')} locale={locale}>
      <nav className="create-menu" aria-label={t('nav.createMore')}>
        {WAYS.filter((w) => !w.flag || flags[w.flag] !== false).map((w) => (
          <Link key={w.href} href={w.href} className="create-menu__row" onClick={onClose}>
            <span className="create-menu__icon" aria-hidden>
              <Icon name={w.icon} size={22} />
            </span>
            {t(w.label)}
          </Link>
        ))}
      </nav>
    </BottomSheet>
  );
}
