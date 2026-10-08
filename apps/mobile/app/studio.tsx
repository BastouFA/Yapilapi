import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { AdCampaign, Boost, CreatorAnalytics, CreatorTopPost, Payout, SalesReport, ServiceBooking } from '../../../packages/api-client/src/index';
import { EARNINGS_HOLD_DAYS } from '../../../packages/shared/src/constants';
import { formatMoney } from '../../../packages/shared/src/i18n-core';
import { client, errorMessage } from '../lib/api';
import { SectionHeader } from '../lib/chips';
import { BoostResult, DayBars, hasStudio, StatGrid } from '../lib/creator';
import { useFlag } from '../lib/flags';
import { Pill } from '../lib/forms';
import { useT } from '../lib/i18n';
import { openOnWeb } from '../lib/money';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, Card, ErrorState, Icon, Loading, Notice, Row, useColors, userText } from '../lib/ui';

type Earnings = { currency: string; grossCents: number; feeCents: number; heldCents: number; availableCents: number }[];

/** What each section got; a section that failed to load (or is turned off) stays out of the way. */
type StudioData = {
  analytics: CreatorAnalytics | null;
  earnings: Earnings;
  payouts: Payout[];
  sales: SalesReport | null;
  bookings: ServiceBooking[];
  subscribers: { active: number; cancelled: number } | null;
  plans: { id: string; name: string; description: string; priceCents: number; currency: string }[];
  boosts: (Boost & { postId: string; excerpt: string })[];
  campaigns: AdCampaign[];
};

const settled = <T,>(r: PromiseSettledResult<T>, fallback: T) => (r.status === 'fulfilled' ? r.value : fallback);

/**
 * Studio (apps/web/app/(app)/studio): the last 28 days of your posts and reels (views, reach,
 * likes, comments, saves, new followers per day), top posts and reels, what you earned, payouts,
 * sales and service bookings, subscribers, boosts and promotions. Making plans, adding products
 * and files, the video editor and new promotions stay on the web: a button opens Studio there.
 */
