'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Skeleton } from '@yapilapi/design-system';
import type { StoryGroup } from '@yapilapi/api-client';
import { api, errorMessage, isGone } from '@/lib/api';
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
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setMissing(false);
    setLoadError(null);
    api.moments.get(id).then(
      (r) => setGroups([r.group]),
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    setGroups(null);
    load();
  }, [load]);

  const close = () => (window.history.length > 1 ? router.back() : router.push('/home'));

  if (missing)
    return (
      <div className="yp-shell__inner">
        <EmptyState
          level={1}
          title={t('m.stories.unavailable')}
          body={t('m.stories.unavailableBody')}
          action={<Link href="/home">{t('storyPage.goHome')}</Link>}
        />
      </div>
    );
  if (!groups && loadError)
    return (
      <div className="yp-shell__inner">
        <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />
      </div>
    );
  if (!groups) return <Skeleton height={320} />;
  if (!groups[0]) return null;
  return <StoryViewer key={id} groups={groups} start={0} onClose={close} onChange={(next) => (next.length ? setGroups(next) : close())} />;
}
