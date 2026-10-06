'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, EmptyState } from '@yapilapi/design-system';
import Inbox from '@/app/(app)/inbox/page';
import { useSession } from '@/app/providers';

type InstallPrompt = Event & { prompt: () => Promise<void> };

/**
 * Yap mode: your chats on their own, like a messenger app. The list on the left and the open
 * chat on the right (one at a time on a phone), with no feed, rail or sidebar around them.
 * It installs as its own "Yap" app (app/(app)/yap/layout.tsx); YAPILAPI is one tap away.
 */
export function YapShell({ children }: { children: React.ReactNode }) {
  const { t } = useSession();
  const path = usePathname();
  const open = path !== '/yap';

  // Chrome, Edge and Android offer to install; Safari on iPhone and iPad is told how.
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [iosHint, setIosHint] = useState(false);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
    setIosHint(!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent));
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  return (
    <div className={`yap-mode${open ? ' yap-mode--open' : ''}`}>
      <header className="yap-mode__bar">
        <Link href="/yap" className="yap-mode__brand">
          <img src="/yap-icon.svg" alt="" width={28} height={28} />
          <span>Yap</span>
        </Link>
        <div className="row">
          {install ? (
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              onClick={async () => {
                await install.prompt();
                setInstall(null);
              }}
            >
              {t('yapMode.install')}
            </Button>
          ) : null}
          <Link href="/home" className="yp-btn yp-btn--ghost yp-btn--sm">
            <img src="/mark.svg" alt="" width={18} height={18} />
            {t('yapMode.backToApp')}
          </Link>
        </div>
      </header>
      {iosHint ? <p className="yap-mode__hint muted">{t('yapMode.installIos')}</p> : null}
      <div className="yap-mode__panes">
        <section className="yap-mode__list" aria-label={t('yapMode.title')}>
          <Inbox />
        </section>
        <section className="yap-mode__chat">{open ? children : <EmptyState title={t('yapMode.pick')} />}</section>
      </div>
    </div>
  );
}
