import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { YapilapiClient } from '../../../../packages/api-client/src/index';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { FriendPicker, useFriends } from '../../lib/friend-picker';
import { useT } from '../../lib/i18n';
import { RecapCta, useMemoryMeta } from '../../lib/memories';
import { PostCard } from '../../lib/post';
import { radius, space } from '../../lib/theme';
import { BottomSheet, Button, Card, EmptyState, Field, Icon, Loading, Notice, Row, ScreenError, useColors, userText } from '../../lib/ui';

type MemoryData = Awaited<ReturnType<YapilapiClient['memories']['get']>>;
type Note = { tone: 'info' | 'danger'; text: string };

/**
 * A memory: its recap (written by AI from the posts here you can see, only when you ask), a way
 * to make a recap video of it, and its events, moments and posts. The owner renames, shares with
 * friends, removes items and deletes it; people it was shared with can only look.
 */
export default function MemoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, dateTime } = useT();
  const meta = useMemoryMeta();
  const [data, setData] = useState<MemoryData | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone; a memory already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [recapping, setRecapping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await (await client()).memories.get(id));
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setData(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <Stack.Screen options={{ title: t('memories.title') }} />
        <EmptyState title={t('memories.notFound')} />
      </View>
    );
  const m = data.memory;

  async function writeRecap() {
    setRecapping(true);
    setNote(null);
    try {
      const r = await (await client()).memories.recap(id);
      setData((d) => (d ? { ...d, memory: { ...d.memory, recap: r.recap } } : d));
      // The only note on success is the development stand-in's mark: in the reader's language.
      if (r.notice) setNote({ tone: 'info', text: t('ai.devNotice') });
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setRecapping(false);
    }
  }

  function confirmDelete() {
    Alert.alert(t('m.mem.deleteTitle'), t('m.mem.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await (await client()).memories.remove(id);
            router.back();
          } catch (e) {
            setNote({ tone: 'danger', text: errorMessage(e) });
          }
        },
      },
    ]);
  }

  async function removeItem(type: 'post' | 'event' | 'moment', itemId: string) {
    setNote(null);
    try {
      await (await client()).memories.removeItem(id, type, itemId);
      await load();
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    }
  }

  const empty = !data.posts.length && !data.events.length && !data.moments.length;

  return (
    <>
      <Stack.Screen options={{ title: m.title }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
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
        <View style={{ gap: space[1] }}>
          <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>
            {m.title}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{meta(m)}</Text>
          {m.description ? <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{m.description}</Text> : null}
        </View>

        {m.mine ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              label={m.visibility === 'private' ? t('m.common.share') : t('memories.sharing')}
              icon="people-outline"
              size="sm"
              variant="secondary"
              onPress={() => setSharing(true)}
            />
            <Button label={t('m.mem.rename')} icon="create-outline" size="sm" variant="secondary" onPress={() => setRenaming(true)} />
            <Button label={t('m.common.delete')} icon="trash-outline" size="sm" variant="ghost" onPress={confirmDelete} />
          </View>
        ) : null}

        {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}

        {m.mine ? <RecapCta hint={t('memories.recapHint')} onPress={() => router.push(`/recap-new?source=memory&sourceId=${encodeURIComponent(id)}`)} /> : null}

        {m.recap || m.mine ? (
          <Card style={{ gap: space[2] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Icon name="sparkles-outline" size={18} color={c.yapi} />
              <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16, flex: 1 }}>
                {t('memories.recapTitle')}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '700' }}>{t('ai.label')}</Text>
            </View>
            {recapping ? (
              <ActivityIndicator color={c.yapi} accessibilityLabel={t('m.mem.writing')} style={{ alignSelf: 'flex-start' }} />
            ) : (
              <Text style={[{ color: m.recap ? c.ink : c.inkMuted, lineHeight: 21 }, userText]}>{m.recap ?? t('memories.recapNone')}</Text>
            )}
            <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 17 }}>{t('memories.recapNotice')}</Text>
            {m.mine ? (
              <Button
                label={m.recap ? t('memories.recapRewrite') : t('memories.recapWrite')}
                size="sm"
                variant="secondary"
                disabled={recapping}
                onPress={() => writeRecap()}
                style={{ alignSelf: 'flex-start' }}
              />
            ) : null}
          </Card>
        ) : null}

        {data.events.map((e) => (
          <View key={e.id} style={{ gap: space[1] }}>
            <Row
              title={e.title}
              subtitle={[dateTime(e.startsAt), e.place?.name ?? e.locationText].filter(Boolean).join(' · ')}
              start={<Icon name="calendar-outline" size={22} color={c.yapi} />}
              onPress={() => router.push(`/event/${e.id}`)}
            />
            {m.mine ? <RemoveLink onPress={() => void removeItem('event', e.id)} /> : null}
          </View>
        ))}

        {data.moments.map((mo) => (
          <Card key={mo.id} style={{ gap: space[2] }}>
            {mo.media_url && mo.media_kind === 'image' ? (
              <Image
                source={{ uri: mediaUrl(mo.media_url) }}
                accessibilityIgnoresInvertColors
                accessibilityLabel={mo.body || t('m.mem.moment')}
                style={{ width: '100%', aspectRatio: 4 / 5, borderRadius: radius.md }}
                resizeMode="cover"
              />
            ) : null}
            {mo.body ? <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{mo.body}</Text> : null}
            {m.mine ? <RemoveLink onPress={() => void removeItem('moment', mo.id)} /> : null}
          </Card>
        ))}

        {data.posts.map((p) => (
          <View key={p.id} style={{ gap: space[1] }}>
            <PostCard post={p} />
            {m.mine ? <RemoveLink onPress={() => void removeItem('post', p.id)} /> : null}
          </View>
        ))}

        {data.hiddenItems ? <Text style={{ color: c.inkMuted }}>{tp('memories.hiddenItems', data.hiddenItems)}</Text> : null}
        {empty ? <EmptyState title={t('m.feed.empty.title')} body={t('memories.emptyItems')} /> : null}
      </ScrollView>

      {renaming ? (
        <RenameSheet
          title={m.title}
          onClose={() => setRenaming(false)}
          onSaved={(title) => setData((d) => (d ? { ...d, memory: { ...d.memory, title } } : d))}
          id={id}
        />
      ) : null}
      {sharing ? (
        <ShareSheet
          id={id}
          sharedWith={m.sharedWith ?? []}
          onClose={() => setSharing(false)}
          onShared={(visibility, text) => {
            setData((d) => (d ? { ...d, memory: { ...d.memory, visibility: visibility as typeof m.visibility } } : d));
            setNote({ tone: 'info', text });
            // Again, so the sheet starts from the new list next time.
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function RemoveLink({ onPress }: { onPress: () => void }) {
  const { t } = useT();
  return <Button label={t('m.mem.removeItem')} icon="remove-circle-outline" size="sm" variant="ghost" onPress={onPress} style={{ alignSelf: 'flex-start' }} />;
}

function RenameSheet({ id, title, onClose, onSaved }: { id: string; title: string; onClose: () => void; onSaved: (title: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).memories.update(id, { title: name });
      onSaved(r.memory.title);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <BottomSheet visible title={t('m.mem.rename')} onClose={onClose}>
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Field label={t('m.mem.name')} value={value} onChangeText={setValue} maxLength={120} autoFocus returnKeyType="done" onSubmitEditing={() => void save()} />
      <Button label={t('common.save')} disabled={!value.trim() || busy} onPress={() => save()} />
    </BottomSheet>
  );
}

/**
 * Share with friends you pick, or keep private with nobody picked. Sharing replaces the list, so
 * the sheet starts from the friends it's shared with now and says so.
 */
function ShareSheet({
  id,
  sharedWith,
  onClose,
  onShared,
}: {
  id: string;
  sharedWith: string[];
  onClose: () => void;
  onShared: (visibility: string, text: string) => void;
}) {
  const c = useColors();
  const { t, tp } = useT();
  const friends = useFriends();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sharedWith));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function share() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).memories.share(id, [...picked]);
      onShared(r.visibility, r.visibility === 'private' ? t('memories.nowPrivate') : t('memories.nowShared'));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <BottomSheet visible title={t('memories.shareTitle')} onClose={onClose}>
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.mem.shareHint')}</Text>
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <FriendPicker friends={friends} picked={picked} onChange={setPicked} empty={t('memories.noFriends')} />
      <Button label={picked.size ? tp('memories.shareWith', picked.size) : t('memories.keepPrivate')} disabled={busy} onPress={() => share()} />
    </BottomSheet>
  );
}
