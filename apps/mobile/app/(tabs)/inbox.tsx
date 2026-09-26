import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { Conversation } from '../../../../packages/shared/src/types';
import { client } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { conversationTitle } from '../../lib/post';
import { useRealtime, useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, EmptyState, Loading, Notice, Row, Screen, useColors, useTabBarSpace } from '../../lib/ui';

/** Inbox: conversations with unread counts; tap to open the chat. Updates live. */
export default function Inbox() {
  const c = useColors();
  const { t, timeAgo } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const [items, setItems] = useState<Conversation[] | null>(null);

  const load = useCallback(() => {
    void (async () => setItems((await (await client()).conversations.list()).items))().catch(() => setItems([]));
  }, []);
  useFocusEffect(load);
  useRealtime((e) => {
    if (e.type === 'message.created' || e.type === 'conversation.created') load();
  });

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.inbox.signedOut')}</Notice>
      </Screen>
    );
  if (!items) return <Loading />;
  return (
    <Screen style={{ paddingBottom: 0 }}>
      <FlatList
        data={items}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ gap: space[2], paddingBottom: bottom }}
        ListEmptyComponent={<EmptyState title={t('m.inbox.empty.title')} body={t('m.inbox.empty.body')} />}
        renderItem={({ item }) => {
          const title = conversationTitle(item, me?.id, t);
          const other = item.members.find((m) => m.id !== me?.id);
          return (
            <Row
              title={title}
              subtitle={
                item.lastMessage ? `${item.lastMessage.body || t('m.message.attachment')} · ${timeAgo(item.lastMessage.createdAt)}` : t('m.inbox.noMessages')
              }
              start={<Avatar name={title} url={item.kind === 'direct' ? (other?.avatarUrl ?? null) : null} size={44} />}
              end={
                item.unreadCount ? (
                  <View
                    style={{
                      minWidth: 22,
                      height: 22,
                      borderRadius: radius.full,
                      backgroundColor: c.yapi,
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingHorizontal: 6,
                    }}
                  >
                    <Text style={{ color: c.onYapi, fontWeight: '700', fontSize: 12 }} accessibilityLabel={t('m.inbox.unread', { count: item.unreadCount })}>
                      {item.unreadCount}
                    </Text>
                  </View>
                ) : null
              }
              onPress={() => router.push(`/chat/${item.id}`)}
            />
          );
        }}
      />
    </Screen>
  );
}
