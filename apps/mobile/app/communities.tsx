import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import type { Community } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { HeaderAction } from '../lib/forms';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { Avatar, EmptyState, ErrorState, Icon, Row, Screen, Segmented, SkeletonList, useColors, useRefresh } from '../lib/ui';

type Scope = 'mine' | 'discover';

/** Communities: the ones you're in (with their posts, FAQ, rooms and members a tap away), and ones to discover. */
export default function Communities() {
  const c = useColors();
  const { t, tp } = useT();
  const [scope, setScope] = useState<Scope>('mine');
  const [items, setItems] = useState<Community[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: () => <HeaderAction label={t('m.communities.new')} icon="add" onPress={() => router.push('/community-new')} /> });
  }, [navigation, t]);

  // Only the latest request counts (switching tabs quickly, or pulling to refresh).
  const seq = useRef(0);
  const load = useCallback(async () => {
    const run = ++seq.current;
    setError(null);
    try {
      const r = await (await client()).communities.list(scope);
      if (run === seq.current) setItems(r.items);
    } catch (e) {
      if (run !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [scope]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  const refresh = useRefresh(load);

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <Segmented
        label={t('communities.title')}
        value={scope}
        onChange={setScope}
        options={[
          { id: 'mine', label: t('m.communities.mine') },
          { id: 'discover', label: t('m.communities.discover') },
        ]}
      />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {items === null ? (
        <SkeletonList />
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={items}
          keyExtractor={(x) => x.id}
          refreshControl={refresh}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          ListEmptyComponent={error ? null : <EmptyState title={scope === 'mine' ? t('m.communities.emptyMine') : t('m.communities.emptyDiscover')} />}
          renderItem={({ item }) => (
            <Row
              title={item.name}
              subtitle={[tp('m.community.members', item.memberCount), item.visibility === 'private' ? t('m.community.private') : null]
                .filter(Boolean)
                .join(' · ')}
              start={<Avatar name={item.name} size={40} />}
              end={<Icon name="chevron-forward" size={18} color={c.inkMuted} directional />}
              onPress={() => router.push(`/c/${item.slug}`)}
            />
          )}
        />
      )}
    </Screen>
  );
}
