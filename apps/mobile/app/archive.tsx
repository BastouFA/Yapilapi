import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Image, Pressable, ScrollView, Text, View } from 'react-native';
import type { ArchivedStory } from '../../../packages/api-client/src/index';
import { client, errorMessage, mediaUrl } from '../lib/api';
import { AddToChapterSheet } from '../lib/chapters';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Button, EmptyState, Loading, Notice, useColors, userText } from '../lib/ui';

/**
 * Your archive: your stories after they expire, private to you. Browse by month, add a story to
 * a chapter, or delete it for good.
 */
export default function Archive() {
  const c = useColors();
  const { t, date } = useT();
  const { me } = useSession();
  const [months, setMonths] = useState<{ month: string; count: number }[] | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [items, setItems] = useState<ArchivedStory[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    client()
      .then((api) => api.archive.months())
      .then(
        (r) => {
          setMonths(r.items);
          setMonth(r.items[0]?.month ?? null);
        },
        (e) => {
          setMonths([]);
          setNote(errorMessage(e));
        },
      );
  }, [me]);

  const load = useCallback(() => {
    if (!month) return setItems([]);
    setItems(null);
    client()
      .then((api) => api.archive.list(month))
      .then(
        (r) => setItems(r.items),
        (e) => {
          setItems([]);
          setNote(errorMessage(e));
        },
      );
  }, [month]);
  useEffect(() => {
    if (months) load();
  }, [load, months]);

  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  if (months === null) return <Loading />;

  const monthName = (m: string) => date(`${m}-01T12:00:00Z`, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  function remove(s: ArchivedStory) {
    Alert.alert(t('m.archive.delete.title'), t('m.archive.delete.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await (await client()).archive.remove(s.id);
            setItems((cur) => cur?.filter((x) => x.id !== s.id) ?? null);
            setMonths((cur) => cur?.map((m) => (m.month === month ? { ...m, count: m.count - 1 } : m)).filter((m) => m.count > 0) ?? null);
          } catch (e) {
            setNote(errorMessage(e));
          }
        },
      },
    ]);
  }

  return (
    <>
      <FlatList
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3] }}
        columnWrapperStyle={{ gap: space[3] }}
        numColumns={2}
        data={items ?? []}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={
          <View style={{ gap: space[3] }}>
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.archive.hint')}</Text>
            <Button
              size="sm"
              variant="secondary"
              icon="film-outline"
              label={t('m.recap.title')}
              onPress={() => router.push('/recaps')}
              style={{ alignSelf: 'flex-start' }}
            />
            {note ? <Notice>{note}</Notice> : null}
            {months.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
                {months.map((m) => {
                  const on = m.month === month;
                  return (
                    <Pressable
                      key={m.month}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => setMonth(m.month)}
                      style={{
                        paddingHorizontal: space[3],
                        height: 36,
                        justifyContent: 'center',
                        borderRadius: radius.full,
                        borderWidth: 1,
                        borderColor: on ? c.yapi : c.line,
                        backgroundColor: on ? c.yapiSoft : c.surface,
                      }}
                    >
                      <Text style={{ color: c.ink, fontWeight: on ? '700' : '600' }}>
                        {monthName(m.month)} · {m.count}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
          </View>
        }
        ListEmptyComponent={items === null ? <Loading /> : <EmptyState title={t('m.archive.empty')} />}
        renderItem={({ item: s }) => {
          const src = s.mediaKind === 'image' ? s.mediaUrl : s.posterUrl;
          return (
            <View style={{ flex: 1, gap: space[1], maxWidth: '50%' }}>
              <View style={{ aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.yapi, justifyContent: 'center' }}>
                {src ? (
                  <Image
                    source={{ uri: mediaUrl(src) }}
                    blurRadius={s.sensitive ? 40 : 0}
                    style={{ flex: 1 }}
                    resizeMode="cover"
                    accessibilityLabel={s.body || undefined}
                  />
                ) : (
                  <Text style={[{ color: '#FFFFFF', fontWeight: '700', textAlign: 'center', padding: space[2] }, userText]} numberOfLines={6}>
                    {s.blocked ? t('m.media.unavailable') : s.body}
                  </Text>
                )}
              </View>
              <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={2}>
                {date(s.createdAt, { dateStyle: 'medium' })}
                {s.chapters.length ? ` · ${t('m.archive.inChapters', { titles: s.chapters.map((x) => x.title).join(', ') })}` : ''}
              </Text>
              {!s.blocked ? <Button size="sm" variant="secondary" label={t('m.chapters.add')} onPress={() => setAdding(s.id)} /> : null}
              <Button size="sm" variant="ghost" label={t('m.common.delete')} onPress={() => remove(s)} />
            </View>
          );
        }}
      />
      <AddToChapterSheet
        momentId={adding}
        onClose={() => setAdding(null)}
        onAdded={(message) => {
          setNote(message);
          load();
        }}
      />
    </>
  );
}
