import { router, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import type { Conversation, PublicUser } from '../../../../packages/shared/src/types';
import { messagePreviewOf, messagePreviewText } from '../../../../packages/shared/src/message-preview';
import { client, errorMessage } from '../../lib/api';
import { YapEmpty } from '../../lib/empty';
import { onBackOnline } from '../../lib/network';
import { useT } from '../../lib/i18n';
import { conversationTitle } from '../../lib/post';
import { useRealtime, useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, ErrorState, Icon, Notice, Row, Screen, SkeletonList, useColors, useTabBarSpace } from '../../lib/ui';

type FriendRequest = { id: string; from: PublicUser; createdAt: string };

/**
 * Yap: your notifications (with how many are new) and friend requests to answer, then
 * conversations with unread counts; tap to open the chat, or start a group. Updates live.
 */
export default function Inbox() {
  const c = useColors();
  const { t, number } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [unread, setUnread] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      setItems((await (await client()).conversations.list()).items);
    } catch {
      setItems((cur) => cur ?? []);
    }
  }, []);
  const load = useCallback(() => {
    void fetchList();
  }, [fetchList]);
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
  useEffect(() => onBackOnline(() => (load(), loadExtras())), [load, loadExtras]);
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

  const meId = me?.id;
  const renderConversation = useCallback(({ item }: { item: Conversation }) => <ConversationRow item={item} meId={meId} />, [meId]);

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.inbox.signedOut')}</Notice>
      </Screen>
    );
  if (!items)
    return (
      <Screen>
        <SkeletonList />
      </Screen>
    );
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
        keyboardShouldPersistTaps="handled"
        data={items}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ gap: space[2], paddingBottom: bottom }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.yapi}
            colors={[c.yapi]}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([fetchList(), Promise.resolve(loadExtras())]);
              setRefreshing(false);
            }}
          />
        }
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
            {error ? <ErrorState message={error} onRetry={fetchList} /> : null}
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
                      <Button label={t('m.common.accept')} size="sm" onPress={() => answer(r, true)} />
                      <Button label={t('m.common.decline')} size="sm" variant="secondary" onPress={() => answer(r, false)} />
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
        ListEmptyComponent={<YapEmpty />}
        renderItem={renderConversation}
      />
    </Screen>
  );
}

/** A conversation in the list. Memoised: pulling to refresh or a new friend request leaves the rows alone. */
const ConversationRow = memo(function ConversationRow({ item, meId }: { item: Conversation; meId: string | undefined }) {
  const c = useColors();
  const { t, timeAgo, locale } = useT();
  const title = conversationTitle(item, meId, t);
  // Said from what it is (a location, a game, an offer, a story reply), in your language.
  const last = item.lastMessage ? messagePreviewText(item.lastMessage.preview ?? messagePreviewOf(item.lastMessage), { t, locale, meId }) : null;
  const other = item.members.find((m) => m.id !== meId);
  return (
    <Row
      title={title}
      subtitle={item.lastMessage ? `${last} · ${timeAgo(item.lastMessage.createdAt)}` : t('m.inbox.noMessages')}
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
});
