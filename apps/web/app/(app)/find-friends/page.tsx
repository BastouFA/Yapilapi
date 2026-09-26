'use client';

import Link from 'next/link';
import { Card } from '@yapilapi/design-system';
import { FindFriends } from '@/components/FindFriends';
import { useSession } from '../../providers';

/** Find friends who are already on YAPILAPI from a pasted list of email addresses, and invite the others. */
export default function FindFriendsPage() {
  const { t } = useSession();
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('friends.title')}</h1>
        <Link href="/invite" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('invite.title')}
        </Link>
      </div>
      <Card>
        <FindFriends />
      </Card>
    </div>
  );
}
