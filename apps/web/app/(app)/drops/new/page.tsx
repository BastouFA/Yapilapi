'use client';

import Link from 'next/link';
import { EmptyState } from '@yapilapi/design-system';
import { DropEditor } from '@/components/DropEditor';
import { useSession } from '../../../providers';

/** Announce a launch: a new drop, saved as a draft or published. */
export default function NewDropPage() {
  const { t, flags } = useSession();
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.drops.new')}</h1>
        <Link href="/drops" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('m.drops.yours')}
        </Link>
      </div>
      {flags.COMMERCE === false ? <EmptyState title={t('m.drops.title')} body={t('shop.unavailable')} /> : <DropEditor />}
    </div>
  );
}
