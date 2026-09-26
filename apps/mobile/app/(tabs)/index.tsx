import { Redirect, router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, Text, View } from 'react-native';
import type { StoryGroup } from '../../../../packages/api-client/src/index';
import type { FeedMode } from '../../../../packages/shared/src/constants';
import type { Post } from '../../../../packages/shared/src/types';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import { client, errorMessage, signIn } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { orderStories, StoriesStrip, StoryViewer } from '../../lib/stories';
import { useSession } from '../../lib/session';
import { StarterRow } from '../../lib/starter';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, Field, Icon, Loading, Notice, Segmented, useColors, useTabBarSpace } from '../../lib/ui';

const MODES = [
  { id: 'for_you', label: 'feed.for_you' },
  { id: 'following', label: 'feed.following' },
  { id: 'friends', label: 'feed.friends' },
] as const satisfies readonly { id: FeedMode; label: MessageKey }[];

/** Home: sign in if needed, then stories and the feed with cursor pagination. */
export default function Home() {
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me) return <SignIn />;
  // New accounts go through the three onboarding steps first, so Home starts full.
  if (!me.onboarded) return <Redirect href="/onboarding" />;
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
  const [stories, setStories] = useState<StoryGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.title.reels')}
          hitSlop={10}
          onPress={() => router.push('/reels')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginEnd: space[4] }}
        >
          <Icon name="film-outline" size={22} color={c.yapi} />
          <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 15 }}>{t('m.title.reels')}</Text>
        </Pressable>
      ),
    });
  }, [navigation, c.yapi, t]);

  const loadStories = useCallback(async () => {
    try {
      setStories(orderStories((await (await client()).moments.list()).items));
    } catch {
      // Stories are a bonus on Home: the feed still works without them.
    }
  }, []);
  // Refresh when coming back (after adding a story in Create, for example), not while one is open.
  useFocusEffect(
    useCallback(() => {
      if (viewing === null) void loadStories();
    }, [loadStories, viewing]),
  );

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

  // Just published from Create: put it at the top, as people expect to see what they posted.
  const { posted } = useLocalSearchParams<{ posted?: string }>();
  useEffect(() => {
    if (!posted) return;
    void (async () => {
      try {
        const { post } = await (await client()).posts.get(posted);
        setPosts((cur) => [post, ...(cur ?? []).filter((p) => p.id !== post.id)]);
      } catch {
        // Not visible (e.g. waiting for review): the feed stays as it is.
      }
    })();
  }, [posted]);

  return (
    <>
      <FlatList
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          <View style={{ gap: space[3] }}>
            <StoriesStrip groups={stories} onOpen={setViewing} onCreate={() => router.push({ pathname: '/camera', params: { mode: 'story' } })} />
            <StarterRow />
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
              await Promise.all([load(), loadStories()]);
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
      <StoryViewer groups={stories} start={viewing} onClose={() => setViewing(null)} onChange={setStories} />
    </>
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
