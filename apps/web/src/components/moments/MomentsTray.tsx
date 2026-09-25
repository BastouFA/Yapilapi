'use client';

import Link from 'next/link';
import { Avatar, PlusIcon, cx } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';

/** Horizontal tray of people's active moments, shown at the top of the home feed. */
export function MomentsTray() {
  const api = useApi();
  const { t } = useI18n();
  const { user } = useSession();
  const tray = useAsync((signal) => api.moments.tray(20, { signal }), [api]);

  if (tray.error) {
    // Decorative on the home feed: fail quietly with a small inline retry rather than an error block.
    return (
      <button type="button" className="link-btn" onClick={tray.reload}>
        {t('common.retry')}
      </button>
    );
  }

  // While the tray is still loading, tray.data is undefined: guard both chained property accesses,
  // not just the first, so an in-flight request never crashes the whole home feed.
  const mine = tray.data?.groups?.find((g) => g.author.username === user.profile.username);
  const others =
    tray.data?.groups?.filter((g) => g.author.username !== user.profile.username) ?? [];

  return (
    <ul className="moments-tray" aria-label={t('moments.trayLabel')}>
      <li className="moments-tray__item">
        <Link
          href="/moments/new"
          className="moments-tray__ring"
          aria-label={t('moments.addMoment')}
        >
          {mine ? (
            <Avatar
              name={user.profile.displayName}
              src={user.profile.avatarUrl}
              size="lg"
              decorative
            />
          ) : (
            <span className="moments-tray__add">
              <PlusIcon size={20} />
            </span>
          )}
        </Link>
        <span className="moments-tray__name">{t('moments.yourMoment')}</span>
      </li>
      {tray.loading
        ? Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="moments-tray__item" aria-hidden="true">
              <span className="moments-tray__ring moments-tray__skeleton" />
            </li>
          ))
        : others.map((g) => (
            <li key={g.author.username} className="moments-tray__item">
              <Link
                href={`/moments/${encodeURIComponent(g.author.username)}`}
                className={cx('moments-tray__ring', g.hasUnseen && 'has-unseen')}
              >
                <Avatar name={g.author.displayName} src={g.author.avatarUrl} size="lg" decorative />
              </Link>
              <span className="moments-tray__name">{g.author.displayName}</span>
            </li>
          ))}
    </ul>
  );
}
