'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { UserCard } from '@yapilapi/api-client';
import { Avatar, Badge, LockIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';

/** One person in a list: avatar, name, handle, optional trailing actions. */
export function UserRow({
  user,
  actions,
}: {
  user: Pick<UserCard, 'username' | 'displayName' | 'avatarUrl'> &
    Partial<Pick<UserCard, 'isPrivate'>>;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li className="person-row">
      <Avatar name={user.displayName} src={user.avatarUrl} size="md" decorative />
      <div className="person-row__text">
        <Link
          href={`/u/${encodeURIComponent(user.username)}`}
          className="person-row__name"
          aria-label={t('post.authorLink', { name: user.displayName })}
        >
          {user.displayName}
        </Link>
        <span className="person-row__handle" dir="ltr">
          @{user.username}
        </span>
      </div>
      {user.isPrivate ? <Badge icon={<LockIcon size={12} />}>{t('profile.private')}</Badge> : null}
      {actions ? <div className="person-row__actions">{actions}</div> : null}
    </li>
  );
}
