import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import type { MemorySummary } from '../../../../packages/api-client/src/index';
import type { EventItem, Post } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { useT } from '../../lib/i18n';
import { RecapCta, useMemoryMeta } from '../../lib/memories';
import { PostCard } from '../../lib/post';
import { space } from '../../lib/theme';
import { Button, Card, EmptyState, ErrorState, Field, KeyboardAvoid, Loading, useColors, userText } from '../../lib/ui';

/**
 * Memories: your collections of posts, moments and events (private unless shared with friends),
 * and the ones friends shared with you. Make one, turn an event you went to into one, and see
 * "On this day" with a way to make a recap video of it. Behind the MEMORY flag.
 */
export default function Memories() {
  const c = useColors();
  const { t, dateTime } = useT();
  const on = useFlag('MEMORY');
  const meta = useMemoryMeta();
  const [items, setItems] = useState<MemorySummary[] | null>(null);
  const [sugg, setSugg] = useState<{ events: EventItem[]; onThisDay: Post[] } | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const api = await client();
    await Promise.all([
      api.memories.list().then(
        (r) => setItems(r.items),
        (e) => {
          setItems((cur) => cur ?? []);
          setError(errorMessage(e));
        },
      ),
      api.memories.suggestions().then(setSugg, () => {}),
    ]);
  }, []);

  // Again on coming back, so a renamed, deleted or newly shared memory shows as it is now.
  useFocusEffect(
    useCallback(() => {
      if (on) void load();
    }, [on, load]),
  );

  if (on === undefined) return <Loading />;
  if (!on)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.mem.off')} />
      </View>
    );

  async function create() {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { memory } = await (await client()).memories.create({ title: name });
      setTitle('');
      router.push(`/memories/${memory.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function fromEvent(eventId: string) {
    setError(null);
    try {
      const { memoryId } = await (await client()).memories.fromEvent(eventId);
      router.push(`/memories/${memoryId}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
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
      >
        <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('memories.intro')}</Text>
        {error ? <ErrorState message={error} onRetry={load} /> : null}

        <Card style={{ gap: space[3] }}>
          <Field
            label={t('memories.new')}
            placeholder={t('memories.newPlaceholder')}
            value={title}
            onChangeText={setTitle}
            maxLength={120}
            returnKeyType="done"
            onSubmitEditing={() => void create()}
          />
          <Button label={t('m.chapters.create')} disabled={!title.trim() || busy} onPress={() => create()} />
        </Card>

        {sugg?.events.length ? (
          <View style={{ gap: space[2] }}>
            <Heading>{t('memories.fromEvents')}</Heading>
            {sugg.events.map((ev) => (
              <Card key={ev.id} style={{ gap: space[2] }}>
                <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={2}>
                  {ev.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{dateTime(ev.startsAt)}</Text>
                <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
                  <Button label={t('memories.makeMemory')} icon="sparkles-outline" size="sm" variant="secondary" onPress={() => fromEvent(ev.id)} />
                  <Button label={t('m.mem.openEvent')} size="sm" variant="ghost" onPress={() => router.push(`/event/${ev.id}`)} />
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        <View style={{ gap: space[2] }}>
          <Heading>{t('m.recap.onThisDay')}</Heading>
          <RecapCta hint={t('memories.onThisDayHint')} onPress={() => router.push('/recap-new?source=on_this_day')} />
          {sugg?.onThisDay.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
        </View>

        <View style={{ gap: space[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
            <Heading>{t('m.recap.memories')}</Heading>
            <Button label={t('m.recap.yours')} size="sm" variant="ghost" icon="film-outline" onPress={() => router.push('/recaps')} />
          </View>
          {items === null ? (
            <Loading />
          ) : items.length ? (
            items.map((m) => (
              <Card key={m.id} onPress={() => router.push(`/memories/${m.id}`)} label={`${m.title}, ${meta(m)}`} style={{ gap: space[1] }}>
                <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]} numberOfLines={2}>
                  {m.title}
                </Text>
                {m.recap ? (
                  <Text style={[{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }, userText]} numberOfLines={2}>
                    {m.recap}
                  </Text>
                ) : null}
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{meta(m)}</Text>
              </Card>
            ))
          ) : (
            <EmptyState title={t('memories.emptyTitle')} body={t('memories.emptyBody')} />
          )}
        </View>
        <Text style={{ color: c.inkMuted, fontSize: 12, textAlign: 'center' }}>{t('memories.earlyAccess')}</Text>
      </ScrollView>
    </KeyboardAvoid>
  );
}

function Heading({ children }: { children: string }) {
  const c = useColors();
  return (
    <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800', flexShrink: 1 }}>
      {children}
    </Text>
  );
}
