import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { useI18n } from '../i18n';
import { useSearch, useDiscoverTopics, useSuggestedPeople } from '../data/social';
import { CommunityRow } from '../features/CommunityRow';
import { PostCard } from '../features/PostCard';
import { AppText, Avatar, EmptyView, ErrorView, LoadingView, Screen, TextField } from '../ui';

export default function Search() {
  const th = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setTerm(q), 400);
    return () => clearTimeout(id);
  }, [q]);
  const search = useSearch(term);
  const people = useSuggestedPeople();
  const topics = useDiscoverTopics();
  const searching = term.trim().length >= 2;
  const r = search.data?.results;

  return (
    <Screen padded={false}>
      <View style={{ padding: th.space[4] }}>
        <TextField
          label={t('search.placeholder')}
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCapitalize="none"
          returnKeyType="search"
          hint={!searching ? t('search.hint') : undefined}
        />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: th.space[10] }}
      >
        {!searching ? (
          <View style={{ paddingHorizontal: th.space[4], gap: th.space[4] }}>
            {topics.data?.items.length ? (
              <View>
                <AppText variant="heading" header>
                  {t('search.trending')}
                </AppText>
                <AppText variant="body" tone="muted" style={{ marginTop: th.space[2] }}>
                  {topics.data.items
                    .slice(0, 10)
                    .map((x) => `#${x.name}`)
                    .join('  ')}
                </AppText>
              </View>
            ) : null}
            {people.data?.items.length ? (
              <View>
                <AppText variant="heading" header style={{ marginBottom: th.space[2] }}>
                  {t('search.suggested')}
                </AppText>
                {people.data.items.map((p) => (
                  <Pressable
                    key={p.user.id}
                    accessibilityRole="button"
                    accessibilityLabel={t('a11y.openProfile', { name: p.user.displayName })}
                    onPress={() =>
                      router.push({
                        pathname: '/user/[username]',
                        params: { username: p.user.username },
                      })
                    }
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: th.space[3],
                      minHeight: th.targetMin + 12,
                    }}
                  >
                    <Avatar name={p.user.displayName} uri={p.user.avatarUrl} />
                    <View style={{ flex: 1 }}>
                      <AppText variant="bodyStrong" numberOfLines={1}>
                        {p.user.displayName}
                      </AppText>
                      <AppText
                        variant="caption"
                        tone="subtle"
                        numberOfLines={1}
                      >{`@${p.user.username}`}</AppText>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : search.isPending ? (
          <LoadingView />
        ) : search.isError ? (
          <ErrorView error={search.error} onRetry={() => void search.refetch()} />
        ) : search.data.total === 0 ? (
          <EmptyView message={t('search.empty', { query: term.trim() })} />
        ) : (
          <View>
            {r?.people?.items.length ? (
              <View style={{ paddingHorizontal: th.space[4] }}>
                <AppText variant="heading" header style={{ marginVertical: th.space[2] }}>
                  {t('search.people')}
                </AppText>
                {r.people.items.map((p) => (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    accessibilityLabel={t('a11y.openProfile', { name: p.displayName })}
                    onPress={() =>
                      router.push({
                        pathname: '/user/[username]',
                        params: { username: p.username },
                      })
                    }
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: th.space[3],
                      minHeight: th.targetMin + 12,
                    }}
                  >
                    <Avatar name={p.displayName} uri={p.avatarUrl} />
                    <View style={{ flex: 1 }}>
                      <AppText variant="bodyStrong" numberOfLines={1}>
                        {p.displayName}
                      </AppText>
                      <AppText
                        variant="caption"
                        tone="subtle"
                        numberOfLines={1}
                      >{`@${p.username}`}</AppText>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {r?.communities?.items.length ? (
              <View>
                <AppText variant="heading" header style={{ margin: th.space[4] }}>
                  {t('search.communities')}
                </AppText>
                {r.communities.items.map((c) => (
                  <CommunityRow key={c.id} community={c} />
                ))}
              </View>
            ) : null}
            {r?.posts?.items.length ? (
              <View>
                <AppText variant="heading" header style={{ margin: th.space[4] }}>
                  {t('search.posts')}
                </AppText>
                {r.posts.items.map((p) => (
                  <PostCard key={p.id} post={p} />
                ))}
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
