import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Text } from 'react-native';
import type { Conversation } from '../../../packages/shared/src/types';
import { client } from '../lib/api';
import { Loading, Row, Screen, useColors } from '../lib/ui';

/** Inbox: conversations with unread counts; tap to open the chat. */
export default function Inbox() {
  const c = useColors();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [me, setMe] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const api = await client();
        setMe((await api.auth.me()).user.id);
        setItems((await api.conversations.list()).items);
      })().catch(() => setItems([]));
    }, []),
  );

  if (!items) return <Loading />;
  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ gap: 8 }}
        ListEmptyComponent={<Text style={{ color: c.inkMuted }}>No conversations yet. Message someone from their profile.</Text>}
        renderItem={({ item }) => (
          <Row
            title={
              item.title ??
              item.members
                .filter((m) => m.id !== me)
                .map((m) => m.displayName)
                .join(', ')
            }
            subtitle={item.lastMessage?.body ?? 'No messages yet'}
            end={item.unreadCount ? <Text style={{ color: c.yapi, fontWeight: '700' }}>{item.unreadCount}</Text> : null}
            onPress={() => router.push(`/chat/${item.id}`)}
          />
        )}
      />
    </Screen>
  );
}
