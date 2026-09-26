import { useEffect, useState } from 'react';
import { FlatList } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { EventItem } from '../../../packages/shared/src/index';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { EmptyState, Loading, Notice, Row, Screen, Segmented } from '../lib/ui';

type Scope = 'upcoming' | 'now' | 'going' | 'hosting';
const SCOPES: { id: Scope; label: MessageKey; empty: MessageKey }[] = [
  { id: 'upcoming', label: 'm.events.upcoming', empty: 'm.events.empty.upcoming' },
  { id: 'now', label: 'm.events.now', empty: 'm.events.empty.now' },
  { id: 'going', label: 'm.events.goingTab', empty: 'm.events.empty.going' },
  { id: 'hosting', label: 'm.events.hosting', empty: 'm.events.empty.hosting' },
];

/** Events you can see: upcoming, happening now, ones you're going to and ones you host. */
export default function Events() {
  const { t, dateTime } = useT();
  const [scope, setScope] = useState<Scope>('upcoming');
  const [items, setItems] = useState<EventItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    client()
      .then((api) => api.events.list(scope))
      .then(
        (r) => live && setItems(r.items),
        (e) => live && (setItems([]), setError(errorMessage(e))),
      );
    return () => {
      live = false;
    };
  }, [scope]);
  return (
    <Screen style={{ gap: space[3] }}>
      <Segmented label={t('m.events.scope')} value={scope} onChange={setScope} options={SCOPES.map((x) => ({ id: x.id, label: t(x.label) }))} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          renderItem={({ item }) => (
            <Row title={item.title} subtitle={[dateTime(item.startsAt), item.place?.name ?? item.locationText].filter(Boolean).join(' · ')} />
          )}
          ListEmptyComponent={<EmptyState title={t('m.events.none')} body={t(SCOPES.find((x) => x.id === scope)!.empty)} />}
        />
      )}
    </Screen>
  );
}