export default function StudioScreen() {
  const c = useColors();
  const { t, tp, number, locale, timeAgo, dateTime, date } = useT();
  const { me } = useSession();
  const ads = useFlag('ADS');
  const [data, setData] = useState<StudioData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!me) return;
    const api = await client();
    const [analytics, earnings, payouts, sales, bookings, subscribers, plans, boosts, campaigns] = await Promise.allSettled([
      api.creator.analytics(),
      api.creator.earnings(),
      api.creator.payouts(),
      api.shop.sales(30),
      api.shop.serviceBookings(),
      api.economy.subscribers(),
      api.economy.plans(me.id),
      api.boosts.mine(),
      api.ads.campaigns(),
    ]);
    if (analytics.status === 'rejected') {
      setError(errorMessage(analytics.reason));
      setData((cur) => cur ?? null);
      return;
    }
    setError(null);
    setData({
      analytics: analytics.value,
      earnings: settled(earnings, { balances: [] }).balances,
      payouts: settled(payouts, { items: [] }).items,
      sales: settled(sales, null),
      bookings: settled(bookings, { items: [] }).items,
      subscribers: settled(subscribers, null),
      plans: settled(plans, { items: [], mySubscription: null }).items,
      boosts: settled(boosts, { items: [] }).items,
      // Boosts are listed above; promotions are the other campaigns.
      campaigns: settled(campaigns, { items: [] }).items.filter((x) => x.boostDays === null),
    });
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === undefined) return <Loading />;
  if (data === null || !data.analytics)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }}>
        <ErrorState message={error ?? t('error.generic')} onRetry={load} />
      </View>
    );

  const a = data.analytics;
  const growth = a.followerGrowth.map((d) => Number(d.new_followers));
  const newFollowers = growth.reduce((x, y) => x + y, 0);
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale);

  async function decide(b: ServiceBooking, confirm: boolean) {
    try {
      await (await client()).bookings.decide(b.id, confirm);
      await load();
    } catch (e) {
      Alert.alert(t('m.studio.bookings'), errorMessage(e));
    }
  }

  /** Refund a whole order: the buyer gets their money back and its items go back on sale (asked first). */
  function refund(orderId: string, buyer: string) {
    const lines = data?.sales?.items.filter((x) => x.orderId === orderId) ?? [];
    if (!lines.length) return;
    const amount = money(
      lines.reduce((n, x) => n + x.amountCents, 0),
      lines[0]!.currency,
    );
    Alert.alert(t('studio.sales.refund'), t('studio.sales.refundConfirm', { amount, name: buyer }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('studio.sales.refund'),
        style: 'destructive',
        onPress: async () => {
          try {
            const r = await (await client()).orders.refund(orderId);
            Alert.alert(t('m.studio.sales'), t(r.status === 'succeeded' ? 'studio.sales.refundDone' : 'studio.sales.refundFailed'));
            await load();
          } catch (e) {
            Alert.alert(t('m.studio.sales'), errorMessage(e));
          }
        },
      },
    ]);
  }

  const topList = (items: CreatorTopPost[], reel: boolean) =>
    items.length ? (
      <View style={{ gap: space[2] }}>
        {items.map((p) => (
          <TopItem
            key={p.id}
            item={p}
            when={timeAgo(p.created_at)}
            onPress={() => (reel ? router.push({ pathname: '/reels', params: { start: p.id } }) : router.push(`/insights/${p.id}`))}
          />
        ))}
      </View>
    ) : (
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{reel ? t('m.studio.noReels') : t('m.studio.noPosts')}</Text>
    );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={{ gap: 2 }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }}>
          {t('m.studio.title')}
        </Text>
        <Text style={{ color: c.inkMuted }}>{t('m.studio.period')}</Text>
      </View>
      {me && !hasStudio(me.mode) ? <Notice>{t('m.studio.personal')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <StatGrid
        items={[
          { label: t('m.studio.views'), value: number(a.totals.views) },
          { label: t('m.studio.reach'), value: number(a.totals.reach) },
          { label: t('m.studio.likes'), value: number(Number(a.totals.likes)) },
          { label: t('m.studio.comments'), value: number(Number(a.totals.comments)) },
          { label: t('m.studio.saves'), value: number(Number(a.totals.saves)) },
          {
            label: t('profile.followers'),
            value: number(Number(a.totals.followers)),
            sub: tp('studio.followersNew', newFollowers, { count: number(newFollowers) }),
          },
        ]}
      />
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.studio.viewsNote')}</Text>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.growth')} />
        <DayBars values={growth} summary={t('m.studio.growthA11y', { total: number(newFollowers), peak: number(Math.max(0, ...growth)) })} />
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.topPosts')} />
        {topList(a.topPosts, false)}
      </View>
      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.topReels')} />
        {topList(a.topReels ?? [], true)}
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.earnings')} />
        {data.earnings.length ? (
          <StatGrid
            items={data.earnings.map((e) => ({
              label: t('m.studio.available', { currency: e.currency }),
              value: money(e.availableCents, e.currency),
              sub: [
                t('m.studio.earningsLine', { gross: money(e.grossCents, e.currency), fees: money(e.feeCents, e.currency) }),
                e.heldCents > 0 ? t('m.studio.earningsHeld', { amount: money(e.heldCents, e.currency), days: EARNINGS_HOLD_DAYS }) : null,
              ]
                .filter(Boolean)
                .join(' · '),
            }))}
          />
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.studio.noEarnings')}</Text>
        )}
        <Row title={t('m.gifts.title')} start={<Icon name="gift-outline" size={20} color={c.yapi} />} onPress={() => router.push('/gifts')} />
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.payouts')} />
        {data.payouts.length ? (
          <Card style={{ gap: space[3] }}>
            {data.payouts.map((p) => {
              const status = t(`m.studio.payout.${p.status}`);
              return (
                <View
                  key={p.id}
                  accessible
                  accessibilityLabel={`${money(p.amountCents, p.currency)}, ${status}, ${date(p.createdAt, { dateStyle: 'medium' })}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.ink, fontWeight: '700' }}>{money(p.amountCents, p.currency)}</Text>
                    <Text style={{ color: c.inkMuted, fontSize: 13 }}>{date(p.createdAt, { dateStyle: 'medium' })}</Text>
                  </View>
                  <Pill text={status} tone={p.status === 'paid' ? 'good' : p.status === 'failed' ? 'bad' : p.status === 'pending' ? 'warn' : 'neutral'} />
                </View>
              );
            })}
          </Card>
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.studio.noPayouts')}</Text>
        )}
        <Button label={t('m.studio.payouts.manage')} variant="secondary" icon="open-outline" onPress={() => openOnWeb('/studio#payouts')} />
      </View>

      {data.sales ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('m.studio.sales')} />
          {data.sales.totals.length ? (
            <StatGrid
              items={data.sales.totals.map((x) => ({
                label: tp('m.studio.salesCount', x.orders, { currency: x.currency }),
                value: money(x.netCents, x.currency),
                sub: t('m.studio.salesGross', { gross: money(x.grossCents, x.currency) }),
              }))}
            />
          ) : (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.studio.noSales')}</Text>
          )}
          {data.sales.items.slice(0, 10).map((x) => (
            <Row
              key={`${x.orderId}-${x.product.id}`}
              title={x.product.title}
              subtitle={`${x.buyer.displayName} · ${timeAgo(x.createdAt)}`}
              end={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <Text style={{ color: c.ink, fontWeight: '700' }}>{money(x.amountCents, x.currency)}</Text>
                  {x.status === 'refunded' ? (
                    <Pill text={t('m.studio.refunded')} tone="warn" />
                  ) : (
                    <Button
                      label={t('studio.sales.refund')}
                      size="sm"
                      variant="secondary"
                      accessibilityLabel={t('studio.sales.refundA11y', { title: x.product.title, name: x.buyer.displayName })}
                      onPress={() => refund(x.orderId, x.buyer.displayName)}
                    />
                  )}
                </View>
              }
            />
          ))}
        </View>
      ) : null}

      {data.bookings.length ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('m.studio.bookings')} />
          {data.bookings.map((b) => (
            <Card key={b.id} style={{ gap: space[2] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                <Text style={[{ color: c.ink, fontWeight: '700', flex: 1 }, userText]}>{b.product.title}</Text>
                <Pill text={t(`m.booking.status.${b.status}`)} tone={b.status === 'confirmed' ? 'good' : b.status === 'requested' ? 'warn' : 'neutral'} />
              </View>
              <Text style={{ color: c.ink }}>{dateTime(b.startsAt)}</Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
                {b.customer.displayName}
                {b.amountCents && b.currency ? ` · ${money(b.amountCents, b.currency)}` : ''}
              </Text>
              {b.note ? <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>{b.note}</Text> : null}
              {b.status === 'requested' ? (
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  <Button label={t('m.studio.confirm')} size="sm" onPress={() => decide(b, true)} />
                  <Button
                    label={t('m.studio.decline')}
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      Alert.alert(t('m.studio.declineTitle'), t('m.studio.declineBody'), [
                        { text: t('common.cancel'), style: 'cancel' },
                        { text: t('m.studio.decline'), style: 'destructive', onPress: () => void decide(b, false) },
                      ])
                    }
                  />
                </View>
              ) : null}
            </Card>
          ))}
        </View>
      ) : null}

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.subscriptions')} />
        <Card style={{ gap: space[2] }}>
          {data.subscribers ? (
            <Text style={{ color: c.ink, fontWeight: '700' }}>
              {tp('m.studio.subscriberCount', data.subscribers.active, { count: number(data.subscribers.active) })}
            </Text>
          ) : null}
          {data.plans.length ? (
            data.plans.map((p) => (
              <Text key={p.id} style={[{ color: c.ink }, userText]}>
                {p.name} · {t('m.money.perMonth', { price: money(p.priceCents, p.currency) })}
              </Text>
            ))
          ) : (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.studio.noPlans')}</Text>
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.studio.boosts')} />
        {data.boosts.length ? (
          data.boosts.map((b) => (
            <View key={b.campaignId} style={{ gap: space[1] }}>
              <BoostResult boost={b} title={b.excerpt || t('m.studio.untitledPost')} />
              <Button label={t('m.studio.openInsights')} size="sm" variant="ghost" onPress={() => router.push(`/insights/${b.postId}`)} />
            </View>
          ))
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.studio.noBoosts')}</Text>
        )}
      </View>

      {ads && data.campaigns.length ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('m.studio.campaigns')} />
          {data.campaigns.map((x) => (
            <BoostResult
              key={x.id}
              title={x.name}
              boost={{
                campaignId: x.id,
                status: x.status,
                audience: x.countries.length ? { type: 'country', countries: x.countries } : { type: 'interests', topics: x.topics },
                days: null,
                currency: x.currency,
                budgetCents: x.budgetCents,
                spentCents: x.spentCents,
                refundedCents: x.refundedCents,
                impressions: x.impressions,
                clicks: x.clicks,
                ctr: x.ctr,
                reviewNote: null,
                approvedAt: x.approvedAt,
                endsAt: x.endsAt,
                createdAt: x.startsAt ?? '',
              }}
            />
          ))}
        </View>
      ) : null}

      <Card style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.studio.webHint')}</Text>
        <Button label={t('m.studio.openWeb')} variant="secondary" icon="open-outline" onPress={() => openOnWeb('/studio')} />
      </Card>
    </ScrollView>
  );
}

/** A top post or reel: its words (or what it is), when, and its likes, comments and views. */
function TopItem({ item, when, onPress }: { item: CreatorTopPost; when: string; onPress: () => void }) {
  const c = useColors();
  const { t, number } = useT();
  const title = item.excerpt?.trim() || (item.format === 'reel' ? t('m.studio.untitledReel') : t('m.studio.untitledPost'));
  const stats: [Parameters<typeof Icon>[0]['name'], number][] = [
    ['heart-outline', item.like_count],
    ['chatbubble-outline', item.comment_count],
    ['eye-outline', item.view_count ?? 0],
  ];
  return (
    <Card
      onPress={onPress}
      label={`${title}. ${t('m.studio.postStatsA11y', { likes: number(item.like_count), comments: number(item.comment_count), views: number(item.view_count ?? 0) })}`}
      style={{ gap: space[2] }}
    >
      <Text style={[{ color: c.ink, fontWeight: '600', lineHeight: 20 }, userText]} numberOfLines={2}>
        {title}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        {stats.map(([icon, n]) => (
          <View key={icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name={icon} size={15} color={c.inkMuted} />
            <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{number(n)}</Text>
          </View>
        ))}
        <View style={{ flex: 1 }} />
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{when}</Text>
      </View>
    </Card>
  );
}
