import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { InboxItem } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import { useAuth } from '../../auth/AuthProvider';
import { useRealtime } from '../../realtime/RealtimeProvider';
import { useConversations } from '../../data/inbox';
import { relativeTime } from '../../lib/format';
import { AppText, Avatar, Badge, Banner, EmptyView, PagedList } from '../../ui';

export function conversationTitle(
  c: Pick<InboxItem, 'kind' | 'peer' | 'title' | 'channelName'>,
  fallback: string,
): string {
  return c.kind === 'direct'
    ? (c.peer?.displayName ?? c.peer?.username ?? fallback)
    : (c.title ?? c.channelName ?? fallback);
}

function Row({ item }: { item: InboxItem }) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const { user } = useAuth();
  const title = conversationTitle(item, t('inbox.group'));
  const last = item.lastMessage;
  const preview = last
    ? last.senderId === user?.id
      ? t('inbox.you', { text: last.preview })
      : last.preview
    : t('inbox.noMessagesYet');
  const unread = item.unreadCount > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${preview}${unread ? `. ${t('inbox.unread', { count: item.unreadCount })}` : ''}${item.muted ? `. ${t('inbox.muted')}` : ''}`}
      onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space[3],
        padding: th.space[4],
        minHeight: 72,
        backgroundColor: th.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
      }}
    >
      <Avatar name={title} uri={item.peer?.avatarUrl} size={48} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space[2] }}>
          <AppText variant={unread ? 'bodyStrong' : 'body'} numberOfLines={1} style={{ flex: 1 }}>
            {title}
          </AppText>
          {item.lastMessageAt ? (
            <AppText variant="caption" tone="subtle">
              {relativeTime(item.lastMessageAt, locale)}
            </AppText>
          ) : null}
        </View>
        <AppText variant="caption" tone={unread ? 'default' : 'muted'} numberOfLines={1}>
          {preview}
        </AppText>
      </View>
      <Badge count={item.unreadCount} label={t('inbox.unread', { count: item.unreadCount })} />
    </Pressable>
  );
}

export default function Inbox() {
  const th = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const list = useConversations();
  const { status } = useRealtime();
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.bg }}>
      {status === 'reconnecting' ? <Banner tone="warning" text={t('state.reconnecting')} /> : null}
      <PagedList
        query={list}
        renderItem={({ item }) => <Row item={item} />}
        empty={
          <EmptyView
            message={t('inbox.empty')}
            actionLabel={t('inbox.new')}
            onAction={() => router.push('/new-message')}
          />
        }
      />
    </View>
  );
}
