'use client';

import Link from 'next/link';
import { BottomSheet, Icon, type IconName } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/**
 * The ways to create, behind the + in the middle of the navigation (docs/product/your-city-alive.md):
 * hide a stash first, then a post, a reel, a story, a live (while lives are on) or a Yap.
 */
const WAYS: { href: string; icon: IconName; label: MessageKey; show?: (flags: Record<string, boolean>) => boolean }[] = [
  { href: '/stash/new', icon: 'map-pin', label: 'stash.hide', show: (f) => f.STASH !== false },
  { href: '/camera', icon: 'image', label: 'm.create.mode.post' },
  { href: '/camera?mode=reel', icon: 'video', label: 'm.create.mode.reel' },
  { href: '/camera?mode=story', icon: 'sparkle', label: 'm.create.mode.story' },
  { href: '/live', icon: 'signal', label: 'm.live.title', show: (f) => !!f.LIVE },
  { href: '/create?mode=yap', icon: 'mic', label: 'm.create.mode.yap', show: (f) => f.YAPS !== false },
];

export function CreateMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, flags, locale } = useSession();
  return (
    <BottomSheet open={open} onClose={onClose} title={t('create.title')} locale={locale}>
      <nav className="create-menu" aria-label={t('create.title')}>
        {WAYS.filter((w) => !w.show || w.show(flags)).map((w) => (
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
