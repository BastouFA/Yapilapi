import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mixPlayMs, type MixDetail } from '../../../../packages/shared/src/mixes';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import {
  AddSongs,
  MIX_VISIBILITY_LABEL,
  MiniPlayer,
  MixEditor,
  MixMosaic,
  PostMixSheet,
  ShareToChatSheet,
  SongRow,
  useMixPlayer,
  useSongActions,
} from '../../lib/mixes';
import { useReport } from '../../lib/report';
import { useRealtime, useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Icon, Loading, Notice, useActionSheet, useColors, userText, type ActionSheetAction } from '../../lib/ui';

/**
 * A mix: its cover, name and who made it, its songs in order, and a mini player that plays each
 * song's allowed part one after another (only when you press play). The owner edits, shares into a
 * chat, shares as a post and deletes; people in a chat it's shared into add and reorder songs.
 */
export default function MixScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const [mix, setMix] = useState<MixDetail | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'edit' | 'chat' | 'post' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const menu = useActionSheet();
  const report = useReport();
  const player = useMixPlayer(mix?.songs ?? []);
  const songs = useSongActions(mix ?? null, setMix, setNote);

  const load = useCallback(async () => {
    try {
      setMix((await (await client()).mixes.get(id)).mix);
    } catch {
      setMix((cur) => cur ?? null);
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // Someone in a chat added or moved songs: load it again.
  useRealtime((e) => {
    if (e.type === 'mix.updated' && (e.data as { mixId?: string } | undefined)?.mixId === id) void load();
  });

  if (mix === undefined) return <Loading />;
  if (mix === null) return <EmptyState icon="list" title={t('mixes.missing.title')} body={t('mixes.missing.body')} />;
  const own = mix.role === 'owner';

  async function toggle(kind: 'like' | 'save') {
    if (!mix) return;
    try {
      const api = await client();
      if (kind === 'like') {
        const r = await api.mixes.like(mix.id, !mix.liked);
        setMix({ ...mix, liked: r.liked, likeCount: r.likeCount });
      } else {
        const r = await api.mixes.save(mix.id, !mix.saved);
        setMix({ ...mix, saved: r.saved });
        setNote(t(r.saved ? 'mixes.saved' : 'mixes.unsaved'));
      }
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  const actions: ActionSheetAction[] = [];
  if (own) {
    actions.push({ label: t('mixes.edit'), icon: 'create-outline', onPress: () => setSheet('edit') });
    if (mix.visibility !== 'private') actions.push({ label: t('mixes.share.title'), icon: 'chatbubble-outline', onPress: () => setSheet('chat') });
  }
  if (me && (mix.visibility === 'public' || (own && mix.visibility !== 'private')))
    actions.push({ label: t('mixes.post.title'), icon: 'repeat-outline', onPress: () => setSheet('post') });
  if (own)
    for (const ch of mix.chats)
      actions.push({
        label: t('mixes.unshare', { name: ch.title ?? t('mixes.share.chat') }),
        icon: 'close-outline',
        onPress: async () => {
          try {
            setMix((await (await client()).mixes.unshare(mix.id, ch.conversationId)).mix);
          } catch (e) {
            setNote(errorMessage(e));
          }
        },
      });
  if (!own && me)
    actions.push({
      label: t('mixes.report'),
      icon: 'flag-outline',
      destructive: true,
      onPress: () => report.open({ type: 'mix', id: mix.id, authorId: mix.owner.id, authorName: mix.owner.displayName }),
    });
  if (own)
    actions.push({
      label: t('mixes.delete'),
      icon: 'trash-outline',
      destructive: true,
      onPress: () =>
        Alert.alert(t('mixes.delete'), t('mixes.deleteConfirm', { title: mix.title }), [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('mixes.delete'),
            style: 'destructive',
            onPress: async () => {
              try {
                await (await client()).mixes.remove(mix.id);
                router.back();
              } catch (e) {
                setNote(errorMessage(e));
              }
            },
          },
        ]),
    });

  const minutes = Math.round(mixPlayMs(mix.songs) / 60_000);
  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <Stack.Screen options={{ title: mix.title }} />
      <ScrollView
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
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
      >
        <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
          <MixMosaic covers={mix.covers} size={104} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={{ color: c.inkMuted, fontSize: 12 }}>
              {t('mixes.card.kind')} · {t(MIX_VISIBILITY_LABEL[mix.visibility])}
            </Text>
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 22, fontWeight: '800' }, userText]}>
              {mix.title}
            </Text>
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push(`/u/${mix.owner.username}`)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
            >
              <Avatar name={mix.owner.displayName} url={mix.owner.avatarUrl} size={28} />
              <Text style={[{ color: c.ink, fontWeight: '600' }, userText]}>{mix.owner.displayName}</Text>
            </Pressable>
            <Text style={{ color: c.inkMuted, fontSize: 13 }}>
              {tp('mixes.songs', mix.songCount)}
              {minutes ? ` · ${t('mixes.minutes', { n: minutes })}` : ''}
              {mix.likeCount ? ` · ${tp('mixes.likes', mix.likeCount)}` : ''}
            </Text>
          </View>
        </View>
        {mix.chats.length ? (
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
            {t('mixes.sharedIn', { names: mix.chats.map((ch) => ch.title ?? t('mixes.share.chat')).join(', ') })}
          </Text>
        ) : null}
        {mix.description ? <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{mix.description}</Text> : null}
        {note ? <Notice>{note}</Notice> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], alignItems: 'center' }}>
          {mix.canAdd ? <AddSongs mix={mix} onMix={setMix} onNote={setNote} /> : null}
          {me ? (
            <>
              <Button
                label={t(mix.liked ? 'mixes.liked' : 'mixes.like')}
                icon={mix.liked ? 'heart' : 'heart-outline'}
                size="sm"
                variant="ghost"
                onPress={() => toggle('like')}
              />
              <Button
                label={t(mix.saved ? 'mixes.savedLabel' : 'mixes.save')}
                icon={mix.saved ? 'bookmark' : 'bookmark-outline'}
                size="sm"
                variant="ghost"
                onPress={() => toggle('save')}
              />
            </>
          ) : null}
          {actions.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('mixes.more')}
              onPress={() => menu.show({ title: mix.title, actions })}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="ellipsis-horizontal" size={22} color={c.ink} />
            </Pressable>
          ) : null}
        </View>
        {mix.songs.length ? (
          mix.songs.map((s, i) => (
            <SongRow key={s.id} mix={mix} song={s} index={i} player={player} onMove={(a, b) => void songs.move(a, b)} onRemove={(x) => void songs.remove(x)} />
          ))
        ) : (
          <EmptyState icon="musical-notes-outline" title={t('mixes.empty.title')} body={mix.canAdd ? t('mixes.empty.body') : undefined} />
        )}
      </ScrollView>
      <MiniPlayer player={player} songs={mix.songs} bottom={insets.bottom} />
      {own ? (
        <MixEditor
          visible={sheet === 'edit'}
          mix={mix}
          onClose={() => setSheet(null)}
          onSaved={(m) => {
            setMix(m);
            setSheet(null);
          }}
        />
      ) : null}
      {own ? (
        <ShareToChatSheet
          mix={mix}
          visible={sheet === 'chat'}
          onClose={() => setSheet(null)}
          onShared={(n) => {
            setNote(n);
            void load();
          }}
        />
      ) : null}
      <PostMixSheet mix={mix} visible={sheet === 'post'} onClose={() => setSheet(null)} onDone={setNote} />
      {menu.sheet}
      {report.sheet}
    </View>
  );
}
