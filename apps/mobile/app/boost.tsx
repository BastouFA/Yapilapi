import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { Boost } from '../../../packages/api-client/src/index';
import { BOOST_DAYS, BOOST_OPTIONS, currencyForCountry } from '../../../packages/shared/src/constants';
import { formatMoney } from '../../../packages/shared/src/i18n';
import type { Post } from '../../../packages/shared/src/types';
import { client } from '../lib/api';
import { SectionHeader } from '../lib/chips';
import { BoostResult } from '../lib/creator';
import { useFlag } from '../lib/flags';
import { ChoiceField, FieldError, TopicsField } from '../lib/forms';
import { useT } from '../lib/i18n';
import { useWebCheckout } from '../lib/money';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, Card, EmptyState, KeyboardAvoid, Loading, Notice, useColors, userText } from '../lib/ui';

/** Countries offered for a boost audience, as on the web (apps/web/components/Boost.tsx). Yours is always first. */
const COUNTRIES = ['NG', 'GH', 'KE', 'ZA', 'CI', 'SN', 'CM', 'UG', 'TZ', 'RW', 'ET', 'EG', 'MA', 'US', 'CA', 'GB', 'FR', 'DE', 'BR', 'IN'];

/**
 * Boost one of your public posts (`boost?id=<post>`): choose the budget, how long and who sees it,
 * read what that buys, and continue on the web, where the boost is created and paid with the
 * same choices filled in. The post's boosts so far are shown with their results; while one is
 * running, another can't start.
 */
export default function BoostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, number, locale } = useT();
  const { me } = useSession();
  const ads = useFlag('ADS');
  const commerce = useFlag('COMMERCE');
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  const [boosts, setBoosts] = useState<Boost[]>([]);

  const [currency, setCurrency] = useState<string>(() => {
    const cur = currencyForCountry(me?.country);
    return BOOST_OPTIONS[cur] ? cur : 'USD';
  });
  const options = BOOST_OPTIONS[currency]!;
  const [budget, setBudget] = useState<number>(options.budgets[0]!);
  const [days, setDays] = useState<number>(3);
  const [audience, setAudience] = useState<'country' | 'interests'>('country');
  const [country, setCountry] = useState(me?.country ?? 'NG');
  const [topics, setTopics] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = await client();
    try {
      const p = (await api.posts.get(id)).post;
      setPost(p);
      setTopics((cur) => (cur.length ? cur : p.topics.slice(0, 3)));
    } catch {
      setPost(null);
    }
    try {
      setBoosts((await api.boosts.forPost(id)).items);
    } catch {
      setBoosts([]);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const { open, opened } = useWebCheckout(() => void load());

  const regionName = useMemo(() => {
    try {
      const dn = new Intl.DisplayNames([locale], { type: 'region' });
      return (code: string) => dn.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [locale]);

  if (post === undefined) return <Loading />;
  if (post === null || post.author.id !== me?.id)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.insights.unavailable')} />
      </View>
    );
  if (ads === false || commerce === false)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.boost.unavailable')} />
      </View>
    );

  const running = boosts.find((b) => ['pending_review', 'active', 'paused'].includes(b.status));
  const price = formatMoney(budget, currency, locale);
  const reach = Math.floor((budget / options.cpmCents) * 1000);
  const countries = [...new Set([...(me?.country ? [me.country] : []), ...COUNTRIES])];

  function continueOnWeb() {
    setError(null);
    if (audience === 'interests' && !topics.length) return setError(t('m.boost.needInterest'));
    // Built by hand: React Native's URLSearchParams can't set values on every version.
    const q: [string, string][] = [
      ['boost', '1'],
      ['currency', currency],
      ['budget', String(budget)],
      ['days', String(days)],
      audience === 'country' ? ['country', country] : ['topics', topics.join(',')],
    ];
    open(`/p/${encodeURIComponent(id)}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`);
  }

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Card onPress={() => router.push(`/p/${post.id}`)} label={t('m.insights.openPost')}>
          <Text style={[{ color: c.ink, lineHeight: 20 }, userText]} numberOfLines={3}>
            {post.body?.trim() || (post.format === 'reel' ? t('m.studio.untitledReel') : t('m.studio.untitledPost'))}
          </Text>
        </Card>

        {running ? (
          <View style={{ gap: space[2] }}>
            <Notice>{t('m.boost.running')}</Notice>
          </View>
        ) : post.visibility !== 'public' ? (
          <Notice>{t('m.boost.onlyPublic')}</Notice>
        ) : (
          <>
            <Text style={{ color: c.ink, lineHeight: 22 }}>{t('m.boost.intro')}</Text>
            <ChoiceField
              label={t('m.boost.currency')}
              value={currency}
              options={Object.keys(BOOST_OPTIONS).map((x) => ({ id: x, label: x }))}
              onChange={(x) => {
                setCurrency(x);
                setBudget(BOOST_OPTIONS[x]!.budgets[0]!);
              }}
            />
            <ChoiceField
              label={t('m.boost.budget')}
              value={String(budget)}
              options={options.budgets.map((b) => ({ id: String(b), label: formatMoney(b, currency, locale) }))}
              onChange={(x) => setBudget(Number(x))}
            />
            <ChoiceField
              label={t('m.boost.howLong')}
              value={String(days)}
              options={BOOST_DAYS.map((d) => ({ id: String(d), label: tp('m.boost.days', d) }))}
              onChange={(x) => setDays(Number(x))}
            />
            <ChoiceField
              label={t('m.boost.who')}
              value={audience}
              options={[
                { id: 'country', label: t('m.boost.country'), icon: 'flag-outline' },
                { id: 'interests', label: t('m.boost.interests'), icon: 'pricetags-outline' },
              ]}
              onChange={setAudience}
            />
            {audience === 'country' ? (
              <ChoiceField
                label={t('m.boost.countryLabel')}
                value={country}
                options={countries.map((x) => ({ id: x, label: regionName(x) }))}
                onChange={setCountry}
              />
            ) : (
              <View style={{ gap: space[1] }}>
                <TopicsField label={t('m.boost.interestsLabel')} hint={t('m.boost.interestsHint')} value={topics} onChange={setTopics} max={10} />
                <FieldError text={error} />
              </View>
            )}

            <Card style={{ gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
                {t('m.boost.summary')}
              </Text>
              <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{t('m.boost.estimate', { views: number(reach), price })}</Text>
              <Text style={[{ color: c.inkMuted, lineHeight: 20 }, userText]}>
                {audience === 'country'
                  ? t('m.boost.audienceCountries', { places: regionName(country) })
                  : topics.length
                    ? t('m.boost.audienceInterests', { topics: topics.join(', ') })
                    : t('m.boost.needInterest')}
                {' · '}
                {tp('m.boost.days', days)}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.boost.rules')}</Text>
              <Button label={t('m.boost.continue')} icon="open-outline" onPress={continueOnWeb} />
              <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
                {opened ? t('m.boost.afterPaying') : t('m.boost.onWeb')}
              </Text>
            </Card>
          </>
        )}

        {boosts.length ? (
          <View style={{ gap: space[2] }}>
            <SectionHeader title={t('m.boost.results')} />
            {boosts.map((b) => (
              <BoostResult key={b.campaignId} boost={b} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoid>
  );
}
