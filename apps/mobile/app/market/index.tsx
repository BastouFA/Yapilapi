import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AccessibilityInfo, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { LatLng } from '../../../../packages/shared/src/location';
import {
  MARKET_CATEGORIES,
  MARKET_CONDITIONS,
  MARKET_DEFAULT_RADIUS_KM,
  MARKET_RADII_KM,
  type MarketCategory,
  type MarketCondition,
  type MarketListing,
  type MarketRadius,
} from '../../../../packages/shared/src/market';
import { client, errorMessage } from '../../lib/api';
import { Chip, ChipRow } from '../../lib/chips';
import { useT } from '../../lib/i18n';
import {
  CATEGORY_KEYS,
  CONDITION_KEYS,
  currentNear,
  ListingGrid,
  marketGeolocation,
  parseAmount,
  placeProblem,
  readApproximatePlace,
  SellBlockNote,
  useMarketMe,
} from '../../lib/market';
import { radius, space } from '../../lib/theme';
import {
  BottomSheet,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Notice,
  Segmented,
  SkeletonList,
  SwitchRow,
  useColors,
  useRefresh,
  userText,
} from '../../lib/ui';

type Order = 'newest' | 'nearby';
type Filters = { conditions: MarketCondition[]; min: string; max: string; freeOnly: boolean };
const NO_FILTERS: Filters = { conditions: [], min: '', max: '', freeOnly: false };

/**
 * Market: browse and search things for sale. Without a place, the newest in your country; with
 * "Nearby" (only where this build can read a position), nearest first within a distance. Filters
 * for category, condition, price (whole units of your currency) and Free things. Selling starts
 * here for adults; under-18s can look around.
 */
