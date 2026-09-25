'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiError, type Conversation } from '@yapilapi/api-client';
import {
  Avatar,
  ChatComposer,
  ChevronStartIcon,
  EmptyState,
  IconButton,
  InfoIcon,
  MessageList,
  Skeleton,
  buttonClass,
  useToast,
  type ChatMessageData,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { useRealtime, useRealtimeEvents } from '@/lib/realtime';
import { useChatLabels } from '@/lib/labels';
import { conversationTitle, isSeenBy } from '@/lib/chat-state';
import { describeError } from '@/lib/errors';
import { ConfirmDialog, ErrorView } from '@/components/common';
import { ConversationDetails } from './ConversationDetails';
import { useChat } from './useChat';

/** One conversation: header, live message log, composer. Used for direct chats, groups and community channels. */
export function ChatView({
  conversationId,
  backHref = '/inbox',
  backLabel,
  subtitle,
}: {
  conversationId: string;
  backHref?: string;
  backLabel?: string;
  subtitle?: React.ReactNode;
}) {
  const { t } = useI18n();
  const api = useApi();
  const toast = useToast();
  const conv = useAsync(
    (signal) => api.conversations.get(conversationId, { signal }),
    [api, conversationId],
  );
  const c = conv.data;
  const title = c
    ? conversationTitle(c, {
        group: t('inbox.unnamedGroup'),
        channel: t('inbox.channel'),
        person: t('inbox.someone'),
      })
    : '';
  usePageTitle(c ? title : undefined, t('app.name'));

  if (conv.loading && !c) return <ChatSkeleton />;
  if (conv.error && !c) {
    if (
      conv.error instanceof ApiError &&
      (conv.error.status === 404 || conv.error.status === 403)
    ) {
      return (
        <EmptyState
          title={t('chat.notFoundTitle')}
          description={t('chat.notFoundBody')}
          action={
            <Link href={backHref} className={buttonClass({ variant: 'primary' })}>
              {backLabel ?? t('chat.toInbox')}
            </Link>
          }
        />
      );
    }
    return <ErrorView error={conv.error} onRetry={conv.reload} />;
  }
  if (!c) return null;
  return (
    <ChatBody
      key={c.id}
      conv={c}
      title={title}
      backHref={backHref}
      backLabel={backLabel ?? t('chat.back')}
      subtitle={subtitle}
      reloadConv={conv.reload}
      toast={toast}
    />
  );
}

function ChatSkeleton() {
  const { t } = useI18n();
  return (
    <div className="chat chat--loading" role="status" aria-busy="true">
      <span className="yl-sr-only">{t('common.loading')}</span>
      <Skeleton width="md" height="lg" />
      <Skeleton width="full" height="xl" />
    </div>
  );
}

function ChatBody({
  conv,
  title,
  backHref,
  backLabel,
  subtitle,
  reloadConv,
  toast,
}: {
  conv: Conversation;
  title: string;
  backHref: string;
  backLabel: string;
  subtitle: React.ReactNode;
  reloadConv: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { t } = useI18n();
  const { user } = useSession();
  const rt = useRealtime();
  const labels = useChatLabels(title);
  const [replyTo, setReplyTo] = useState<ChatMessageData | null>(null);
  const [details, setDetails] = useState(false);
  const [toDelete, setToDelete] = useState<ChatMessageData | null>(null);
  const [deleting, setDeleting] = useState(false);

  const chat = useChat(conv.id, (kind, e) => {
    const d = describeError(e, t);
    if (d.unauthenticated) return;
    toast.show({
      tone: 'danger',
      title:
        kind === 'send'
          ? t('chat.sendFailed')
          : kind === 'react'
            ? t('chat.reactFailed')
            : t('chat.deleteFailed'),
      description: d.message,
    });
  });
  const { setReads } = chat;

  // Community channels are not auto-pushed: ask for them while the chat is open.
  const isChannel = conv.kind === 'community_channel';
  const { watch, ensure } = rt;
  useEffect(
    () => (isChannel ? watch(conv.id) : ensure(conv.id)),
    [isChannel, watch, ensure, conv.id],
  );

  // Membership and title changes: refetch the conversation (silently keeps the current one on screen).
  useRealtimeEvents((e) => {
    if ((e as { conversationId?: string }).conversationId !== conv.id) return;
    if (
      e.type === 'conversation.updated' ||
      e.type === 'conversation.member.added' ||
      e.type === 'conversation.member.removed' ||
      e.type === 'conversation.member.updated'
    )
      reloadConv();
    if (
      e.type === 'conversation.removed' ||
      (e.type === 'unsubscribed' && (e as { reason?: string }).reason === 'access_revoked')
    )
      reloadConv();
  });

  const peer = conv.kind === 'direct' ? (conv.peer ?? null) : null;
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const m of conv.members ?? [])
      if (m.userId !== user.id && m.lastReadAt) init[m.userId] = m.lastReadAt;
    setReads(init);
  }, [conv.members, user.id, setReads]);

  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of conv.members ?? []) if (m.profile) map.set(m.userId, m.profile.displayName);
    for (const i of chat.items)
      if (i.message.sender && i.message.senderId)
        map.set(i.message.senderId, i.message.sender.displayName);
    return map;
  }, [conv.members, chat.items]);
  const nameOf = useCallback(
    (id: string | null) =>
      id ? (id === user.id ? t('inbox.you') : (people.get(id) ?? null)) : null,
    [people, user.id, t],
  );

  const last = chat.items[chat.items.length - 1];
  const showSeen = Boolean(
    peer &&
    last &&
    last.status === 'sent' &&
    last.message.senderId === user.id &&
    isSeenBy(chat.reads[peer.id], last.message.createdAt),
  );
  const typingNames = chat.typing.map((id) => people.get(id)).filter(Boolean) as string[];
  const typingText =
    chat.typing.length === 0
      ? ''
      : chat.typing.length === 1 && typingNames[0]
        ? t('chat.typingOne', { name: typingNames[0] })
        : t('chat.typingMany');

  const subtitleNode =
    subtitle ??
    (peer ? (
      <Link href={`/u/${peer.username}`} className="chat__sub" dir="ltr">
        @{peer.username}
      </Link>
    ) : conv.kind === 'group' ? (
      <span className="chat__sub">
        {t('chat.groupMembers', { count: conv.memberCount ?? conv.members?.length ?? 0 })}
      </span>
    ) : null);
  const canDetail = conv.kind !== 'community_channel';

  return (
    <section
      className="chat"
      aria-labelledby="chat-h"
      data-testid="chat"
      data-conversation-id={conv.id}
    >
      <header className="chat__head">
        <Link href={backHref} className="chat__back" aria-label={backLabel}>
          <ChevronStartIcon size={22} />
        </Link>
        <Avatar name={title} src={peer?.avatarUrl ?? null} decorative />
        <div className="chat__who">
          <h1 id="chat-h" className="chat__title" tabIndex={-1}>
            {title}
          </h1>
          {subtitleNode}
        </div>
        {canDetail ? (
          <IconButton
            label={t('chat.details')}
            icon={<InfoIcon size={20} />}
            onClick={() => setDetails(true)}
            data-testid="chat-details"
          />
        ) : null}
      </header>

      {rt.status === 'reconnecting' ? (
        <p className="yl-notice yl-notice--warning chat__notice" role="status">
          {t('inbox.reconnecting')}
        </p>
      ) : null}
      {rt.status === 'offline' ? (
        <p className="yl-notice yl-notice--warning chat__notice" role="status">
          {t('inbox.offline')}
        </p>
      ) : null}

      {chat.loading ? (
        <div className="chat__loading" role="status" aria-busy="true">
          <span className="yl-sr-only">{t('common.loading')}</span>
          <Skeleton width="md" />
          <Skeleton width="lg" />
          <Skeleton width="sm" />
        </div>
      ) : chat.error ? (
        <div className="chat__loading">
          <ErrorView error={chat.error} onRetry={chat.reload} />
        </div>
      ) : (
        <MessageList
          items={chat.items}
          viewerId={user.id}
          showSenders={conv.kind !== 'direct'}
          labels={labels.list}
          bubbleLabels={labels.bubble}
          hasMore={chat.hasMore}
          loadingMore={chat.loadingMore}
          onLoadOlder={chat.loadOlder}
          nameOf={nameOf}
          onReact={chat.react}
          onReply={setReplyTo}
          onDelete={setToDelete}
          onRetry={(m) => chat.retry(m.id)}
          onDiscard={(m) => chat.discard(m.id)}
        />
      )}

      <div className="chat__status" role="status" aria-live="polite">
        {typingText ? (
          <span className="chat__typing" data-testid="typing">
            {typingText}
          </span>
        ) : null}
        {showSeen && !typingText ? (
          <span className="chat__seen" data-testid="seen">
            {t('chat.seen')}
          </span>
        ) : null}
      </div>

      <ChatComposer
        labels={labels.composer}
        disabledReason={conv.canSend ? null : t('chat.cannotSend')}
        onSend={(body) => {
          chat.send(body, replyTo);
          setReplyTo(null);
        }}
        onTyping={chat.startTyping}
        replyTo={replyTo ? { name: nameOf(replyTo.senderId) ?? '', body: replyTo.body } : null}
        onCancelReply={() => setReplyTo(null)}
      />

      {canDetail ? (
        <ConversationDetails
          conv={conv}
          open={details}
          onClose={() => setDetails(false)}
          onChanged={reloadConv}
        />
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        busy={deleting}
        danger
        title={t('chat.deleteTitle')}
        description={t('chat.deleteBody')}
        confirmLabel={t('chat.delete')}
        onConfirm={() => {
          if (!toDelete) return;
          setDeleting(true);
          void chat.remove(toDelete).finally(() => {
            setDeleting(false);
            setToDelete(null);
          });
        }}
      />
    </section>
  );
}
