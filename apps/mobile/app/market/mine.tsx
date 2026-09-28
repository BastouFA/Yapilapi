import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import type { MarketListing } from '../../../../packages/shared/src/market';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { ListingGrid, SellBlockNote, useMarketMe } from '../../lib/market';
import { space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, Segmented, SkeletonList, useColors } from '../../lib/ui';

type Tab = 'active' | 'sold' | 'expired';

/** Your listings: for sale (available or reserved), sold, and ended (to renew). Selling something new starts here too. */
export default function MyListings() {
  const c = useColors();
  const { t } = useT();
  const { me } = useMarketMe();
  const [tab, setTab] = useState<Tab>('active');
  const [items, setItems] = useState<MarketListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).market.mine(tab)).items);
      setError(null);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [tab]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const empty = tab === 'active' ? t('m.market.mine.empty.active') : tab === 'sold' ? t('m.market.mine.empty.sold') : t('m.market.mine.empty.ended');
  return (
    <ScrollView
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
      <Stack.Screen options={{ title: t('m.market.yours') }} />
      {me?.canSell ? (
        <Button label={t('m.market.sell')} icon="add" onPress={() => router.push('/market-edit')} />
      ) : me ? (
        <SellBlockNote block={me.sellBlock} />
      ) : null}
      <Segmented
        label={t('m.market.yours')}
        value={tab}
        onChange={(v) => {
          setItems(null);
          setTab(v);
        }}
        options={[
          { id: 'active', label: t('m.market.mine.active') },
          { id: 'sold', label: t('m.market.mine.sold') },
          { id: 'expired', label: t('m.market.mine.ended') },
        ]}
      />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {items === null ? <SkeletonList count={3} /> : items.length ? <ListingGrid items={items} /> : <EmptyState icon="pricetags-outline" title={empty} />}
    </ScrollView>
  );
}