export default function MarketScreen() {
  const c = useColors();
  const { t } = useT();
  const { me } = useMarketMe();
  const canNearby = !!marketGeolocation();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<MarketCategory | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [order, setOrder] = useState<Order>(() => (currentNear() ? 'nearby' : 'newest'));
  const [near, setNear] = useState<LatLng | null>(() => currentNear());
  const [radiusKm, setRadiusKm] = useState<MarketRadius>(MARKET_DEFAULT_RADIUS_KM);
  const [locating, setLocating] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [items, setItems] = useState<MarketListing[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<TextInput>(null);

  const term = q.trim();
  const useNear = order === 'nearby' && near ? near : null;
  const query = useCallback(
    (next?: string) => ({
      q: term || undefined,
      category: category ?? undefined,
      conditions: filters.conditions.length ? filters.conditions : undefined,
      freeOnly: filters.freeOnly || undefined,
      minPriceCents: filters.freeOnly ? undefined : (parseAmount(filters.min) ?? undefined),
      maxPriceCents: filters.freeOnly ? undefined : (parseAmount(filters.max) ?? undefined),
      near: useNear ?? undefined,
      radiusKm: useNear ? radiusKm : undefined,
      cursor: next,
    }),
    [term, category, filters, useNear, radiusKm],
  );

  // A moment after typing stops (straight away for the other filters); a newer search replaces an older one on its way.
  useEffect(() => {
    let current = true;
    setError(null);
    const timer = setTimeout(
      () => {
        void client()
          .then((api) => api.market.search(query()))
          .then(
            (r) => {
              if (!current) return;
              setItems(r.items);
              setCursor(r.nextCursor);
            },
            (e) => {
              if (!current) return;
              setItems((cur) => cur ?? []);
              setError(errorMessage(e));
            },
          );
      },
      term ? 300 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, term, attempt]);
  const refresh = useRefresh(() => setAttempt((a) => a + 1));

  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await (await client()).market.search(query(cursor));
      setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function locate() {
    setLocating(true);
    setPlaceError(null);
    try {
      setNear(await readApproximatePlace());
      AccessibilityInfo.announceForAccessibility(t('m.market.nearby.on'));
    } catch (e) {
      setPlaceError(placeProblem(t, e));
    } finally {
      setLocating(false);
    }
  }

  const activeFilters = filters.conditions.length + (filters.freeOnly ? 1 : 0) + (filters.min || filters.max ? 1 : 0);
  const currency = me?.currency;

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <Stack.Screen options={{ title: t('m.market.title') }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
        refreshControl={refresh}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            minHeight: 48,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: c.line,
            backgroundColor: c.surface,
            paddingStart: space[4],
            paddingEnd: space[1],
          }}
        >
          <Icon name="search" size={18} color={c.inkMuted} />
          <TextInput
            ref={input}
            accessibilityLabel={t('m.market.searchLabel')}
            accessibilityRole="search"
            placeholder={t('m.market.search')}
            placeholderTextColor={c.inkMuted}
            value={q}
            onChangeText={setQ}
            returnKeyType="search"
            maxLength={100}
            style={[{ flex: 1, color: c.ink, fontSize: 16, paddingVertical: space[2] }, userText]}
          />
          {q ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.wander.clear')}
              onPress={() => {
                setQ('');
                input.current?.focus();
              }}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="close-circle" size={20} color={c.inkMuted} />
            </Pressable>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {me?.canSell ? <Button label={t('m.market.sell')} icon="add" size="sm" onPress={() => router.push('/market-edit')} /> : null}
          {me?.canSell ? (
            <Button label={t('m.market.yours')} icon="pricetags-outline" size="sm" variant="secondary" onPress={() => router.push('/market/mine')} />
          ) : null}
          <Button label={t('m.market.saved')} icon="bookmark-outline" size="sm" variant="secondary" onPress={() => router.push('/market/saved')} />
        </View>
        {me && !me.canSell ? <SellBlockNote block={me.sellBlock} /> : null}

        {canNearby ? (
          <View style={{ gap: space[2] }}>
            <Segmented
              label={t('m.market.sort.label')}
              value={order}
              onChange={setOrder}
              options={[
                { id: 'newest', label: t('m.market.sort.newest') },
                { id: 'nearby', label: t('m.market.sort.nearby') },
              ]}
            />
            {order === 'nearby' && !near ? (
              <View style={{ gap: space[2] }}>
                <Button label={t('m.market.nearby.use')} icon="navigate-outline" variant="secondary" disabled={locating} onPress={locate} />
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.market.nearby.hint')}</Text>
              </View>
            ) : null}
            {order === 'nearby' && near ? (
              <ChipRow scroll radios label={t('m.market.filter.radius')}>
                {MARKET_RADII_KM.map((km) => (
                  <Chip key={km} radio label={t('m.market.filter.radiusKm', { km })} selected={radiusKm === km} onPress={() => setRadiusKm(km)} />
                ))}
              </ChipRow>
            ) : null}
            {placeError ? (
              <Text accessibilityLiveRegion="polite" style={{ color: c.danger, lineHeight: 20 }}>
                {placeError}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.market.nearby.needsUpdate')}</Text>
        )}

        <ChipRow scroll tabs label={t('m.market.filter.category')}>
          <Chip label={t('m.market.filter.allCategories')} selected={category === null} onPress={() => setCategory(null)} />
          {MARKET_CATEGORIES.map((k) => (
            <Chip key={k} label={t(CATEGORY_KEYS[k])} selected={category === k} onPress={() => setCategory(k)} />
          ))}
        </ChipRow>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Chip
            label={activeFilters ? t('m.market.filters.count', { count: activeFilters }) : t('m.market.filters')}
            icon="options-outline"
            onPress={() => {
              setDraft(filters);
              setFiltersOpen(true);
            }}
          />
          {activeFilters ? <Chip label={t('m.market.filter.clear')} icon="close" onPress={() => setFilters(NO_FILTERS)} /> : null}
          <Text style={{ flex: 1, color: c.inkMuted, fontSize: 13 }} numberOfLines={2}>
            {useNear ? t('m.market.nearestNote') : t('m.market.newestNote')}
          </Text>
        </View>

        {error ? <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} /> : null}
        {items === null ? (
          <SkeletonList count={4} />
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
          <EmptyState icon="storefront-outline" title={t('m.market.empty.title')} body={t('m.market.empty.body')} />
        )}
      </ScrollView>

      <BottomSheet visible={filtersOpen} title={t('m.market.filters')} onClose={() => setFiltersOpen(false)}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.market.filter.condition')}</Text>
        <ChipRow label={t('m.market.filter.condition')}>
          {MARKET_CONDITIONS.map((k) => {
            const on = draft.conditions.includes(k);
            return (
              <Chip
                key={k}
                label={t(CONDITION_KEYS[k])}
                selected={on}
                icon={on ? 'checkmark' : undefined}
                onPress={() => setDraft((d) => ({ ...d, conditions: on ? d.conditions.filter((x) => x !== k) : [...d.conditions, k] }))}
              />
            );
          })}
        </ChipRow>
        <SwitchRow label={t('m.market.filter.freeOnly')} value={draft.freeOnly} onValueChange={(v) => setDraft((d) => ({ ...d, freeOnly: v }))} />
        {!draft.freeOnly ? (
          <View style={{ flexDirection: 'row', gap: space[3] }}>
            <View style={{ flex: 1 }}>
              <Field
                label={currency ? t('m.market.filter.min', { currency }) : t('m.market.filter.minPlain')}
                value={draft.min}
                onChangeText={(v) => setDraft((d) => ({ ...d, min: v.replace(/[^\d]/g, '') }))}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={10}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label={currency ? t('m.market.filter.max', { currency }) : t('m.market.filter.maxPlain')}
                value={draft.max}
                onChangeText={(v) => setDraft((d) => ({ ...d, max: v.replace(/[^\d]/g, '') }))}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={10}
              />
            </View>
          </View>
        ) : null}
        {!draft.freeOnly && draft.min && draft.max && Number(draft.min) > Number(draft.max) ? (
          <Notice tone="warn">{t('m.market.filter.minOverMax')}</Notice>
        ) : null}
        <Button
          label={t('m.market.filter.apply')}
          onPress={() => {
            setFilters(draft);
            setFiltersOpen(false);
          }}
        />
        <Button label={t('m.market.filter.clear')} variant="ghost" onPress={() => setDraft(NO_FILTERS)} />
      </BottomSheet>
    </View>
  );
}
