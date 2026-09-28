'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button, EmptyState, Skeleton } from '@yapilapi/design-system';
import { dropPhase } from '@yapilapi/shared';
import { DropEditor } from '@/components/DropEditor';
import { useDrop } from '@/components/Drops';
import { useSession } from '../../../../providers';

/** Change a draft, or a published drop before it opens. */
export default function EditDropPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useSession();
  const { drop, missing, loadError, reload, now } = useDrop(id);
  if (missing) return <EmptyState title={t('m.drops.missing')} />;
  if (!drop && loadError) return <EmptyState title={loadError} action={<Button onClick={() => void reload()}>{t('m.common.retry')}</Button>} />;
  if (!drop) return <Skeleton height={320} />;
  const phase = dropPhase(drop, now);
  if (!drop.isSeller || (phase !== 'draft' && phase !== 'upcoming'))
    return (
      <EmptyState
        title={t('m.drops.cantEdit')}
        action={
          <Link href={`/drops/${id}`} className="yp-btn yp-btn--secondary">
            {t('m.drops.back')}
          </Link>
        }
      />
    );
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.drops.edit')}</h1>
      </div>
      <DropEditor drop={drop} />
    </div>
  );
}
