import { useState } from 'react';
import { FlatList, Text } from 'react-native';
import { client } from '../lib/api';
import { Button, Field, Row, Screen, useColors } from '../lib/ui';

type Result = { key: string; title: string; subtitle: string };

/** Discover: universal search with natural-language intent. */
export default function Discover() {
  const c = useColors();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setError(null);
    try {
      const r = (await (await client()).search(q)).results as Record<string, any[]>;
      setResults([
        ...(r.people ?? []).map((u) => ({ key: `u${u.id}`, title: u.displayName, subtitle: `@${u.username}` })),
        ...(r.communities ?? []).map((x) => ({ key: `c${x.id}`, title: x.name, subtitle: `${x.memberCount} members` })),
        ...(r.events ?? []).map((e) => ({ key: `e${e.id}`, title: e.title, subtitle: new Date(e.startsAt).toLocaleString() })),
        ...(r.places ?? []).map((p) => ({ key: `p${p.id}`, title: p.name, subtitle: [p.category, p.city].filter(Boolean).join(' · ') })),
        ...(r.posts ?? []).map((p) => ({ key: `po${p.id}`, title: p.author.displayName, subtitle: p.body })),
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Screen>
      <Field label="Search" placeholder='Try "something to do tonight"' value={q} onChangeText={setQ} onSubmitEditing={search} returnKeyType="search" />
      <Button label="Search" onPress={search} disabled={!q.trim()} />
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <FlatList
        data={results ?? []}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{ gap: 8 }}
        renderItem={({ item }) => <Row title={item.title} subtitle={item.subtitle} />}
        ListEmptyComponent={results ? <Text style={{ color: c.inkMuted }}>No results.</Text> : undefined}
      />
    </Screen>
  );
}
