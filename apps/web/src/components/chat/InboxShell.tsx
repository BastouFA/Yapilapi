'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { InboxItem, Message } from '@yapilapi/api-client';
import {
  Button,
  ConversationRow,
  EmptyState,
  CommentIcon,
  PlusIcon,
  UsersIcon,
  Skeleton,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { useRealtime, useRealtimeEvents } from '@/lib/realtime';
import { useChatLabels } from '@/lib/labels';
import { conversationTitle, sortInbox } from '@/lib/chat-state';
import { ErrorView, InfiniteFooter } from '@/components/common';
import { NewGroupDialog, NewMessageDialog } from './NewConversation';

/** Two panes on wide screens (list + conversation); one at a time on narrow screens. */
export function InboxShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const currentId = pathname.startsWith('/inbox/') ? (pathname.split('/')[2] ?? null) : null;
  return (
    <div className="inbox" data-view={currentId ? 'chat' : 'list'}>
      <InboxList currentId={currentId} />
      <div className="inbox__pane">{children}</div>
    </div>
  );
}

function previewOf(m: InboxItem['lastMessage'], attachment: string): string {
  if (!m) return '';
  return m.preview || (m.kind !== 'text' ? attachment : '');
}

function InboxList({ currentId }: { currentId: string | null }) {
  const { t } = useI18n();
  const api = useApi();
  const { user } = useSession();
  const rt = useRealtime();
  const labels = useChatLabels('');
  const [dialog, setDialog] = useState<'dm' | 'group' | null>(null);
  const state = useInfinite(
    (cursor, signal) =>
      api.conversations.list({ ...(cursor ? { cursor } : {}), limit: 30, signal }),
    'inbox',
  );
  const { setItems } = state;
  usePageTitle(currentId ? undefined : t('inbox.title'), t('app.name'));

  // Refetch the first page and merge it in, without flashing the list back to a loading state.
  const refreshSoon = useCallback(() => {
    api.conversations.list({ limit: 30 }).then(
      (page) => {
        setItems((prev) => {
          const fresh = new Map(page.items.map((c) => [c.id, c]));
          const kept = prev.filter((c) => !fresh.has(c.id));
          return sortInbox([...page.items, ...kept]);
        });
      },
      () => undefined,
    );
  }, [api, setItems]);

  // Conversations created after the socket connected are not pushed until subscribed.
  const { ensure } = rt;
  useEffect(() => {
    for (const c of state.items) ensure(c.id);
  }, [state.items, ensure]);

  useRealtimeEvents((e) => {
    const cid = (e as { conversationId?: string }).conversationId;
    switch (e.type) {
      case 'rt.reconnected':
      case 'rt.inbox-changed':
        return refreshSoon();
      case 'conversation.added':
        return refreshSoon();
      case 'conversation.removed':
        return setItems((prev) => prev.filter((c) => c.id !== cid));
      case 'conversation.updated':
        return setItems((prev) =>
          prev.map((c) => (c.id === cid ? { ...c, title: (e as { title: string }).title } : c)),
        );
      case 'conversation.read':
        if ((e as { userId?: string }).userId === user.id)
          setItems((prev) => prev.map((c) => (c.id === cid ? { ...c, unreadCount: 0 } : c)));
        return;
      case 'message.new': {
        const m = (e as { message: Message }).message;
        let known = false;
        setItems((prev) => {
          known = prev.some((c) => c.id === cid);
          return sortInbox(
            prev.map((c) =>
              c.id === cid
                ? {
                    ...c,
                    lastMessageAt: m.createdAt,
                    lastMessage: {
                      id: m.id,
                      senderId: m.senderId,
                      kind: m.kind,
                      preview: m.body.slice(0, 140),
                      createdAt: m.createdAt,
                    },
                    unreadCount:
                      m.senderId === user.id || cid === currentId
                        ? c.unreadCount
                        : Math.min(100, c.unreadCount + 1),
                  }
                : c,
            ),
          );
        });
        // A conversation we have not loaded yet (for example a brand-new one): fetch the list again.
        queueMicrotask(() => {
          if (!known) refreshSoon();
        });
        return;
      }
    }
  });

  const fallback = {
    group: t('inbox.unnamedGroup'),
    channel: t('inbox.channel'),
    person: t('inbox.someone'),
  };
  const headingLevel = currentId ? 'h2' : 'h1';
  const Heading = headingLevel;

  return (
    <section className="inbox__list" aria-labelledby="inbox-h">
      <div className="inbox__head">
        <Heading id="inbox-h" className="inbox__title">
          {t('inbox.title')}
        </Heading>
        <div className="inbox__actions">
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<PlusIcon size={16} />}
            onClick={() => setDialog('dm')}
            data-testid="new-message"
          >
            {t('inbox.newMessage')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<UsersIcon size={16} />}
            onClick={() => setDialog('group')}
            data-testid="new-group"
          >
            {t('inbox.newGroup')}
          </Button>
        </div>
      </div>
      {rt.status === 'reconnecting' ? (
        <p className="yl-notice yl-notice--warning inbox__notice" role="status">
          {t('inbox.reconnecting')}
        </p>
      ) : null}
      {rt.status === 'offline' ? (
        <p className="yl-notice yl-notice--warning inbox__notice" role="status">
          {t('inbox.offline')}
        </p>
      ) : null}
      {state.loading ? (
        <div className="inbox__skeleton" role="status" aria-busy="true">
          <span className="yl-sr-only">{t('common.loading')}</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width="full" height="lg" />
          ))}
        </div>
      ) : state.error ? (
        <ErrorView error={state.error} onRetry={state.reload} />
      ) : state.items.length === 0 ? (
        <EmptyState
          icon={<CommentIcon size={28} />}
          title={t('inbox.emptyTitle')}
          description={t('inbox.emptyBody')}
          headingLevel={currentId ? 3 : 2}
        />
      ) : (
        <ul className="inbox__rows" aria-label={t('inbox.list')}>
          {state.items.map((c) => (
            <li key={c.id}>
              <ConversationRow
                title={conversationTitle(c, fallback)}
                avatarName={conversationTitle(c, fallback)}
                avatarSrc={c.peer?.avatarUrl ?? null}
                href={`/inbox/${c.id}`}
                preview={previewOf(c.lastMessage, t('inbox.attachment')) || null}
                previewPrefix={c.lastMessage?.senderId === user.id ? t('inbox.you') : null}
                time={c.lastMessage?.createdAt ?? c.lastMessageAt}
                unread={c.id === currentId ? 0 : c.unreadCount}
                muted={c.muted}
                pinned={c.pinned}
                {...(c.id === currentId ? { current: true } : {})}
                labels={labels.row}
              />
            </li>
          ))}
        </ul>
      )}
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
      <NewMessageDialog
        open={dialog === 'dm'}
        onClose={() => setDialog(null)}
        onCreated={refreshSoon}
      />
      <NewGroupDialog
        open={dialog === 'group'}
        onClose={() => setDialog(null)}
        onCreated={refreshSoon}
      />
    </section>
  );
}

export function InboxPlaceholder() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<CommentIcon size={28} />}
      title={t('inbox.pickTitle')}
      description={t('inbox.pickBody')}
    />
  );
}
