'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@yapilapi/design-system';
import type { Announcement } from '@yapilapi/api-client';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';

/**
 * An announcement as it shows at the top of the app: the team's own words, as written (not
 * translated), with its link and a close button. `onClose` is left out in the admin's preview.
 */
export function AnnouncementView({ a, onClose, preview }: { a: Pick<Announcement, 'title' | 'body' | 'linkUrl'>; onClose?: () => void; preview?: boolean }) {
  const { t } = useSession();
  const external = !!a.linkUrl && !a.linkUrl.startsWith('/');
  return (
    <section className="announcement" role="region" aria-label={t('announcement.label')}>
      <Icon name="info" />
      <div className="announcement__body">
        <strong className="announcement__title" dir="auto">
          {a.title}
        </strong>
        <p className="announcement__text" dir="auto">
          {a.body}
        </p>
        {a.linkUrl ? (
          external ? (
            <a href={a.linkUrl} target="_blank" rel="noopener noreferrer" tabIndex={preview ? -1 : undefined}>
              {t('announcement.more')}
            </a>
          ) : (
            <Link href={a.linkUrl} tabIndex={preview ? -1 : undefined}>
              {t('announcement.more')}
            </Link>
          )
        ) : null}
      </div>
      {onClose ? (
        <button type="button" className="announcement__close" onClick={onClose} aria-label={t('announcement.close')}>
          <Icon name="x" size={18} />
        </button>
      ) : null}
    </section>
  );
}

/** The newest announcement you haven't closed, at the top of every page of the signed-in app. Closing it is remembered for your account. */
export function AnnouncementBanner() {
  const { toast } = useSession();
  const [a, setA] = useState<Announcement | null>(null);
  useEffect(() => {
    let live = true;
    api.announcements.current().then(
      (r) => live && setA(r.announcement),
      // A banner that can't load is simply not shown.
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!a) return null;
  return (
    <div className="announcement-slot">
      <AnnouncementView
        a={a}
        onClose={() => {
          const id = a.id;
          setA(null);
          api.announcements.dismiss(id).catch((e) => toast(errorMessage(e)));
        }}
      />
    </div>
  );
}
