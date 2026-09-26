import { useCallback, useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, RefreshControl, Text, View } from 'react-native';
import type { FeedMode } from '../../../../packages/shared/src/constants';
import type { Post } from '../../../../packages/shared/src/types';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import { client, errorMessage, signIn } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, Field, Loading, Notice, Segmented, useColors, useTabBarSpace } from '../../lib/ui';

const MODES = [
  { id: 'for_you', label: 'feed.for_you' },
  { id: 'following', label: 'feed.following' },
  { id: 'friends', label: 'feed.friends' },
] as const satisfies readonly { id: FeedMode; label: MessageKey }[];

/** Home: sign in if needed, then the feed with cursor pagination. */
export default function Home() {
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me) return <SignIn />;
  return <Feed />;
}

function Feed() {
  const c = useColors();
  const { t } = useT();
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
          <Segmented label={t('m.feed.label')} options={MODES.map((m) => ({ id: m.id, label: t(m.label) }))} value={mode} onChange={setMode} />
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
      ListEmptyComponent={posts === null ? <Loading /> : <EmptyState title={t('m.feed.empty.title')} body={t('m.feed.empty.body')} />}
      ListFooterComponent={
        posts?.length ? (
          <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>{cursor ? t('m.common.loadingMore') : t('feed.end')}</Text>
        ) : null
      }
      renderItem={({ item }) => <PostCard post={item} />}
    />
  );
}

function SignIn() {
  const c = useColors();
  const { t } = useT();
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
          {t('auth.login.title')}
        </Text>
        <Text style={{ color: c.inkMuted }}>{t('app.tagline')}</Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label={t('auth.email')} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Field label={t('auth.password')} secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} />
        <Button
          label={busy ? t('m.auth.loggingIn') : t('auth.login.submit')}
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
