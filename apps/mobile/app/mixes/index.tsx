import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import type { Mix, MixFilter } from '../../../../packages/shared/src/mixes';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { MixEditor, MixTile, openMix } from '../../lib/mixes';
import { space } from '../../lib/theme';
import { Button, EmptyState, ErrorState, Loading, Segmented, useColors } from '../../lib/ui';

/** "Your mixes": the ones you made, the ones shared with you in chats, and the ones you saved. Making a mix starts here. */
export default function MixesScreen() {
  const c = useColors();
  const { t } = useT();
  const [filter, setFilter] = useState<MixFilter>('own');
  const [items, setItems] = useState<Mix[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).mixes.mine(filter)).items);
      setError(null);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [filter]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const empty =
    filter === 'own'
      ? { title: t('mixes.emptyOwn.title'), body: t('mixes.emptyOwn.body') }
      : filter === 'shared'
        ? { title: t('mixes.emptyShared.title'), body: t('mixes.emptyShared.body') }
        : { title: t('mixes.emptySaved.title') };
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
      <Stack.Screen options={{ title: t('mixes.title') }} />
      <Button label={t('mixes.new')} icon="add" onPress={() => setEditing(true)} />
      <Segmented
        label={t('mixes.title')}
        value={filter}
        onChange={(f) => (setItems(null), setFilter(f))}
        options={[
          { id: 'own', label: t('mixes.filter.own') },
          { id: 'shared', label: t('mixes.filter.shared') },
          { id: 'saved', label: t('mixes.filter.saved') },
        ]}
      />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {items === null ? (
        <Loading />
      ) : items.length ? (
        items.map((m) => <MixTile key={m.id} mix={{ available: true, ...m }} />)
      ) : (
        <EmptyState icon="list" title={empty.title} body={empty.body} />
      )}
      <MixEditor
        visible={editing}
        onClose={() => setEditing(false)}
        onSaved={(m) => {
          setEditing(false);
          openMix(m.id);
        }}
      />
    </ScrollView>
  );
}
