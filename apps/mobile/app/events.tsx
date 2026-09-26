import { useEffect, useState } from 'react';
import { FlatList } from 'react-native';
import type { EventItem } from '../../../packages/shared/src/index';
import { client, errorMessage } from '../lib/api';
import { space } from '../lib/theme';
import { EmptyState, Loading, Notice, Row, Screen, Segmented } from '../lib/ui';

type Scope = 'upcoming' | 'now' | 'going' | 'hosting';
const EMPTY: Record<Scope, string> = {
  upcoming: 'No upcoming events you can see yet.',
  now: 'Nothing is happening right now.',
  going: "You haven't said you're going to anything yet.",
  hosting: "You aren't hosting any events.",
};

/** Events you can see: upcoming, happening now, ones you're going to and ones you host. */
export default function Events() {
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
      <Segmented
        label="Which events"
        value={scope}
        onChange={setScope}
        options={[
          { id: 'upcoming', label: 'Upcoming' },
          { id: 'now', label: 'Now' },
          { id: 'going', label: 'Going' },
          { id: 'hosting', label: 'Hosting' },
        ]}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          renderItem={({ item }) => (
            <Row title={item.title} subtitle={[new Date(item.startsAt).toLocaleString(), item.place?.name ?? item.locationText].filter(Boolean).join(' · ')} />
          )}
          ListEmptyComponent={<EmptyState title="No events" body={EMPTY[scope]} />}
        />
      )}
    </Screen>
  );
}
