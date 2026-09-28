import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Boost, PostInsights } from '../../../../packages/api-client/src/index';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { SectionHeader } from '../../lib/chips';
import { BoostResult, DayBars, StatGrid } from '../../lib/creator';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { ManagedOnWeb, useDigitalPurchases } from '../../lib/store';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, ErrorState, Loading, Notice, useColors, userText } from '../../lib/ui';

/**
 * How one of your posts is doing (from its More menu, "See insights"): views, likes, comments,
 * saves and reposts, views per day over the last 28 days, and the results of its boosts, with a
 * way to boost it. Co-authors see it too.
 */
export default function InsightsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, number, date } = useT();
  const { me } = useSession();
  const ads = useFlag('ADS');
  const commerce = useFlag('COMMERCE');
  const offer = useDigitalPurchases();
  const [data, setData] = useState<{ insights: PostInsights; post: Post | null; boosts: Boost[] } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = await client();
      const [insights, post, boosts] = await Promise.all([
        api.creator.postInsights(id),
        api.posts.get(id).then(
          (r) => r.post,
          () => null,
        ),
        // Boosts are the author's own; a co-author gets none.
        api.boosts.forPost(id).then(
          (r) => r.items,
          () => [] as Boost[],
        ),
      ]);
      setData({ insights: insights.insights, post, boosts });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setData((cur) => cur ?? null);
    }
  }, [id]);

  // Back from the boost screen (or the web checkout), show the boost.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (data === undefined) return <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }}>
        <EmptyState title={t('m.insights.unavailable')} />
        {error ? <ErrorState message={error} onRetry={load} /> : null}
      </View>
    );

  const s = data.insights;
  const perDay = s.viewsByDay.map((d) => d.views);
  const recent = perDay.reduce((a, b) => a + b, 0);
  const running = data.boosts.some((b) => ['pending_review', 'active', 'paused'].includes(b.status));
  // Only the author boosts a post; co-authors see the numbers.
  const own = !!data.post && data.post.author.id === me?.id;
  const boostable = ads === true && commerce !== false && !!data.post && data.post.visibility === 'public' && !running;
  // A boost is a digital good: offered only where the app store rules allow a link out (lib/store.tsx).
  const canBoost = boostable && offer === 'link';
  const boostHidden = boostable && offer !== 'link';

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
      {data.post ? (
        <Card
          onPress={() => router.push(s.format === 'reel' ? { pathname: '/reels', params: { start: s.postId } } : `/p/${s.postId}`)}
          label={t('m.insights.openPost')}
        >
          <Text style={[{ color: c.ink, lineHeight: 20 }, userText]} numberOfLines={3}>
            {data.post.body?.trim() || (s.format === 'reel' ? t('m.studio.untitledReel') : t('m.studio.untitledPost'))}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 12, marginTop: space[1] }}>{date(s.createdAt, { dateStyle: 'medium' })}</Text>
        </Card>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <StatGrid
        items={[
          { label: t('m.studio.views'), value: number(s.views) },
          { label: t('m.studio.likes'), value: number(s.likes) },
          { label: t('m.studio.comments'), value: number(s.comments) },
          { label: t('m.studio.saves'), value: number(s.saves) },
          { label: t('post.reposts'), value: number(s.reposts) },
        ]}
      />
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.insights.viewsNote')}</Text>

      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('m.insights.viewsByDay')} />
        <DayBars values={perDay} summary={t('m.insights.viewsA11y', { total: number(recent), peak: number(Math.max(0, ...perDay)) })} />
      </View>

      {own && (data.boosts.length || canBoost || boostHidden) ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title={t('m.studio.boosts')} />
          {data.boosts.map((b) => (
            <BoostResult key={b.campaignId} boost={b} />
          ))}
          {canBoost ? (
            <Button label={t('m.boost.cta')} icon="rocket-outline" onPress={() => router.push({ pathname: '/boost', params: { id: s.postId } })} />
          ) : boostHidden ? (
            <ManagedOnWeb text={t('m.store.boost')} />
          ) : running ? (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.boost.running')}</Text>
          ) : data.post && data.post.visibility !== 'public' && ads === true ? (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.boost.onlyPublic')}</Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}
