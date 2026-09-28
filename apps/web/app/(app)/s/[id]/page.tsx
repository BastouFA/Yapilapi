'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState, Skeleton } from '@yapilapi/design-system';
import type { StoryGroup } from '@yapilapi/api-client';
import { api } from '@/lib/api';
import { StoryViewer } from '@/components/StoryViewer';
import { useSession } from '../../../providers';

/**
 * One story, opened from a link, a story card in a chat, a reshare or a
 * notification. It opens only for people who can see it.
 */
export default function StoryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t } = useSession();
  const [groups, setGroups] = useState<StoryGroup[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setGroups(null);
    setMissing(false);
    api.moments.get(id).then(
      (r) => setGroups([r.group]),
      () => setMissing(true),
    );
  }, [id]);

  const close = () => (window.history.length > 1 ? router.back() : router.push('/home'));

  if (missing)
    return (
      <div className="yp-shell__inner">
        <EmptyState title={t('m.stories.unavailable')} body={t('m.stories.unavailableBody')} action={<Link href="/home">{t('storyPage.goHome')}</Link>} />
      </div>
    );
  if (!groups) return <Skeleton height={320} />;
  if (!groups[0]) return null;
  return <StoryViewer key={id} groups={groups} start={0} onClose={close} onChange={(next) => (next.length ? setGroups(next) : close())} />;
}
