import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { EventItem } from '../../../packages/shared/src/index';
import { client, errorMessage } from '../lib/api';
import { HeaderAction } from '../lib/forms';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { EmptyState, ErrorState, Loading, Row, Screen, Segmented, useRefresh } from '../lib/ui';

type Scope = 'upcoming' | 'now' | 'going' | 'hosting';
const SCOPES: { id: Scope; label: MessageKey; empty: MessageKey }[] = [
  { id: 'upcoming', label: 'm.events.upcoming', empty: 'm.events.empty.upcoming' },
  { id: 'now', label: 'm.events.now', empty: 'm.events.empty.now' },
  { id: 'going', label: 'm.events.goingTab', empty: 'm.events.empty.going' },
  { id: 'hosting', label: 'm.events.hosting', empty: 'm.events.empty.hosting' },
];

/** Events you can see: upcoming, happening now, ones you're going to and ones you host. Each opens its page, where you answer. */
export default function Events() {
  const { t, dateTime } = useT();
  const [scope, setScope] = useState<Scope>('upcoming');
  const [items, setItems] = useState<EventItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visit, setVisit] = useState(0);
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: () => <HeaderAction label={t('m.events.new')} icon="add" onPress={() => router.push('/event-edit')} /> });
  }, [navigation, t]);
  // Again on coming back, so an event just made, changed or cancelled shows as it is now.
  useFocusEffect(useCallback(() => setVisit((v) => v + 1), []));
  // Only the latest request counts (switching tabs quickly, or pulling to refresh).
  const seq = useRef(0);
  const load = useCallback(async () => {
    const run = ++seq.current;
    setError(null);
    try {
      const r = await (await client()).events.list(scope);
      if (run === seq.current) setItems(r.items);
    } catch (e) {
      if (run !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [scope]);
  useEffect(() => {
    if (visit) void load();
  }, [load, visit]);
  const refresh = useRefresh(load);
  return (
    <Screen style={{ gap: space[3] }}>
      <Segmented
        label={t('m.events.scope')}
        value={scope}
        onChange={(v) => (setItems(null), setScope(v))}
        options={SCOPES.map((x) => ({ id: x.id, label: t(x.label) }))}
      />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={items}
          keyExtractor={(e) => e.id}
          refreshControl={refresh}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          renderItem={({ item }) => (
            <Row
              title={item.title}
              subtitle={[dateTime(item.startsAt), item.place?.name ?? item.locationText].filter(Boolean).join(' · ')}
              onPress={() => router.push(`/event/${item.id}`)}
            />
          )}
          ListEmptyComponent={error ? null : <EmptyState title={t('m.events.none')} body={t(SCOPES.find((x) => x.id === scope)!.empty)} />}
        />
      )}
    </Screen>
  );
}
