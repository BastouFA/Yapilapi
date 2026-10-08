import { Text, View } from 'react-native';
import type { Boost } from '../../../packages/api-client/src/index';
import { formatMoney } from '../../../packages/shared/src/i18n-core';
import { Pill } from './forms';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Card, useColors, userText } from './ui';
import { regionName } from './regions';
import { formatList } from '../../../packages/shared/src/feed-reasons';

/** Profile types that get Studio in the You tab (anyone can open it from a link). */
export const STUDIO_MODES = ['creator', 'professional', 'business'] as const;
export const hasStudio = (mode: string | undefined) => !!mode && (STUDIO_MODES as readonly string[]).includes(mode);

/** Numbers in tiles, two or three to a row: "Views 1,204". Each tile reads as one thing. */
export function StatGrid({ items }: { items: { label: string; value: string; sub?: string }[] }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      {items.map((s) => (
        <View
          key={s.label}
          accessible
          accessibilityLabel={[`${s.label}: ${s.value}`, s.sub].filter(Boolean).join('. ')}
          style={{ flexGrow: 1, flexBasis: '30%', minWidth: 96, backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: 2 }}
        >
          <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
            {s.label}
          </Text>
          <Text style={{ color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {s.value}
          </Text>
          {s.sub ? (
            <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={2}>
              {s.sub}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * One bar per day, oldest first (they follow the reading direction, so right-to-left layouts
 * start on the right). Drawn with plain Views, no chart library. Screen readers hear `summary`.
 */
export function DayBars({ values, summary, height = 96 }: { values: number[]; summary: string; height?: number }) {
  const c = useColors();
  const { t } = useT();
  const peak = Math.max(1, ...values);
  return (
    <Card style={{ gap: space[2] }}>
      <View accessible accessibilityRole="image" accessibilityLabel={summary} style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
        {values.map((v, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: v ? Math.max(4, Math.round((v / peak) * height)) : 2,
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
              backgroundColor: v ? c.yapi : c.line,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.studio.chartStart')}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.studio.chartEnd')}</Text>
      </View>
    </Card>
  );
}

/** A boost's status in words, with a tone. */
export function useBoostStatus() {
  const { t } = useT();
  return (status: Boost['status']) => {
    const tone: 'good' | 'warn' | 'bad' | 'neutral' =
      status === 'active' ? 'good' : status === 'pending_review' || status === 'paused' ? 'warn' : status === 'rejected' ? 'bad' : 'neutral';
    return { label: t(`m.boost.status.${status}`), tone };
  };
}

/** Who a boost is shown to: people in some countries, or people with some interests. */
export function useAudienceText() {
  const { t, locale } = useT();
  return (a: Boost['audience']) => {
    if (a.type === 'interests') return t('m.boost.audienceInterests', { topics: a.topics.join(', ') });
    const names = a.countries.map((x) => regionName(x, locale));
    return t('m.boost.audienceCountries', { places: formatList(names, locale, t) });
  };
}

/** One boost and its results so far: status, audience, how long, shown, taps, spent of the budget. */
export function BoostResult({ boost, title }: { boost: Boost; title?: string }) {
  const c = useColors();
  const { t, tp, number, date, locale } = useT();
  const status = useBoostStatus()(boost.status);
  const audience = useAudienceText()(boost.audience);
  const money = (cents: number) => formatMoney(cents, boost.currency, locale);
  return (
    <Card style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        {title ? (
          <Text style={[{ color: c.ink, fontWeight: '700', flex: 1 }, userText]} numberOfLines={2}>
            {title}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pill text={status.label} tone={status.tone} />
      </View>
      <Text style={[{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }, userText]}>
        {audience}
        {boost.days ? ` · ${tp('m.boost.days', boost.days)}` : ''}
      </Text>
      <StatGrid
        items={[
          { label: t('m.boost.shown'), value: number(boost.impressions) },
          { label: t('m.boost.taps'), value: number(boost.clicks) },
          { label: t('m.boost.ctr'), value: number(boost.ctr / 100, { style: 'percent', maximumFractionDigits: 2 }) },
        ]}
      />
      <Text style={{ color: c.ink, fontSize: 13 }}>{t('m.boost.spentOf', { spent: money(boost.spentCents), budget: money(boost.budgetCents) })}</Text>
      {boost.refundedCents ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.boost.refunded', { amount: money(boost.refundedCents) })}</Text> : null}
      {boost.endsAt && boost.status === 'active' ? (
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.boost.endsAt', { date: date(boost.endsAt, { dateStyle: 'medium' }) })}</Text>
      ) : null}
      {boost.reviewNote ? <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>{t('m.boost.reviewNote', { note: boost.reviewNote })}</Text> : null}
    </Card>
  );
}
