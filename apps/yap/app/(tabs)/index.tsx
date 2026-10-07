import { router, useFocusEffect, useNavigation } from 'expo-router';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import type { Conversation } from '../../../../packages/shared/src/types';
import { lastMessageText } from '../../../../packages/shared/src/message-preview';
import { client, errorMessage } from '../../../mobile/lib/api';
import { YapEmpty } from '../../../mobile/lib/empty';
import { onBackOnline } from '../../../mobile/lib/network';
import { useT } from '../../../mobile/lib/i18n';
import { conversationTitle } from '../../../mobile/lib/post';
import { useRealtime, useSession } from '../../../mobile/lib/session';
import { space } from '../../../mobile/lib/theme';
import { ErrorState, Field, SkeletonList, useColors } from '../../../mobile/lib/ui';
import { ListRow, RoundButton, RowLine, UnreadBadge } from '../../lib/rows';

/** Accents and case don't matter when searching ("lea" finds Léa). */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Chats: every conversation, newest first, with its last message and unread count; search by name
 * or by the last message; New chat in the header. Updates live over the realtime socket.
 */
export default function Chats() {
  const c = useColors();
  const { t, tp, locale } = useT();
  const { me } = useSession();
  const navigation = useNavigation();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState('');

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ marginEnd: space[2] }}>
          <RoundButton icon="create-outline" label={t('yapApp.chats.new')} onPress={() => router.push('/new-chat')} />
        </View>
      ),
    });
  }, [navigation, t]);

  const fetchList = useCallback(async () => {
    try {
      setItems((await (await client()).conversations.list()).items);
      setError(null);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);
  const load = useCallback(() => {
    void fetchList();
  }, [fetchList]);
  useFocusEffect(load);
  useEffect(() => onBackOnline(load), [load]);
  useRealtime((e) => {
    // A new message, or a chat you were added to, left or taken out of, or that was renamed.
    if (['message.created', 'conversation.created', 'conversation.changed', 'conversation.removed'].includes(e.type)) load();
  });

  const meId = me?.id;
  const shown = useMemo(() => {
    const needle = fold(q.trim());
    if (!items || !needle) return items;
    return items.filter((x) => {
      const last = x.lastMessage ? lastMessageText(x.lastMessage, { t, tp, locale, meId }) : '';
      return fold(conversationTitle(x, meId, t)).includes(needle) || fold(last).includes(needle) || x.members.some((m) => fold(m.username).includes(needle));
    });
  }, [items, q, t, tp, locale, meId]);

  const renderItem = useCallback(({ item }: { item: Conversation }) => <ChatRow item={item} meId={meId} />, [meId]);

  if (!items) return <SkeletonList />;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.ground }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      data={shown}
      keyExtractor={(x) => x.id}
      ItemSeparatorComponent={RowLine}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={c.yapi}
          colors={[c.yapi]}
          onRefresh={async () => {
            setRefreshing(true);
            await fetchList();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={
        <View style={{ paddingHorizontal: space[4], paddingBottom: space[2], gap: space[2] }}>
          {items.length ? (
            <Field
              label={t('yapApp.chats.search')}
              hideLabel
              placeholder={t('yapApp.chats.search')}
              value={q}
              onChangeText={setQ}
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
          ) : null}
          {error ? <ErrorState message={error} onRetry={fetchList} /> : null}
        </View>
      }
      ListEmptyComponent={
        q.trim() ? (
          <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[6] }}>{t('yapApp.chats.noMatch', { query: q.trim() })}</Text>
        ) : (
          <View style={{ padding: space[4] }}>
            <YapEmpty />
          </View>
        )
      }
      renderItem={renderItem}
    />
  );
}

/** A chat in the list. Memoised: typing in search or pulling to refresh leaves the other rows alone. */
const ChatRow = memo(function ChatRow({ item, meId }: { item: Conversation; meId: string | undefined }) {
  const c = useColors();
  const { t, tp, timeAgo, locale, number } = useT();
  const title = conversationTitle(item, meId, t);
  // Said from what it is (a location, a game, an offer, a call), in your language.
  const last = item.lastMessage ? lastMessageText(item.lastMessage, { t, tp, locale, meId }) : null;
  const other = item.members.find((m) => m.id !== meId);
  const subtitle = item.lastMessage
    ? item.lastMessage.sender.id === meId && item.lastMessage.kind !== 'system'
      ? t('chat.lastFromYou', { text: last ?? '' })
      : (last ?? '')
    : t('m.inbox.noMessages');
  const unread = item.unreadCount ? t('m.inbox.unread', { count: item.unreadCount }) : null;
  const when = item.lastMessage ? timeAgo(item.lastMessage.createdAt) : null;
  return (
    <ListRow
      name={title}
      avatarUrl={item.kind === 'direct' ? (other?.avatarUrl ?? null) : null}
      title={title}
      subtitle={subtitle}
      emphasis={!!item.unreadCount}
      label={[title, subtitle, when, unread].filter(Boolean).join(', ')}
      // The time above the unread count, so a long preview never cuts it off.
      end={
        <View style={{ alignItems: 'flex-end', gap: 4, alignSelf: 'stretch', justifyContent: 'center' }}>
          {when ? (
            <Text style={{ color: item.unreadCount ? c.yapi : c.inkMuted, fontSize: 12, fontWeight: item.unreadCount ? '700' : '400' }}>{when}</Text>
          ) : null}
          {item.unreadCount ? <UnreadBadge text={item.unreadCount > 99 ? '99+' : number(item.unreadCount)} label={unread!} /> : null}
        </View>
      }
      onPress={() => router.push(`/chat/${item.id}`)}
    />
  );
});
