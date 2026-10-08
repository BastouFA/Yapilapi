import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { dropPhase, type Drop, type DropActivity } from '../../../packages/shared/src/drops';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import { client, errorMessage } from '../lib/api';
import { DropCard, useNow } from '../lib/drops';
import { useFlag } from '../lib/flags';
import { useT } from '../lib/i18n';
import { openOnWeb } from '../lib/money';
import { space } from '../lib/theme';
import { Button, EmptyState, ErrorState, Loading, Segmented, useColors, userText } from '../lib/ui';

type Tab = 'waiting' | 'bought' | 'mine';

const PURCHASE: Record<DropActivity['purchases'][number]['status'], MessageKey> = {
  held: 'm.drops.purchase.held',
  paid: 'm.drops.purchase.paid',
  released: 'm.drops.purchase.released',
};

/**
 * "Your drops": drops you asked to hear about, what you bought in drops, and your own launches
 * (with their numbers). Making a drop happens on the web.
 */
export default function DropsScreen() {
  const c = useColors();
  const { t } = useT();
  const now = useNow();
  const commerce = useFlag('COMMERCE');
  const [tab, setTab] = useState<Tab>('waiting');
  const [activity, setActivity] = useState<DropActivity[] | null>(null);
  const [mine, setMine] = useState<Drop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = await client();
      const [a, m] = await Promise.all([api.drops.activity(), api.drops.mine()]);
      setActivity(a.items);
      setMine(m.items);
      setError(null);
    } catch (e) {
      setActivity((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (activity === null) return <Loading />;
  const waiting = activity.filter((a) => a.drop.reminded && ['upcoming', 'opening', 'open'].includes(dropPhase(a.drop, now)));
  const bought = activity.filter((a) => a.purchases.length);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
      refreshControl={
        <RefreshControl
          tintColor={c.yapi}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen options={{ title: t('m.drops.yours') }} />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      <Segmented
        label={t('m.drops.title')}
        value={tab}
        onChange={setTab}
        options={[
          { id: 'waiting', label: t('m.drops.section.waiting') },
          { id: 'bought', label: t('m.drops.section.bought') },
          { id: 'mine', label: t('m.drops.section.mine') },
        ]}
      />
      {tab === 'waiting' ? (
        waiting.length ? (
          waiting.map((a) => <DropCard key={a.drop.id} drop={a.drop} now={now} />)
        ) : (
          <EmptyState title={t('m.drops.empty.waitingTitle')} body={t('m.drops.empty.waiting')} />
        )
      ) : tab === 'bought' ? (
        bought.length ? (
          bought.map((a) => (
            <View key={a.drop.id} style={{ gap: space[2] }}>
              <DropCard drop={a.drop} now={now} />
              {a.purchases.map((p) => (
                <Text key={`${p.orderId}:${p.productId}`} style={[{ color: c.ink, paddingHorizontal: space[2] }, userText]}>
                  {p.title} × {p.quantity} · <Text style={{ color: c.inkMuted }}>{t(PURCHASE[p.status])}</Text>
                </Text>
              ))}
            </View>
          ))
        ) : (
          <EmptyState title={t('m.drops.empty.boughtTitle')} body={t('m.drops.empty.bought')} />
        )
      ) : (
        <View style={{ gap: space[3] }}>
          {commerce !== false ? <Button label={t('m.drops.newOnWeb')} icon="open-outline" variant="secondary" onPress={() => openOnWeb('/drops/new')} /> : null}
          {mine.length ? (
            mine.map((d) => (
              <View key={d.id} style={{ gap: space[1] }}>
                <DropCard drop={d} now={now} showSeller={false} />
                {d.stats && d.status !== 'draft' ? (
                  <Text style={{ color: c.inkMuted, paddingHorizontal: space[2] }}>
                    {t('m.drops.mineSummary', { waiting: d.stats.waiting, sold: d.stats.unitsSold })}
                  </Text>
                ) : null}
              </View>
            ))
          ) : (
            <EmptyState title={t('m.drops.empty.mineTitle')} body={t('m.drops.empty.mine')} />
          )}
        </View>
      )}
    </ScrollView>
  );
}
