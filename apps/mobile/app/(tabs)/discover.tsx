import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { client, errorMessage } from '../../lib/api';
import { space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Field, Notice, Row, Screen, useColors, useTabBarSpace } from '../../lib/ui';

type Result = { key: string; title: string; subtitle: string; href?: string; avatar?: { name: string; url: string | null } };

/** Discover: universal search with natural-language intent. */
export default function Discover() {
  const c = useColors();
  const bottom = useTabBarSpace();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (!q.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const r = (await (await client()).search(q.trim())).results as Record<string, any[]>;
      setResults([
        ...(r.people ?? []).map((u) => ({
          key: `u${u.id}`,
          title: u.displayName,
          subtitle: `@${u.username}`,
          avatar: { name: u.displayName, url: u.avatarUrl },
        })),
        ...(r.communities ?? []).map((x) => ({ key: `c${x.id}`, title: x.name, subtitle: `${x.memberCount} members`, href: `/c/${x.slug}` })),
        ...(r.events ?? []).map((e) => ({ key: `e${e.id}`, title: e.title, subtitle: new Date(e.startsAt).toLocaleString() })),
        ...(r.places ?? []).map((p) => ({ key: `p${p.id}`, title: p.name, subtitle: [p.category, p.city].filter(Boolean).join(' · ') })),
        ...(r.posts ?? []).map((p) => ({ key: `po${p.id}`, title: p.author.displayName, subtitle: p.body, href: `/p/${p.id}` })),
      ]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field
            label="Search"
            hideLabel
            placeholder='Try "something to do tonight"'
            value={q}
            onChangeText={setQ}
            onSubmitEditing={search}
            returnKeyType="search"
            style={{ borderRadius: 9999, paddingHorizontal: space[4] }}
          />
        </View>
        <Button label={busy ? 'Searching…' : 'Search'} onPress={search} disabled={!q.trim() || busy} />
      </View>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <FlatList
        data={results ?? []}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{ gap: space[2], paddingBottom: bottom }}
        renderItem={({ item }) => (
          <Row
            title={item.title}
            subtitle={item.subtitle}
            start={item.avatar ? <Avatar name={item.avatar.name} url={item.avatar.url} size={36} /> : undefined}
            onPress={item.href ? () => router.push(item.href as never) : undefined}
          />
        )}
        ListEmptyComponent={
          results ? (
            <EmptyState title="No results" body="Try fewer words, or search for a person, a place or a community." />
          ) : (
            <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>Search people, communities, events, places and posts.</Text>
          )
        }
      />
    </Screen>
  );
}
