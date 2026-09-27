import { useCallback, useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { WeeklyWrapCard } from '../../../../packages/shared/src/wrap';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { EmptyState, ErrorState, SkeletonList, Title, useColors, useRefresh } from '../../lib/ui';
import { WrapRow } from '../../lib/wrap';

/** Past weeks: your weekly wraps, newest first. Only you see them. */
export default function Wraps() {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<WeeklyWrapCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await (await client()).wraps.list()).items);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setItems((cur) => cur ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const refresh = useRefresh(load);
  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3] }}
      data={items ?? []}
      keyExtractor={(w) => w.id}
      refreshControl={refresh}
      ListHeaderComponent={
        <View style={{ gap: space[3] }}>
          <Title sub={t('wrap.private')}>{t('wrap.past')}</Title>
          {error ? <ErrorState message={error} onRetry={load} /> : null}
        </View>
      }
      ListEmptyComponent={
        items === null ? <SkeletonList /> : error ? null : <EmptyState icon="sparkles-outline" title={t('wrap.past')} body={t('wrap.none')} />
      }
      renderItem={({ item }) => <WrapRow wrap={item} />}
    />
  );
}
