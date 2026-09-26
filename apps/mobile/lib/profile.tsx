import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import type { Post, Profile } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { PostCard, RichText } from './post';
import { space } from './theme';
import { Avatar, Button, Card, EmptyState, Loading, Notice, PlusBadge, useColors, userText } from './ui';

/**
 * A profile: name, bio, counts, Follow and Message for other people, and
 * their posts (pinned post first). `actions` adds your own buttons on your
 * profile.
 */
export function ProfileView({ username, actions, bottom = 0 }: { username: string; actions?: ReactNode; bottom?: number }) {
  const c = useColors();
  const { t, number } = useT();
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const api = await client();
    try {
      const p = (await api.users.get(username)).profile;
      setProfile(p);
      try {
        const page = await api.users.posts(username);
        setPosts(page.items);
        setCursor(page.nextCursor);
        setLocked(false);
      } catch {
        setPosts([]);
        setLocked(p.isPrivate && !p.relationship.isSelf);
      }
    } catch {
      setProfile(null);
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!cursor) return;
    const page = await (await client()).users.posts(username, cursor);
    setPosts((cur) => [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))]);
    setCursor(page.nextCursor);
  };

  if (profile === undefined) return <Loading />;
  if (profile === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.post.unavailable.title')} />
      </View>
    );

  const rel = profile.relationship;
  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <Card style={{ alignItems: 'center', gap: space[2], paddingVertical: space[6] }}>
        <Avatar name={profile.displayName} url={profile.avatarUrl} size={84} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Text style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>{profile.displayName}</Text>
          {profile.plus ? <PlusBadge /> : null}
        </View>
        <Text style={[{ color: c.inkMuted }, userText]}>
          @{profile.username}
          {rel.followedBy && !rel.isSelf ? ` · ${t('m.profile.followsYou')}` : ''}
        </Text>
        {profile.bio ? <RichText text={profile.bio} style={{ color: c.ink, fontSize: 15, lineHeight: 22, textAlign: 'center' }} /> : null}
        <View style={{ flexDirection: 'row', gap: space[4], marginTop: space[2] }}>
          {(
            [
              ['profile.posts', profile.counts.posts],
              ['profile.followers', profile.counts.followers],
              ['profile.following', profile.counts.following],
              ['profile.friends', profile.counts.friends],
            ] as const
          ).map(([key, n]) => (
            <View key={key} style={{ alignItems: 'center' }} accessible accessibilityLabel={t('m.common.stat', { label: t(key), count: n })}>
              <Text style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>{number(n)}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t(key)}</Text>
            </View>
          ))}
        </View>
        {!rel.isSelf ? (
          <View style={{ flexDirection: 'row', gap: space[2], marginTop: space[2] }}>
            <Button
              label={rel.following ? t('profile.unfollow') : t('profile.follow')}
              variant={rel.following ? 'secondary' : 'primary'}
              disabled={busy || rel.blocked}
              onPress={async () => {
                setBusy(true);
                setError(null);
                try {
                  const api = await client();
                  await (rel.following ? api.users.unfollow(profile.id) : api.users.follow(profile.id));
                  await load();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
            <Button
              label={t('profile.message')}
              variant="secondary"
              icon="chatbubble-outline"
              disabled={busy || rel.blocked}
              onPress={async () => {
                try {
                  const { conversation } = await (await client()).conversations.create([profile.id]);
                  router.push(`/chat/${conversation.id}`);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </View>
        ) : null}
      </Card>
      {actions}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom + space[4] }}
      data={posts}
      keyExtractor={(p) => p.id}
      ListHeaderComponent={header}
      renderItem={({ item }) => <PostCard post={item} />}
      onEndReached={() => void more()}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      ListEmptyComponent={<EmptyState title={locked ? t('m.profile.private') : t('m.profile.noPosts')} />}
    />
  );
}
