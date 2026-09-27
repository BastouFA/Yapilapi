import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import type { TipRecord } from '../../../packages/api-client/src/index';
import { formatMoney } from '../../../packages/shared/src/i18n';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { Avatar, Card, EmptyState, ErrorState, Icon, Loading, Segmented, useColors, userText } from '../lib/ui';

type Tab = 'received' | 'sent';

/**
 * Tips and gifts (`gifts?tab=sent`): paid tips you got or sent, newest first. A gift is a tip
 * sent during a live; a tip on a post opens that post. Sending one happens on the web.
 */
export default function GiftsScreen() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const c = useColors();
  const { t, locale, timeAgo } = useT();
  const [tab, setTab] = useState<Tab>(params.tab === 'sent' ? 'sent' : 'received');
  const [items, setItems] = useState<Record<Tab, TipRecord[] | null>>({ received: null, sent: null });
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (which: Tab) => {
    try {
      const r = await (await client()).creator.tips(which);
      setItems((cur) => ({ ...cur, [which]: r.items }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setItems((cur) => ({ ...cur, [which]: cur[which] ?? [] }));
    }
  }, []);
  useEffect(() => {
    if (items[tab] === null) void load(tab);
  }, [tab, items, load]);

  const list = items[tab];

  return (
    <FlatList
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
      data={list ?? []}
      keyExtractor={(x) => x.id}
      ListHeaderComponent={
        <View style={{ gap: space[3] }}>
          <Segmented
            label={t('m.gifts.title')}
            value={tab}
            onChange={setTab}
            options={[
              { id: 'received', label: t('m.gifts.received') },
              { id: 'sent', label: t('m.gifts.sent') },
            ]}
          />
          {error ? <ErrorState message={error} onRetry={() => load(tab)} /> : null}
        </View>
      }
      ListEmptyComponent={list === null ? <Loading /> : <EmptyState title={tab === 'received' ? t('m.gifts.emptyReceived') : t('m.gifts.emptySent')} />}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load(tab);
            setRefreshing(false);
          }}
        />
      }
      renderItem={({ item }) => {
        const amount = formatMoney(item.amountCents, item.currency, locale);
        const who = tab === 'received' ? t('m.gifts.from', { name: item.person.displayName }) : t('m.gifts.to', { name: item.person.displayName });
        const what = item.gift ? t('m.gifts.gift') : item.postId ? t('m.gifts.onPost') : t('m.gifts.tip');
        return (
          <Card style={{ gap: space[2] }}>
            <View
              accessible
              accessibilityLabel={[amount, who, what, item.message, timeAgo(item.createdAt)].filter(Boolean).join(', ')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
            >
              <Avatar name={item.person.displayName} url={item.person.avatarUrl} size={40} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                  {who}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name={item.gift ? 'gift-outline' : 'cash-outline'} size={14} color={c.inkMuted} />
                  <Text style={{ color: c.inkMuted, fontSize: 13 }}>
                    {what} · {timeAgo(item.createdAt)}
                  </Text>
                </View>
              </View>
              <Text style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>{amount}</Text>
            </View>
            {item.message ? <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{item.message}</Text> : null}
            <View style={{ flexDirection: 'row', gap: space[4] }}>
              <Pressable
                accessibilityRole="link"
                hitSlop={8}
                onPress={() => router.push(`/u/${item.person.username}`)}
                style={{ minHeight: 32, justifyContent: 'center' }}
              >
                <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 14 }}>{t('m.title.profile')}</Text>
              </Pressable>
              {item.postId ? (
                <Pressable
                  accessibilityRole="link"
                  hitSlop={8}
                  onPress={() => router.push(`/p/${item.postId}`)}
                  style={{ minHeight: 32, justifyContent: 'center' }}
                >
                  <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 14 }}>{t('m.gifts.openPost')}</Text>
                </Pressable>
              ) : null}
            </View>
          </Card>
        );
      }}
    />
  );
}
