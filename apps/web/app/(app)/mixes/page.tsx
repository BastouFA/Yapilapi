'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Segments } from '@yapilapi/design-system';
import type { Mix, MixFilter } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { MixEditor, MixGrid } from '@/components/Mixes';
import { useSession } from '../../providers';

/** "Your mixes": the ones you made, the ones shared with you in chats, and the ones you saved. Making a mix starts here. */
export default function MixesPage() {
  const { t } = useSession();
  const router = useRouter();
  const [filter, setFilter] = useState<MixFilter>('own');
  const [items, setItems] = useState<Mix[] | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setItems(null);
    api.mixes.mine(filter).then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, [filter]);

  const empty =
    filter === 'own'
      ? { title: t('mixes.emptyOwn.title'), body: t('mixes.emptyOwn.body') }
      : filter === 'shared'
        ? { title: t('mixes.emptyShared.title'), body: t('mixes.emptyShared.body') }
        : { title: t('mixes.emptySaved.title') };
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('mixes.title')}</h1>
        <Button size="sm" onClick={() => setEditing(true)}>
          {t('mixes.new')}
        </Button>
      </div>
      <Segments
        label={t('mixes.title')}
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'own', label: t('mixes.filter.own') },
          { id: 'shared', label: t('mixes.filter.shared') },
          { id: 'saved', label: t('mixes.filter.saved') },
        ]}
      />
      <MixGrid items={items} empty={empty} />
      <MixEditor open={editing} onClose={() => setEditing(false)} onSaved={(m) => router.push(`/mixes/${m.id}`)} />
    </div>
  );
}
