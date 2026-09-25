import { useCallback, useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, RefreshControl, Text, View } from 'react-native';
import type { FeedMode } from '../../../../packages/shared/src/constants';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage, signIn } from '../../lib/api';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, Field, Loading, Notice, Segmented, useColors, useTabBarSpace } from '../../lib/ui';

const MODES = [
  { id: 'for_you', label: 'For you' },
  { id: 'following', label: 'Following' },
  { id: 'friends', label: 'Friends' },
] as const satisfies readonly { id: FeedMode; label: string }[];

/** Home: sign in if needed, then the feed with cursor pagination. */
export default function Home() {
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me) return <SignIn />;
  return <Feed />;
}

function Feed() {
  const c = useColors();
  const bottom = useTabBarSpace();
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>('for_you');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next?: string) => {
      try {
        const page = await (await client()).feed(mode, next);
        setPosts((cur) => (next && cur ? [...cur, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
        setPosts((cur) => cur ?? []);
      }
    },
    [mode],
  );

  useEffect(() => {
    setPosts(null);
    void load();
  }, [load]);

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}
      data={posts ?? []}
      keyExtractor={(p) => p.id}
      ListHeaderComponent={
        <View style={{ gap: space[3] }}>
          <Segmented label="Feed" options={MODES} value={mode} onChange={setMode} />
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </View>
      }
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
      onEndReached={() => cursor && load(cursor)}
      ListEmptyComponent={posts === null ? <Loading /> : <EmptyState title="Nothing here yet" body="Follow people and join communities to fill your feed." />}
      ListFooterComponent={
        posts?.length ? (
          <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>{cursor ? 'Loading…' : "You're all caught up."}</Text>
        ) : null
      }
      renderItem={({ item }) => <PostCard post={item} />}
    />
  );
}

function SignIn() {
  const c = useColors();
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: c.ground, justifyContent: 'center', padding: space[6] }}
    >
      <Card style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
          Log in
        </Text>
        <Text style={{ color: c.inkMuted }}>Your social world. One place.</Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label="Email address" autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Field label="Password" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} />
        <Button
          label={busy ? 'Logging in…' : 'Log in'}
          disabled={busy || !email || !password}
          onPress={async () => {
            setBusy(true);
            setError(null);
            try {
              await signIn(email.trim(), password);
              await refresh();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      </Card>
    </KeyboardAvoidingView>
  );
}
