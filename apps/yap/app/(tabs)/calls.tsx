import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import type { CallInfo } from '../../../../packages/api-client/src/index';
import type { Conversation } from '../../../../packages/shared/src/types';
import { callLineText } from '../../../../packages/shared/src/message-preview';
import { client, errorMessage } from '../../../mobile/lib/api';
import { useCalls } from '../../../mobile/lib/calls';
import { onBackOnline } from '../../../mobile/lib/network';
import { useT } from '../../../mobile/lib/i18n';
import { conversationTitle } from '../../../mobile/lib/post';
import { useRealtime, useSession } from '../../../mobile/lib/session';
import { space } from '../../../mobile/lib/theme';
import { EmptyState, ErrorState, Icon, SkeletonList, useColors } from '../../../mobile/lib/ui';
import { ListRow, RoundButton, RowLine } from '../../lib/rows';

/**
 * Calls: your recent calls in every chat you're in, newest first (GET /v1/calls), each with who it
 * was with, whether you made it or got it, how it went ("Missed video call", "Audio call, 3
 * minutes"), when, and a button to call again the same way. New call in the header picks a chat.
 * Calls ring and connect through the phone app's CallsProvider, like calls started in a chat.
 */
export default function Calls() {
  const c = useColors();
  const { t, tp, timeAgo, locale } = useT();
  const { me } = useSession();
  const { start } = useCalls();
  const navigation = useNavigation();
  const [calls, setCalls] = useState<CallInfo[] | null>(null);
  const [chats, setChats] = useState<Map<string, Conversation>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ marginEnd: space[2] }}>
          <RoundButton icon="add-circle-outline" label={t('yapApp.calls.new')} onPress={() => router.push('/new-call')} />
        </View>
      ),
    });
  }, [navigation, t]);

  const fetchAll = useCallback(async () => {
    try {
      const api = await client();
      const [list, convs] = await Promise.all([api.calls.list(), api.conversations.list()]);
      setChats(new Map(convs.items.map((x) => [x.id, x])));
      setCalls(list.items);
      setError(null);
    } catch (e) {
      setCalls((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);
  const load = useCallback(() => {
    void fetchAll();
  }, [fetchAll]);
  useFocusEffect(load);
  useEffect(() => onBackOnline(load), [load]);
  useRealtime((e) => {
    if (e.type === 'call.ended' || e.type === 'call.incoming') load();
  });

  // Only calls whose chat is in your list (a chat that was just removed drops out on the next load).
  const shown = useMemo(() => (calls ?? []).filter((x) => chats.has(x.conversationId)), [calls, chats]);
  const meId = me?.id;

  if (!calls) return <SkeletonList />;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.ground }}
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
            await fetchAll();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={error ? <ErrorState message={error} onRetry={fetchAll} style={{ margin: space[4] }} /> : null}
      ListEmptyComponent={
        error ? null : (
          <EmptyState
            icon="call-outline"
            title={t('yapApp.calls.empty')}
            body={t('yapApp.calls.emptyBody')}
            action={{ label: t('yapApp.calls.new'), icon: 'add', onPress: () => router.push('/new-call') }}
          />
        )
      }
      renderItem={({ item }) => {
        const chat = chats.get(item.conversationId)!;
        const title = conversationTitle(chat, meId, t);
        const other = chat.members.find((m) => m.id !== meId);
        const outgoing = item.callerId === meId;
        const live = item.status === 'ringing' || item.status === 'active';
        const seconds = item.answeredAt && item.endedAt ? Math.max(0, Math.round((Date.parse(item.endedAt) - Date.parse(item.answeredAt)) / 1000)) : null;
        const line = live
          ? t('yapApp.calls.ongoing')
          : callLineText({ kind: item.kind, outcome: item.status as 'missed' | 'declined' | 'ended', seconds }, item.callerId, { t, tp, locale, meId });
        const missed = !outgoing && item.status === 'missed';
        const when = item.createdAt ? timeAgo(item.createdAt) : '';
        const direction = outgoing ? t('yapApp.calls.outgoing') : t('yapApp.calls.incoming');
        return (
          <ListRow
            name={title}
            avatarUrl={chat.kind === 'direct' ? (other?.avatarUrl ?? null) : null}
            title={title}
            subtitle={when ? `${line} · ${when}` : line}
            subtitleStart={<Icon name={outgoing ? 'arrow-up-outline' : 'arrow-down-outline'} size={14} color={missed ? c.danger : c.inkMuted} />}
            label={[title, direction, line, when].filter(Boolean).join(', ')}
            onPress={() => router.push(`/chat/${item.conversationId}`)}
            end={
              <RoundButton
                icon={item.kind === 'video' ? 'videocam-outline' : 'call-outline'}
                label={item.kind === 'video' ? t('m.calls.startVideo') : t('m.calls.startAudio')}
                onPress={() => void start(item.conversationId, item.kind)}
              />
            }
          />
        );
      }}
    />
  );
}
