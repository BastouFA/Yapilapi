import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Chapter, MemorySummary } from '../../../packages/api-client/src/index';
import type { Conversation, Recap } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from '../lib/api';
import { ChapterCover, useChapterMeta } from '../lib/chapters';
import { useT } from '../lib/i18n';
import { conversationTitle } from '../lib/post';
import { isMaking, isRecapsOff, RECAP_STATUS, recapError, recapRatio } from '../lib/recaps';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Card, EmptyState, Field, Icon, Loading, Notice, Row, Segmented, Title, useColors, useRefresh, userText } from '../lib/ui';

type Note = { tone: 'info' | 'danger'; text: string };

/**
 * Recap videos: short videos made from a memory, "On this day" or one of your chapters. Only
 * you see them. Lists yours (polling the ones still being made) and where to make a new one
 * from. Opening a ready recap plays it, with Save, Post as a reel, Send in a chat and Delete.
 * `?open=<recap id>` opens one straight away (after making one, or from a notification).
 */
export default function Recaps() {
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const params = useLocalSearchParams<{ open?: string }>();
  const focused = useIsFocused();
  const chapterMeta = useChapterMeta();
  const [items, setItems] = useState<Recap[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [off, setOff] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const fetching = useRef<string | null>(null);

  const load = useCallback(async () => {
    const api = await client();
    try {
      const r = await api.recaps.list();
      setItems(r.items);
      setRemaining(r.remainingToday);
      setOff(false);
    } catch (e) {
      setItems((cur) => cur ?? []);
      if (isRecapsOff(e)) {
        setOff(true);
        return;
      }
      setNote({ tone: 'danger', text: errorMessage(e) });
    }
    api.memories.list().then(
      (r) => setMemories(r.items),
      () => setMemories([]),
    );
    // Only your own chapters can be made into a recap.
    api.chapters.mine().then(
      (r) => setChapters(r.items.filter((x) => x.role === 'owner')),
      () => setChapters([]),
    );
  }, []);
  // Back from making one, the list is fresh.
  useFocusEffect(
    useCallback(() => {
      if (me) void load();
    }, [me, load]),
  );

  useEffect(() => {
    if (params.open) setOpenId(params.open);
  }, [params.open]);

  // A recap that isn't in the list (yet): fetch it on its own.
  useEffect(() => {
    if (!openId || !items || items.some((r) => r.id === openId) || fetching.current === openId) return;
    fetching.current = openId;
    client()
      .then((api) => api.recaps.get(openId))
      .then(
        ({ recap }) => setItems((cur) => (cur && !cur.some((x) => x.id === recap.id) ? [recap, ...cur] : cur)),
        (e) => {
          setOpenId(null);
          setNote({ tone: 'danger', text: isRecapsOff(e) ? t('m.recap.off') : t('m.recap.missing') });
        },
      )
      .finally(() => {
        fetching.current = null;
      });
  }, [openId, items, t]);

  // While any are being made, check on them every 2 seconds.
  const making = (items ?? [])
    .filter(isMaking)
    .map((r) => r.id)
    .join(',');
  useEffect(() => {
    if (!focused || !making) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const api = await client();
        const fresh = await Promise.all(
          making.split(',').map((id) =>
            api.recaps.get(id).then(
              (r) => r.recap,
              () => null,
            ),
          ),
        );
        if (!stopped) setItems((cur) => cur?.map((r) => fresh.find((f) => f?.id === r.id) ?? r) ?? cur);
      } catch {
        // Try again on the next tick.
      }
      if (!stopped) timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [focused, making]);

  const refresh = useRefresh(load);

  const close = () => {
    setOpenId(null);
    if (params.open) router.setParams({ open: '' });
  };

  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  if (!items) return <Loading />;

  const open = openId ? (items.find((r) => r.id === openId) ?? null) : null;
  const make = (source: Recap['source'], sourceId?: string) => router.push({ pathname: '/recap-new', params: sourceId ? { source, sourceId } : { source } });
  const chevron = <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />;
  const heading = (text: string) => (
    <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
      {text}
    </Text>
  );

  return (
    <>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        refreshControl={refresh}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
      >
        <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.recap.intro')}</Text>
        {note ? (
          <Notice tone={note.tone} key={note.text}>
            {note.text}
          </Notice>
        ) : null}
        {off ? (
          <Notice>{t('m.recap.off')}</Notice>
        ) : (
          <>
            {heading(t('m.recap.yours'))}
            {items.length ? (
              items.map((r) => <RecapRow key={r.id} recap={r} onPress={() => setOpenId(r.id)} />)
            ) : (
              <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.recap.empty')}</Text>
            )}

            <View style={{ height: space[2] }} />
            {heading(t('m.recap.makeFrom'))}
            {remaining !== null ? (
              <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{remaining > 0 ? tp('m.recap.remaining', remaining) : t('m.recap.noneLeft')}</Text>
            ) : null}
            <Row
              title={t('m.recap.onThisDay')}
              subtitle={t('m.recap.onThisDayHint')}
              start={<Icon name="calendar-outline" size={20} color={c.yapi} />}
              end={chevron}
              onPress={() => make('on_this_day')}
            />
            {memories.length ? (
              <>
                <Text style={{ color: c.ink, fontWeight: '700', marginTop: space[2] }}>{t('m.recap.memories')}</Text>
                {memories.map((m) => (
                  <Row
                    key={m.id}
                    title={m.title}
                    subtitle={tp('m.recap.itemCount', m.itemCount)}
                    start={<Icon name="images-outline" size={20} color={c.yapi} />}
                    end={chevron}
                    onPress={() => make('memory', m.id)}
                  />
                ))}
              </>
            ) : null}
            {chapters.length ? (
              <>
                <Text style={{ color: c.ink, fontWeight: '700', marginTop: space[2] }}>{t('m.recap.chapters')}</Text>
                {chapters.map((ch) => (
                  <Row
                    key={ch.id}
                    title={ch.title}
                    subtitle={chapterMeta(ch)}
                    start={<ChapterCover chapter={ch} size={40} />}
                    end={chevron}
                    onPress={() => make('chapter', ch.id)}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
      <Modal visible={!!open && focused} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
        {open ? (
          <RecapViewer
            key={open.id}
            recap={open}
            onClose={close}
            onDeleted={(fileRemoved) => {
              setItems((cur) => cur?.filter((x) => x.id !== open.id) ?? cur);
              close();
              setNote({ tone: 'info', text: fileRemoved ? t('m.recap.deleted') : t('m.recap.deletedKept') });
            }}
            onRemake={() => {
              close();
              make(open.source, open.sourceId ?? undefined);
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

function RecapRow({ recap: r, onPress }: { recap: Recap; onPress: () => void }) {
  const c = useColors();
  const { t, date } = useT();
  const poster = r.video?.posterUrl;
  const status = t(RECAP_STATUS[r.status]);
  return (
    <Card onPress={onPress} label={`${r.title}, ${status}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[3] }}>
      <View
        style={{
          width: 56,
          aspectRatio: r.aspect === '1:1' ? 1 : 9 / 16,
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: c.surfaceSunken,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {poster ? (
          <Image source={{ uri: mediaUrl(poster) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : (
          <Icon name="film-outline" size={22} color={c.inkMuted} />
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={2}>
          {r.title}
        </Text>
        <Text style={{ color: r.status === 'failed' ? c.danger : c.inkMuted, fontSize: 13 }}>
          {status} · {date(r.createdAt, { dateStyle: 'medium' })}
        </Text>
      </View>
      {isMaking(r) ? <ActivityIndicator color={c.yapi} /> : <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />}
    </Card>
  );
}

const AUDIENCES = ['public', 'followers', 'friends', 'private'] as const;
type Panel = 'post' | 'send' | null;

/** One recap: plays it once it's ready, with what you can do with it. */
function RecapViewer({
  recap: r,
  onClose,
  onDeleted,
  onRemake,
}: {
  recap: Recap;
  onClose: () => void;
  onDeleted: (fileRemoved: boolean) => void;
  onRemake: () => void;
}) {
  const c = useColors();
  const { t, date } = useT();
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [postedId, setPostedId] = useState<string | null>(null);
  const ready = r.status === 'ready' && !!r.video;

  async function save() {
    if (!r.video || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const file = await File.downloadFileAsync(mediaUrl(r.video.url), new File(Paths.cache, r.fileName), { idempotent: true });
      if (!(await Sharing.isAvailableAsync())) throw new Error(t('m.recap.saveFailed'));
      await Sharing.shareAsync(file.uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4', dialogTitle: t('m.recap.save') });
    } catch (e) {
      setNote({ tone: 'danger', text: e instanceof Error && e.message ? e.message : t('m.recap.saveFailed') });
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    Alert.alert(t('m.recap.delete.title'), t('m.recap.delete.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            const res = await (await client()).recaps.remove(r.id);
            onDeleted(res.fileRemoved);
          } catch (e) {
            setNote({ tone: 'danger', text: recapError(e, t) });
            setBusy(false);
          }
        },
      },
    ]);
  }

  const toggle = (p: Panel) => {
    setNote(null);
    setPanel((cur) => (cur === p ? null : p));
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[4], paddingBottom: space[2] }}>
        <View style={{ flex: 1 }}>
          <Title sub={`${t(RECAP_STATUS[r.status])} · ${date(r.createdAt, { dateStyle: 'medium' })}`}>{r.title}</Title>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={10} onPress={onClose}>
          <Icon name="close" size={26} color={c.ink} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingTop: space[2], gap: space[3], paddingBottom: Math.max(insets.bottom, space[4]) + space[4] }}
        keyboardShouldPersistTaps="handled"
      >
        {ready ? <RecapPlayer recap={r} /> : null}
        {isMaking(r) ? (
          <Card style={{ gap: space[3], alignItems: 'center' }}>
            <ActivityIndicator color={c.yapi} />
            <Text style={{ color: c.ink, lineHeight: 20, textAlign: 'center' }} accessibilityLiveRegion="polite">
              {t('m.recap.makingBody')}
            </Text>
          </Card>
        ) : null}
        {r.status === 'failed' ? (
          <>
            <Notice tone="danger">{r.error || t('m.recap.failedBody')}</Notice>
            <Button variant="secondary" icon="refresh" label={t('m.recap.tryAgain')} onPress={onRemake} style={{ alignSelf: 'flex-start' }} />
          </>
        ) : null}
        {ready && r.usedCount !== null && r.usedCount < r.itemCount ? <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.recap.leftOut')}</Text> : null}
        {note ? (
          <Notice tone={note.tone} key={note.text}>
            {note.text}
          </Notice>
        ) : null}
        {postedId ? (
          <Button
            size="sm"
            variant="secondary"
            label={t('m.recap.seePost')}
            onPress={() => {
              onClose();
              router.push(`/p/${postedId}`);
            }}
            style={{ alignSelf: 'flex-start' }}
          />
        ) : null}

        {ready ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button icon="download-outline" label={t('m.recap.save')} disabled={busy} onPress={() => save()} />
            {r.canPost ? <Button variant="secondary" icon="film-outline" label={t('m.recap.postReel')} disabled={busy} onPress={() => toggle('post')} /> : null}
            {r.canSend ? (
              <Button variant="secondary" icon="paper-plane-outline" label={t('m.recap.send')} disabled={busy} onPress={() => toggle('send')} />
            ) : null}
          </View>
        ) : null}
        {ready && busy && !panel ? <ActivityIndicator color={c.yapi} /> : null}
        {ready && !r.canPost ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.recap.cantPost')}</Text> : null}
        {ready && !r.canSend ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.recap.cantSend')}</Text> : null}

        {ready && panel === 'post' ? (
          <PostPanel
            recap={r}
            onPosted={(id, message) => {
              setPanel(null);
              setPostedId(id);
              setNote({ tone: 'info', text: message });
            }}
          />
        ) : null}
        {ready && panel === 'send' ? <SendPanel recap={r} onSent={(text) => setNote({ tone: 'info', text })} /> : null}

        <Button variant="ghost" label={t('m.common.delete')} disabled={busy} onPress={remove} style={{ alignSelf: 'flex-start' }} />
      </ScrollView>
    </View>
  );
}

function RecapPlayer({ recap: r }: { recap: Recap }) {
  const { width, height } = useWindowDimensions();
  const player = useVideoPlayer(mediaUrl(r.video!.url), (p) => {
    p.loop = true;
  });
  const ratio = recapRatio(r);
  // Fits the screen's width, and at most about 60% of its height.
  const w = Math.min(width - space[4] * 2, height * 0.6 * ratio);
  return (
    <View
      accessible
      accessibilityLabel={r.title}
      style={{ width: w, aspectRatio: ratio, alignSelf: 'center', borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' }}
    >
      <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls />
    </View>
  );
}

/** Post the recap as a reel through the normal post path: a caption and who can see it. */
function PostPanel({ recap: r, onPosted }: { recap: Recap; onPosted: (postId: string, message: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<(typeof AUDIENCES)[number]>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    const v = r.video;
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await (
        await client()
      ).posts.create({
        format: 'reel',
        body: body.trim(),
        visibility,
        media: [{ id: v.mediaId, url: v.url, kind: 'video' }],
        ...(r.sound ? { soundId: r.sound.id } : {}),
      });
      onPosted(res.post.id, res.moderation?.message ?? t('m.recap.posted'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800' }}>
        {t('m.recap.postReel')}
      </Text>
      <Field
        label={t('m.recap.caption')}
        value={body}
        onChangeText={setBody}
        multiline
        style={{ minHeight: 72, paddingTop: space[2], textAlignVertical: 'top' }}
      />
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('create.visibility')}</Text>
      <Segmented
        label={t('create.visibility')}
        options={AUDIENCES.map((id) => ({ id, label: t(`visibility.${id}`) }))}
        value={visibility}
        onChange={setVisibility}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button label={t('m.recap.post')} disabled={busy} onPress={() => post()} />
    </Card>
  );
}

/** Send the recap as a chat message to one of your conversations. */
function SendPanel({ recap: r, onSent }: { recap: Recap; onSent: (text: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client()
      .then((api) => api.conversations.list())
      .then(
        (res) => setChats(res.items),
        (e) => {
          setChats([]);
          setError(errorMessage(e));
        },
      );
  }, []);

  async function send(chat: Conversation) {
    const v = r.video;
    if (!v || busy) return;
    setBusy(chat.id);
    setError(null);
    try {
      const res = await (await client()).conversations.send(chat.id, '', undefined, [{ mediaId: v.mediaId }]);
      setSent((cur) => [...cur, chat.id]);
      onSent(res.notice ?? t('m.recap.sent', { name: conversationTitle(chat, me?.id, t) }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800' }}>
        {t('m.recap.chooseChat')}
      </Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {chats === null ? (
        <ActivityIndicator color={c.yapi} />
      ) : chats.length ? (
        chats.map((chat) => {
          const title = conversationTitle(chat, me?.id, t);
          const other = chat.members.find((m) => m.id !== me?.id);
          const done = sent.includes(chat.id);
          return (
            <View key={chat.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
              <Avatar name={title} url={chat.kind === 'direct' ? (other?.avatarUrl ?? null) : null} size={36} />
              <Text style={[{ flex: 1, color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                {title}
              </Text>
              {done ? (
                <Icon name="checkmark-circle" size={22} color={c.success} />
              ) : (
                <Button size="sm" label={t('inbox.send')} disabled={!!busy} onPress={() => send(chat)} />
              )}
            </View>
          );
        })
      ) : (
        <EmptyState title={t('m.recap.noChats')} />
      )}
    </Card>
  );
}
