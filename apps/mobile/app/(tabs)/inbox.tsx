import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { Conversation, PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { conversationTitle } from '../../lib/post';
import { useRealtime, useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Icon, Loading, Notice, Row, Screen, useColors, useTabBarSpace } from '../../lib/ui';

type FriendRequest = { id: string; from: PublicUser; createdAt: string };

/**
 * Yap: your notifications (with how many are new) and friend requests to answer, then
 * conversations with unread counts; tap to open the chat, or start a group. Updates live.
 */
export default function Inbox() {
  const c = useColors();
  const { t, timeAgo, number } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [unread, setUnread] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void (async () => setItems((await (await client()).conversations.list()).items))().catch(() => setItems([]));
  }, []);
  const loadExtras = useCallback(() => {
    void client().then((api) => {
      api.me.friendRequests().then(
        (r) => setRequests(r.items),
        () => {},
      );
      api.notifications.list().then(
        (r) => setUnread(r.unread),
        () => {},
      );
    });
  }, []);
  useFocusEffect(load);
  useFocusEffect(loadExtras);
  useRealtime((e) => {
    if (e.type === 'message.created' || e.type === 'conversation.created') load();
    if (e.type === 'notification.created') loadExtras();
  });

  async function answer(r: FriendRequest, accept: boolean) {
    setError(null);
    setNote(null);
    try {
      const api = await client();
      await (accept ? api.me.acceptFriend(r.id) : api.me.declineFriend(r.id));
      setRequests((x) => x.filter((y) => y.id !== r.id));
      if (accept) setNote(t('chat.nowFriends', { name: r.from.displayName }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.inbox.signedOut')}</Notice>
      </Screen>
    );
  if (!items) return <Loading />;
  return (
    <Screen style={{ paddingBottom: 0 }}>
      <Button
        label={t('m.inbox.newGroup')}
        icon="people-outline"
        variant="secondary"
        size="sm"
        onPress={() => router.push('/new-group')}
        style={{ alignSelf: 'flex-start' }}
      />
      <FlatList
        data={items}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ gap: space[2], paddingBottom: bottom }}
        ListHeaderComponent={
          <View style={{ gap: space[2], marginBottom: space[2] }}>
            <Row
              title={t('notifications.title')}
              subtitle={unread ? t('m.inbox.unread', { count: unread }) : t('m.inbox.notifHint')}
              start={<Icon name="notifications-outline" size={22} color={c.yapi} />}
              end={
                unread ? (
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
                    <Text style={{ color: c.onYapi, fontWeight: '700', fontSize: 12 }}>{unread > 99 ? '99+' : number(unread)}</Text>
                  </View>
                ) : (
                  <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
                )
              }
              onPress={() => router.push('/notifications')}
            />
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {note ? (
              <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
                {note}
              </Text>
            ) : null}
            {requests.length ? (
              <View style={{ gap: space[2] }}>
                <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800', marginTop: space[2] }}>
                  {t('chat.friendRequests')}
                </Text>
                {requests.map((r) => (
                  <View key={r.id} style={{ backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
                    <Row
                      title={r.from.displayName}
                      subtitle={`@${r.from.username}`}
                      start={<Avatar name={r.from.displayName} url={r.from.avatarUrl} size={40} />}
                      onPress={() => router.push(`/u/${encodeURIComponent(r.from.username)}`)}
                    />
                    <View style={{ flexDirection: 'row', gap: space[2] }}>
                      <Button label={t('m.common.accept')} size="sm" onPress={() => void answer(r, true)} />
                      <Button label={t('m.common.decline')} size="sm" variant="secondary" onPress={() => void answer(r, false)} />
                    </View>
                  </View>
                ))}
                <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800', marginTop: space[2] }}>
                  {t('chat.conversations')}
                </Text>
              </View>
            ) : null}
          </View>
        }
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
