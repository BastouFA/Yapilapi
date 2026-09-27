import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Avatar, Button, EmptyState, Loading, Notice, Row, Screen, Segmented } from '../lib/ui';

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

  useEffect(() => {
    let current = true;
    setItems(null);
    setError(null);
    void client()
      .then((api) => (kind === 'followers' ? api.users.followers(params.id) : api.users.following(params.id)))
      .then(
        (r) => {
          if (!current) return;
          setItems(r.items);
          setCursor(r.nextCursor);
          setFollows(new Set(r.viewerFollows));
        },
        (e) => current && (setItems([]), setError(errorMessage(e))),
      );
    return () => {
      current = false;
    };
  }, [kind, params.id]);

  const more = async () => {
    if (!cursor) return;
    const api = await client();
    const r = await (kind === 'followers' ? api.users.followers(params.id, cursor) : api.users.following(params.id, cursor));
    setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
    setCursor(r.nextCursor);
    setFollows((f) => new Set([...f, ...r.viewerFollows]));
  };

  const toggle = async (u: PublicUser) => {
    const on = follows.has(u.id);
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
  };

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
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(u) => u.id}
          contentContainerStyle={{ gap: space[2], paddingBottom: space[8] }}
          onEndReached={() => void more().catch(() => {})}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={<EmptyState title={empty} />}
          renderItem={({ item: u }) => {
            const on = follows.has(u.id);
            return (
              <Row
                title={u.displayName}
                subtitle={`@${u.username}`}
                start={<Avatar name={u.displayName} url={u.avatarUrl} size={40} />}
                onPress={() => router.push(`/u/${encodeURIComponent(u.username)}`)}
                end={
                  u.id === me?.id ? null : (
                    <View>
                      <Button
                        label={on ? t('profile.unfollow') : t('profile.follow')}
                        variant={on ? 'secondary' : 'primary'}
                        size="sm"
                        disabled={busy === u.id}
                        onPress={() => void toggle(u)}
                      />
                    </View>
                  )
                }
              />
            );
          }}
        />
      )}
    </Screen>
  );
}
