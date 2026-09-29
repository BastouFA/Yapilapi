import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Loading, Notice, Row, Screen, Segmented, useRefresh } from '../lib/ui';

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
  // Private accounts asked from here (they answer first); tapping again takes the request back.
  const [requested, setRequested] = useState<Set<string>>(new Set());
  // Your own followers you removed just now.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
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
  const toggle = useCallback(
    async (u: PublicUser, on: boolean) => {
      setBusy(u.id);
      setError(null);
      try {
        const api = await client();
        const r = await (on ? api.users.unfollow(u.id) : api.users.follow(u.id));
        setFollows((f) => {
          const next = new Set(f);
          if (r.following) next.add(u.id);
          else next.delete(u.id);
          return next;
        });
        setRequested((q) => {
          const next = new Set(q);
          if (r.requested) next.add(u.id);
          else next.delete(u.id);
          return next;
        });
        setNote(r.requested ? t('profile.requestedToast', { name: u.displayName }) : null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );
  const remove = useCallback(
    async (u: PublicUser) => {
      setBusy(u.id);
      setError(null);
      try {
        await (await client()).users.removeFollower(u.id);
        setRemoved((r) => new Set(r).add(u.id));
        setNote(t('followers.removed', { name: u.displayName }));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );
  const meId = me?.id;
  const ownFollowers = self && kind === 'followers';
  const renderPerson = useCallback(
    ({ item: u }: { item: PublicUser }) => (
      <PersonRow
        u={u}
        on={follows.has(u.id)}
        asked={requested.has(u.id)}
        busy={busy === u.id}
        self={u.id === meId}
        onToggle={toggle}
        onRemove={ownFollowers ? remove : undefined}
      />
    ),
    [follows, requested, busy, meId, toggle, ownFollowers, remove],
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
      {note ? (
        <View accessibilityLiveRegion="polite">
          <Notice>{note}</Notice>
        </View>
      ) : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={ownFollowers ? items.filter((u) => !removed.has(u.id)) : items}
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
  asked,
  busy,
  self,
  onToggle,
  onRemove,
}: {
  u: PublicUser;
  on: boolean;
  /** You asked to follow their private account and they haven't answered. */
  asked: boolean;
  busy: boolean;
  self: boolean;
  onToggle: (u: PublicUser, on: boolean) => void;
  /** Your own followers list: take them off it. */
  onRemove?: (u: PublicUser) => void;
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
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button
              label={on ? t('profile.unfollow') : asked ? t('profile.requested') : t('profile.follow')}
              accessibilityLabel={asked && !on ? t('profile.withdrawRequest', { name: u.displayName }) : undefined}
              variant={on || asked ? 'secondary' : 'primary'}
              size="sm"
              disabled={busy}
              onPress={() => onToggle(u, on || asked)}
            />
            {onRemove ? (
              <Button
                label={t('followers.remove')}
                accessibilityLabel={t('followers.removeLabel', { name: u.displayName })}
                variant="ghost"
                size="sm"
                disabled={busy}
                onPress={() => onRemove(u)}
              />
            ) : null}
          </View>
        )
      }
    />
  );
});
