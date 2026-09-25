'use client';

import { useState } from 'react';
import type { FollowState } from '@yapilapi/api-client';
import { Button } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';

/** Follow / unfollow button shared by search results and discover's "people to follow". */
export function FollowToggle({ username, initial }: { username: string; initial: FollowState }) {
  const { t } = useI18n();
  const api = useApi();
  const { user } = useSession();
  const [state, setState] = useState<FollowState>(initial);
  const [busy, setBusy] = useState(false);
  if (username === user.profile.username) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      if (state === 'none') {
        const r = await api.graph.follow(username);
        setState(r.status);
      } else {
        await api.graph.unfollow(username);
        setState('none');
      }
    } catch {
      /* leave state as-is; the row is not critical path */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={state === 'none' ? 'secondary' : 'soft'}
      loading={busy}
      loadingLabel={t('common.working')}
      onClick={() => void toggle()}
    >
      {state === 'active'
        ? t('discover.people.following')
        : state === 'pending'
          ? t('discover.people.requested')
          : t('discover.people.follow')}
    </Button>
  );
}
