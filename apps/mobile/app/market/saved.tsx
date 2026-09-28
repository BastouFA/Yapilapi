import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView } from 'react-native';
import type { MarketListing } from '../../../../packages/shared/src/market';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { ListingGrid } from '../../lib/market';
import { space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, SkeletonList, useColors } from '../../lib/ui';

/** Listings you saved, newest first, to find them again. */
export default function SavedListings() {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<MarketListing[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await (await client()).market.saved();
      setItems(r.items);
      setCursor(r.nextCursor);
      setError(null);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await (await client()).market.saved(cursor);
      setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

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
      <Stack.Screen options={{ title: t('m.market.saved') }} />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {items === null ? (
        <SkeletonList count={3} />
      ) : items.length ? (
        <>
          <ListingGrid items={items} />
          {cursor ? (
            loadingMore ? (
              <ActivityIndicator color={c.yapi} accessibilityLabel={t('m.common.loadingMore')} />
            ) : (
              <Button label={t('m.market.loadMore')} variant="secondary" onPress={more} />
            )
          ) : null}
        </>
      ) : (
        <EmptyState
          icon="bookmark-outline"
          title={t('m.market.savedEmpty.title')}
          body={t('m.market.savedEmpty.body')}
          action={{ label: t('m.market.browse'), icon: 'storefront-outline', onPress: () => router.push('/market') }}
        />
      )}
    </ScrollView>
  );
}
