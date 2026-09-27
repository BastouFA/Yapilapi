import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, Text, View } from 'react-native';
import type { Post } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { PostCard } from '../lib/post';
import { SchedulePicker } from '../lib/post-edit';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, EmptyState, Loading, Notice, Screen, useColors } from '../lib/ui';

/**
 * Your drafts and scheduled posts, only ever seen by you. Scheduled posts come
 * first, soonest first. Continue a draft in Create, publish it now, schedule it,
 * move or cancel a scheduled post, or delete it.
 */
export default function Drafts() {
  const c = useColors();
  const { t, dateTime } = useT();
  const { me } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [timing, setTiming] = useState<Post | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).drafts.list()).items);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setNote({ tone: 'danger', text: errorMessage(e) });
    }
  }, []);
  // Back from Create (saved or published), the list is fresh.
  useFocusEffect(
    useCallback(() => {
      if (me) void load();
    }, [me, load]),
  );

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setNote(null);
    try {
      setNote({ tone: 'info', text: await fn() });
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  const replace = (post: Post) => setItems((cur) => cur?.map((x) => (x.id === post.id ? post : x)) ?? cur);
  const drop = (id: string) => setItems((cur) => cur?.filter((x) => x.id !== id) ?? cur);

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.common.signedOut')}</Notice>
      </Screen>
    );
  if (!items) return <Loading />;
  // Scheduled first, soonest first; then drafts, last saved first (as listed).
  const sorted = [
    ...items.filter((p) => p.status === 'scheduled').sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '')),
    ...items.filter((p) => p.status !== 'scheduled'),
  ];

  return (
    <>
      <FlatList
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
        data={sorted}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          <View style={{ gap: space[2] }}>
            <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('m.drafts.intro')}</Text>
            {note ? (
              <Notice tone={note.tone} key={note.text}>
                {note.text}
              </Notice>
            ) : null}
          </View>
        }
        ListEmptyComponent={<EmptyState title={t('m.drafts.empty')} />}
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
        renderItem={({ item: p }) => (
          <View style={{ gap: space[2] }}>
            <PostCard post={p} open={false} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              <Button
                label={t('m.drafts.continue')}
                size="sm"
                variant="secondary"
                disabled={!!busy}
                onPress={() => router.navigate({ pathname: '/create', params: { draft: p.id } })}
              />
              <Button
                label={t('m.drafts.publishNow')}
                size="sm"
                disabled={!!busy}
                onPress={() =>
                  void run(`publish-${p.id}`, async () => {
                    const r = await (await client()).drafts.publish(p.id);
                    drop(p.id);
                    return r.moderation ? r.moderation.message : t('m.drafts.published');
                  })
                }
              />
              <Button
                label={p.status === 'scheduled' ? t('m.drafts.changeTime') : t('m.create.schedule')}
                icon="calendar-outline"
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onPress={() => setTiming(p)}
              />
              {p.status === 'scheduled' ? (
                <Button
                  label={t('m.drafts.cancelSchedule')}
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onPress={() =>
                    void run(`cancel-${p.id}`, async () => {
                      replace((await (await client()).drafts.unschedule(p.id)).post);
                      return t('m.drafts.unscheduled');
                    })
                  }
                />
              ) : null}
              <Button
                label={t('m.common.delete')}
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onPress={() =>
                  Alert.alert(t('m.drafts.deleteConfirm'), undefined, [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('m.common.delete'),
                      style: 'destructive',
                      onPress: () =>
                        void run(`delete-${p.id}`, async () => {
                          await (await client()).drafts.remove(p.id);
                          drop(p.id);
                          return t('m.drafts.deleted');
                        }),
                    },
                  ])
                }
              />
            </View>
          </View>
        )}
      />
      <SchedulePicker
        visible={!!timing}
        value={timing?.scheduledAt ? new Date(timing.scheduledAt) : null}
        onClose={() => setTiming(null)}
        onPick={(at) => {
          const post = timing;
          setTiming(null);
          if (!post) return;
          void run(`schedule-${post.id}`, async () => {
            replace((await (await client()).drafts.schedule(post.id, at.toISOString())).post);
            return t('m.create.scheduled', { time: dateTime(at) });
          });
        }}
      />
    </>
  );
}
