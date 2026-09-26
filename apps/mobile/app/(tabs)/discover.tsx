import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Field, Notice, Row, Screen, useColors, useTabBarSpace } from '../../lib/ui';

type Result = { key: string; title: string; subtitle: string; href?: string; avatar?: { name: string; url: string | null } };

/** Discover: universal search with natural-language intent. */
export default function Discover() {
  const c = useColors();
  const { t, tp, dateTime } = useT();
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
        ...(r.communities ?? []).map((x) => ({ key: `c${x.id}`, title: x.name, subtitle: tp('m.community.members', x.memberCount), href: `/c/${x.slug}` })),
        ...(r.events ?? []).map((e) => ({ key: `e${e.id}`, title: e.title, subtitle: dateTime(e.startsAt) })),
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
            label={t('m.discover.search')}
            hideLabel
            placeholder={t('m.discover.placeholder')}
            value={q}
            onChangeText={setQ}
            onSubmitEditing={search}
            returnKeyType="search"
            style={{ borderRadius: 9999, paddingHorizontal: space[4] }}
          />
        </View>
        <Button label={busy ? t('m.discover.searching') : t('m.discover.search')} onPress={search} disabled={!q.trim() || busy} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Button label={t('m.title.reels')} icon="film-outline" variant="secondary" size="sm" onPress={() => router.push('/reels')} />
        <Button label={t('m.title.assistant')} variant="secondary" size="sm" onPress={() => router.push('/assistant')} />
        <Button label={t('events.title')} variant="secondary" size="sm" onPress={() => router.push('/events')} />
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
            <EmptyState title={t('m.discover.noResults.title')} body={t('m.discover.noResults.body')} />
          ) : (
            <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>{t('m.discover.hint')}</Text>
          )
        }
      />
    </Screen>
  );
}
