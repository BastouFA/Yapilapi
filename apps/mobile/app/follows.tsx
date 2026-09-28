import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Loading, Row, Screen, Segmented, useRefresh } from '../lib/ui';

type Kind = 'followers' | 'following';

/**
 * Followers and following of one person (`?id=&kind=&name=&self=`), with Follow buttons for
 * people you don't follow yet. Opened from the counts on a profile.
 */
export default function Follows() {
  const params = useLocalSearchParams<{ id: string; kind?: Kind; name?: string; self?: string }>();
  const navigation = useNavigation();
  const { t } = useT();
  const { me } = useSession();
  const name = params.name ?? '';
  const self = params.self === '1';
  const [kind, setKind] = useState<Kind>(params.kind === 'following' ? 'following' : 'followers');
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [follows, setFollows] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: t(kind === 'followers' ? 'follow.titleFollowers' : 'follow.titleFollowing', { name }) });
  }, [navigation, kind, name, t]);

  // Only the latest request counts (switching tabs quickly, or pulling to refresh).
  const seq = useRef(0);
  const load = useCallback(async () => {
    const run = ++seq.current;
    setError(null);
    try {
      const api = await client();
      const r = await (kind === 'followers' ? api.users.followers(params.id) : api.users.following(params.id));
      if (run !== seq.current) return;
      setItems(r.items);
      setCursor(r.nextCursor);
      setFollows(new Set(r.viewerFollows));
    } catch (e) {
      if (run !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [kind, params.id]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  const refresh = useRefresh(load);

  const more = async () => {
    if (!cursor) return;
    const api = await client();
    const r = await (kind === 'followers' ? api.users.followers(params.id, cursor) : api.users.following(params.id, cursor));
    setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
    setCursor(r.nextCursor);
    setFollows((f) => new Set([...f, ...r.viewerFollows]));
  };

  // Stable (it's told whether you follow them), so the memoised rows keep the same props.
  const toggle = useCallback(async (u: PublicUser, on: boolean) => {
    setBusy(u.id);
    setError(null);
    try {
      const api = await client();
      await (on ? api.users.unfollow(u.id) : api.users.follow(u.id));
      setFollows((f) => {
        const next = new Set(f);
        if (on) next.delete(u.id);
        else next.add(u.id);
        return next;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, []);
  const meId = me?.id;
  const renderPerson = useCallback(
    ({ item: u }: { item: PublicUser }) => <PersonRow u={u} on={follows.has(u.id)} busy={busy === u.id} self={u.id === meId} onToggle={toggle} />,
    [follows, busy, meId, toggle],
  );

  const empty =
    kind === 'followers'
      ? self
        ? t('follow.emptyFollowersSelf')
        : t('follow.emptyFollowers', { name })
      : self
        ? t('follow.emptyFollowingSelf')
        : t('follow.emptyFollowing', { name });

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <Segmented
        label={t('follow.list')}
        value={kind}
        onChange={setKind}
        options={[
          { id: 'followers', label: t('profile.followers') },
          { id: 'following', label: t('profile.following') },
        ]}
      />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={items}
          keyExtractor={(u) => u.id}
          refreshControl={refresh}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          onEndReached={() => void more().catch(() => {})}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={error ? null : <EmptyState title={empty} />}
          renderItem={renderPerson}
        />
      )}
    </Screen>
  );
}

/** A person in the list, with Follow or Unfollow unless it's you. Memoised. */
const PersonRow = memo(function PersonRow({
  u,
  on,
  busy,
  self,
  onToggle,
}: {
  u: PublicUser;
  on: boolean;
  busy: boolean;
  self: boolean;
  onToggle: (u: PublicUser, on: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Row
      title={u.displayName}
      subtitle={`@${u.username}`}
      start={<Avatar name={u.displayName} url={u.avatarUrl} size={40} />}
      onPress={() => router.push(`/u/${encodeURIComponent(u.username)}`)}
      end={
        self ? null : (
          <View>
            <Button
              label={on ? t('profile.unfollow') : t('profile.follow')}
              variant={on ? 'secondary' : 'primary'}
              size="sm"
              disabled={busy}
              onPress={() => onToggle(u, on)}
            />
          </View>
        )
      }
    />
  );
});
