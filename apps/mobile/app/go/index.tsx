import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PlanCard } from '../../../../packages/shared/src/plans';
import { client, errorMessage } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { FreeStrip, PlanRow } from '../../lib/plans';
import { useRealtime, useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, Notice, SkeletonList, useColors } from '../../lib/ui';

/** The Plans screen (docs/product/go-out-together.md): who's free, your plans coming up, then earlier ones. */
export default function PlansHome() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const on = useFlag('GO_OUT') !== false;
  const [lists, setLists] = useState<{ upcoming: PlanCard[]; past: PlanCard[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    void client()
      .then((api) => api.plans.list())
      .then(
        (r) => {
          setLists(r);
          setProblem(null);
        },
        (e) => setProblem(errorMessage(e)),
      );
  }, []);
  // Reload when coming back from a plan (answered, changed, cancelled).
  useFocusEffect(load);
  useRealtime((e) => {
    if (e.type === 'plan.changed') load();
  });

  if (!on) return <EmptyState title={t('plans.title')} icon="calendar-outline" />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  const section = (key: 'plans.upcoming' | 'plans.past', items: PlanCard[]) =>
    items.length ? (
      <View style={{ gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t(key)}
        </Text>
        {items.map((p) => (
          <PlanRow key={p.id} plan={p} />
        ))}
      </View>
    ) : null;

  return (
    <ScrollView style={{ backgroundColor: c.ground }} contentContainerStyle={{ padding: space[4], gap: space[6], paddingBottom: space[8] }}>
      <FreeStrip home />
      {problem ? (
        <ErrorState message={problem} onRetry={load} />
      ) : !lists ? (
        <SkeletonList count={3} />
      ) : !lists.upcoming.length && !lists.past.length ? (
        <EmptyState title={t('plans.empty')} icon="calendar-outline" action={{ label: t('plans.make'), icon: 'add', onPress: () => router.push('/go/new') }} />
      ) : (
        <>
          {section('plans.upcoming', lists.upcoming)}
          {section('plans.past', lists.past)}
          <Button label={t('plans.make')} icon="add" variant="secondary" onPress={() => router.push('/go/new')} />
        </>
      )}
    </ScrollView>
  );
}
