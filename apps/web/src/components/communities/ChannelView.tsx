'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { ChatView } from '@/components/chat/ChatView';

/** A community channel is a conversation; the community page provides the way back and the community's name. */
export function ChannelView({ idOrSlug, channelId }: { idOrSlug: string; channelId: string }) {
  const { t } = useI18n();
  const api = useApi();
  const comm = useAsync((signal) => api.communities.get(idOrSlug, { signal }), [api, idOrSlug]);
  const name = comm.data?.name ?? '';
  const href = `/communities/${encodeURIComponent(idOrSlug)}`;
  return (
    <div className="commhub-wide channel-page">
      <ChatView
        conversationId={channelId}
        backHref={href}
        backLabel={name || t('community.toList')}
        subtitle={
          comm.data ? (
            <Link href={href} className="chat__sub">
              {t('community.channelOf', { name })}
            </Link>
          ) : null
        }
      />
    </div>
  );
}
