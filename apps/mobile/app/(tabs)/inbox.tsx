import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { Conversation } from '../../../../packages/shared/src/types';
import { client } from '../../lib/api';
import { conversationTitle, timeAgo } from '../../lib/post';
import { useRealtime, useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, EmptyState, Loading, Notice, Row, Screen, useColors, useTabBarSpace } from '../../lib/ui';

/** Inbox: conversations with unread counts; tap to open the chat. Updates live. */
export default function Inbox() {
  const c = useColors();
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
        <Notice>Log in from the Home tab to see your messages.</Notice>
      </Screen>
    );
  if (!items) return <Loading />;
  return (
    <Screen style={{ paddingBottom: 0 }}>
      <FlatList
        data={items}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ gap: space[2], paddingBottom: bottom }}
        ListEmptyComponent={<EmptyState title="No conversations yet" body="Message someone from their profile on the web app." />}
        renderItem={({ item }) => {
          const title = conversationTitle(item, me?.id);
          const other = item.members.find((m) => m.id !== me?.id);
          return (
            <Row
              title={title}
              subtitle={item.lastMessage ? `${item.lastMessage.body || 'Attachment'} · ${timeAgo(item.lastMessage.createdAt)}` : 'No messages yet'}
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
                    <Text style={{ color: c.onYapi, fontWeight: '700', fontSize: 12 }} accessibilityLabel={`${item.unreadCount} unread`}>
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
