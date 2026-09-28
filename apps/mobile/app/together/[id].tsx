import { LinearGradient } from 'expo-linear-gradient';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { AccessibilityInfo, Alert, FlatList, Image, Platform, Pressable, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import { CHAPTER_AUDIENCES } from '../../../../packages/shared/src/constants';
import {
  momentDayLabel,
  momentGroups,
  peopleGroups,
  TOGETHER_DESCRIPTION_MAX,
  TOGETHER_POST_MAX,
  TOGETHER_TITLE_MAX,
  type TogetherDetail,
  type TogetherItem,
  type TogetherJoinRequest,
  type TogetherView,
  type TogetherWindow,
} from '../../../../packages/shared/src/together';
import { client, errorMessage, isGone, mediaUrl, webUrl } from '../../lib/api';
import { FriendPicker, useFriends } from '../../lib/friend-picker';
import { useT } from '../../lib/i18n';
import type { Picked } from '../../lib/media';
import { useRealtime, useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import {
  AddSheet,
  Slideshow,
  statusText,
  takeWithCamera,
  pickFromLibrary,
  thumbOf,
  Tile,
  useTileSize,
  Viewer,
  WindowPicker,
  windowClosesAt,
  type AlbumRow,
} from '../../lib/together';
import {
  Avatar,
  BottomSheet,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Loading,
  Notice,
  ScreenError,
  Segmented,
  SwitchRow,
  useActionSheet,
  useColors,
  userText,
  type ActionSheetAction,
} from '../../lib/ui';

type Sheet = 'invite' | 'people' | 'edit' | 'reopen' | 'post' | 'chapter' | null;

/**
 * A Together album: its cover and people, adding photos and videos (camera or library), the best
 * of, and three ways to look at it (Moments by time of day, People, Grid). Tap one for the
 * viewer; the slideshow shows it full screen for a TV. Hosts let people in, share the invite
 * link, change the album and close or reopen it. Only its people can open it.
 */
export default function TogetherScreen() {
  const { id, skipped } = useLocalSearchParams<{ id: string; skipped?: string }>();
  const c = useColors();
  const tr = useT();
  const { t, tp } = tr;
  const { me } = useSession();
  const menu = useActionSheet();
  const [album, setAlbum] = useState<TogetherDetail | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone or private; an album already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<TogetherView>('moments');
  const [open, setOpen] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [adding, setAdding] = useState<Picked[] | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [requests, setRequests] = useState<TogetherJoinRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const columns = view === 'grid' ? 4 : 3;
  const size = useTileSize(columns);
  const bestSize = 132;

  const load = useCallback(async () => {
    try {
      const api = await client();
      const r = await api.together.get(id);
      setAlbum(r.together);
      setLoadError(null);
      if (r.together.canManage && r.together.requestCount) setRequests((await api.together.requests(id)).items);
      else setRequests([]);
    } catch (e) {
      if (isGone(e)) setAlbum(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useRealtime((e) => {
    if (e.type === 'app.foreground') return void load();
    if (e.data?.togetherId !== id) return;
    if (e.type === 'together.items') {
      const before = album?.items.length ?? 0;
      void client()
        .then((api) => api.together.get(id))
        .then(
          (r) => {
            setAlbum(r.together);
            const more = r.together.items.length - before;
            if (more > 0 && !e.data?.removed) AccessibilityInfo.announceForAccessibility(tp('together.show.new', more));
          },
          () => {},
        );
    }
    if (e.type === 'together.item')
      void client()
        .then((api) => api.together.item(id, e.data.itemId))
        .then(
          (r) => setAlbum((a) => (a ? { ...a, items: a.items.map((x) => (x.id === r.item.id ? r.item : x)) } : a)),
          () => {},
        );
    if (e.type === 'together.updated' || e.type === 'together.requests') void load();
  });

  const rows = useMemo<AlbumRow[]>(() => {
    if (!album) return [];
    const out: AlbumRow[] = [];
    const chunk = (key: string, items: TogetherItem[]) => {
      for (let i = 0; i < items.length; i += columns) out.push({ type: 'tiles', key: `${key}-${i}`, items: items.slice(i, i + columns) });
    };
    if (view === 'moments') {
      const groups = momentGroups(album.items);
      for (const g of groups) {
        const first = g.items[0]!;
        const last = g.items.at(-1)!;
        const fmt = (iso: string) => tr.date(iso, { hour: 'numeric', minute: '2-digit' });
        const range = first === last ? fmt(first.takenAt) : `${fmt(first.takenAt)} – ${fmt(last.takenAt)}`;
        out.push({
          type: 'head',
          key: g.key,
          title: t(`together.part.${g.part}` as MessageKey, { day: momentDayLabel(g.day, tr.locale, groups) }),
          meta: `${range} · ${tp('together.items', g.items.length)}`,
        });
        chunk(g.key, g.items);
      }
    } else if (view === 'people') {
      for (const g of peopleGroups(album.items)) {
        out.push({ type: 'head', key: `p-${g.user.id}`, title: g.user.displayName, meta: tp('together.items', g.items.length), user: g.user });
        chunk(`p-${g.user.id}`, g.items);
      }
    } else chunk('grid', album.items);
    return out;
  }, [album, view, columns, t, tp, tr]);

  if (album === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (album === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <Stack.Screen options={{ title: t('together.title') }} />
        <EmptyState title={t('together.missing')} body={t('together.missingBody')} />
      </View>
    );
  const a = album;
  const api = () => client().then((x) => x.together);

  const confirm = (title: MessageKey, body: MessageKey, ok: MessageKey, destructive: boolean, run: () => Promise<void>) =>
    Alert.alert(t(title), t(body), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t(ok),
        style: destructive ? 'destructive' : 'default',
        onPress: () => void run().catch((e) => setError(errorMessage(e))),
      },
    ]);

  const actions: ActionSheetAction[] = [
    { label: t('together.members.title'), icon: 'people-outline', onPress: () => setSheet('people') },
    ...(a.canManage
      ? [
          { label: t('together.edit'), icon: 'create-outline' as const, onPress: () => setSheet('edit') },
          { label: t('together.invite'), icon: 'person-add-outline' as const, onPress: () => setSheet('invite') },
          a.status === 'open'
            ? {
                label: t('together.close'),
                icon: 'lock-closed-outline' as const,
                onPress: () =>
                  confirm('together.closeTitle', 'together.closeBody', 'together.close', false, async () =>
                    setAlbum((await (await api()).close(a.id)).together),
                  ),
              }
            : { label: t('together.reopen'), icon: 'lock-open-outline' as const, onPress: () => setSheet('reopen') },
        ]
      : []),
    ...(a.myRole !== 'host'
      ? [
          {
            label: t('together.leave'),
            icon: 'exit-outline' as const,
            destructive: true,
            onPress: () =>
              confirm('together.leaveTitle', 'together.leaveBody', 'together.leave', true, async () => {
                await (await api()).leave(a.id);
                router.back();
              }),
          },
        ]
      : []),
    ...(a.myRole === 'host'
      ? [
          {
            label: t('together.delete'),
            icon: 'trash-outline' as const,
            destructive: true,
            onPress: () =>
              confirm('together.deleteTitle', 'together.deleteBody', 'together.deleteConfirm', true, async () => {
                await (await api()).remove(a.id);
                router.back();
              }),
          },
        ]
      : []),
  ];

  async function add(from: 'library' | 'camera') {
    setError(null);
    const r = from === 'camera' ? await takeWithCamera() : await pickFromLibrary();
    if (r === 'denied') setError(from === 'camera' ? t('together.add.cameraDenied') : t('together.add.denied'));
    else if (r?.length) setAdding(r);
  }

  async function makeRecap() {
    setError(null);
    try {
      const r = await (await api()).recap(a.id);
      AccessibilityInfo.announceForAccessibility(t('together.after.recapStarted'));
      router.push(`/recaps?open=${encodeURIComponent(r.recap.id)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const best = a.bestOf.map((bid) => a.items.find((i) => i.id === bid)).filter((i): i is TogetherItem => !!i);
  const hero = a.cover?.url ?? a.cover?.thumbUrl ?? null;

  const header = (
    <View style={{ gap: space[4], paddingBottom: space[3] }}>
      <View style={{ height: 240, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#2A1A2E' }}>
        {hero ? (
          <Image source={{ uri: mediaUrl(hero) }} style={{ position: 'absolute', width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
        ) : null}
        <LinearGradient
          colors={hero ? ['rgba(8,9,16,0.15)', 'rgba(8,9,16,0.85)'] : ['#D21D4A', '#2A1A2E']}
          start={{ x: 0, y: 0 }}
          end={{ x: hero ? 0 : 1, y: 1 }}
          style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 }}
        />
        <View style={{ flex: 1, justifyContent: 'flex-end', padding: space[4], gap: space[2] }}>
          <View
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: 'rgba(0,0,0,0.5)',
              borderRadius: radius.full,
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            {a.status === 'open' ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#5FF0C9' }} /> : null}
            <Text style={{ color: '#FFFFFF', fontSize: 13 }}>{statusText(a, tr)}</Text>
          </View>
          <Text accessibilityRole="header" style={[{ color: '#FFFFFF', fontSize: 28, fontWeight: '800', letterSpacing: -0.4 }, userText]}>
            {a.title}
          </Text>
          {a.description ? <Text style={[{ color: '#EEF0FA', lineHeight: 20 }, userText]}>{a.description}</Text> : null}
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${tp('together.people', a.memberCount)}, ${tp('together.items', a.items.length)}`}
        onPress={() => setSheet('people')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
      >
        <View style={{ flexDirection: 'row' }}>
          {a.members.slice(0, 5).map((m, i) => (
            <View key={m.user.id} style={{ marginStart: i ? -10 : 0, borderRadius: 16, borderWidth: 2, borderColor: c.ground }}>
              <Avatar name={m.user.displayName} url={m.user.avatarUrl} size={28} />
            </View>
          ))}
        </View>
        <Text style={{ color: c.inkMuted, flex: 1 }}>
          {tp('together.people', a.memberCount)} · {tp('together.items', a.items.length)}
        </Text>
        <Icon name="chevron-forward" size={16} color={c.inkMuted} directional />
      </Pressable>
      {a.event ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(`/event/${a.event!.id}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
        >
          <Icon name="calendar-outline" size={18} color={c.yapi} />
          <Text style={[{ color: c.yapi, fontWeight: '700' }, userText]}>{t('together.event', { title: a.event.title })}</Text>
        </Pressable>
      ) : null}

      {skipped ? <Notice>{tp('together.create.skipped', Number(skipped) || 0)}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {a.canAdd ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          <Button label={t('together.add.library')} icon="images-outline" onPress={() => add('library')} />
          <Button label={t('together.add.camera')} icon="camera-outline" variant="secondary" onPress={() => add('camera')} />
        </View>
      ) : (
        <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('together.add.closed')}</Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {a.items.length ? <Button label={t('together.slideshow')} icon="play-outline" variant="secondary" size="sm" onPress={() => setShow(true)} /> : null}
        {a.canManage ? (
          <Button label={t('together.invite')} icon="person-add-outline" variant="secondary" size="sm" onPress={() => setSheet('invite')} />
        ) : null}
      </View>

      {a.canManage && requests.length ? (
        <Card style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
            {t('together.requests.title')}
          </Text>
          {requests.map((r) => (
            <View key={r.user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' }}>
              <Avatar name={r.user.displayName} url={r.user.avatarUrl} size={36} />
              <View style={{ flex: 1, minWidth: 120 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                  {r.user.displayName}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                  @{r.user.username}
                  {r.friend ? ` · ${t('together.requests.friend')}` : ''}
                </Text>
              </View>
              <Button
                label={t('together.requests.approve')}
                size="sm"
                onPress={async () => {
                  try {
                    await (await api()).decide(a.id, r.user.id, true);
                    await load();
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              />
              <Button
                label={t('together.requests.decline')}
                size="sm"
                variant="secondary"
                onPress={async () => {
                  try {
                    await (await api()).decide(a.id, r.user.id, false);
                    await load();
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              />
            </View>
          ))}
        </Card>
      ) : null}

      {a.status === 'closed' && a.items.length ? (
        <Card style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
            {t('together.after.title')}
          </Text>
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('together.after.body')}</Text>
          <LookBack icon="film-outline" title={t('together.after.recap')} hint={t('together.after.recapHint')} onPress={() => makeRecap()} />
          <LookBack
            icon="create-outline"
            title={t('together.after.post')}
            hint={t('together.after.postHint', { count: TOGETHER_POST_MAX })}
            onPress={() => setSheet('post')}
          />
          <LookBack icon="bookmark-outline" title={t('together.after.chapter')} hint={t('together.after.chapterHint')} onPress={() => setSheet('chapter')} />
        </Card>
      ) : null}

      {a.items.length ? (
        <View style={{ gap: space[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Icon name="star" size={18} color={c.saffron} />
            <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
              {t('together.best.title')}
            </Text>
          </View>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{best.length ? t('together.best.hint') : t('together.best.empty')}</Text>
          {best.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
              {best.map((it) => (
                <Tile key={it.id} item={it} size={bestSize} onPress={() => setOpen(it.id)} />
              ))}
            </ScrollView>
          ) : null}
          <Segmented<TogetherView>
            label={t('together.view.label')}
            value={view}
            onChange={setView}
            options={[
              { id: 'moments', label: t('together.view.moments') },
              { id: 'people', label: t('together.view.people') },
              { id: 'grid', label: t('together.view.grid') },
            ]}
          />
        </View>
      ) : (
        <EmptyState title={t('together.noItems')} body={a.canAdd ? t('together.noItemsBody') : t('together.noItemsClosed')} />
      )}
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: a.title,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('together.options')}
              hitSlop={10}
              onPress={() => menu.show({ title: a.title, actions })}
              style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="ellipsis-horizontal" size={22} color={c.ink} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], paddingBottom: space[8] }}
        data={rows}
        keyExtractor={(r) => r.key}
        ListHeaderComponent={header}
        initialNumToRender={12}
        windowSize={7}
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
        renderItem={({ item: row }) =>
          row.type === 'head' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingTop: space[4], paddingBottom: space[2] }}>
              {row.user ? (
                <Avatar name={row.user.displayName} url={row.user.avatarUrl} size={28} />
              ) : (
                <View style={{ width: 3, height: 32, borderRadius: 2, backgroundColor: c.yapi }} />
              )}
              <View style={{ flex: 1 }}>
                <Text accessibilityRole="header" style={[{ color: c.ink, fontWeight: '800', fontSize: 16 }, userText]}>
                  {row.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{row.meta}</Text>
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 4, marginBottom: 4 }}>
              {row.items.map((it) => (
                <Tile key={it.id} item={it} size={size} onPress={() => setOpen(it.id)} />
              ))}
            </View>
          )
        }
      />
      {menu.sheet}
      {open ? (
        <Viewer
          album={a}
          items={a.items}
          startId={open}
          onClose={() => setOpen(null)}
          onItem={(item) => setAlbum((x) => (x ? { ...x, items: x.items.map((i) => (i.id === item.id ? item : i)) } : x))}
          onRemoved={(rid) => {
            setOpen(null);
            setAlbum((x) => (x ? { ...x, items: x.items.filter((i) => i.id !== rid) } : x));
          }}
        />
      ) : null}
      {show ? <Slideshow album={a} onClose={() => setShow(false)} /> : null}
      {adding ? <AddSheet album={a} assets={adding} onClose={() => setAdding(null)} onAdded={() => void load()} /> : null}
      <InviteSheet album={a} visible={sheet === 'invite'} onClose={() => setSheet(null)} onChanged={load} />
      <PeopleSheet album={a} visible={sheet === 'people'} meId={me?.id} onClose={() => setSheet(null)} onChanged={setAlbum} />
      <EditSheet album={a} visible={sheet === 'edit'} onClose={() => setSheet(null)} onSaved={setAlbum} />
      <ReopenSheet album={a} visible={sheet === 'reopen'} onClose={() => setSheet(null)} onSaved={setAlbum} />
      <PostSheet album={a} visible={sheet === 'post'} onClose={() => setSheet(null)} />
      <ChapterSheet album={a} visible={sheet === 'chapter'} onClose={() => setSheet(null)} />
    </>
  );
}

function LookBack({
  icon,
  title,
  hint,
  onPress,
}: {
  icon: 'film-outline' | 'create-outline' | 'bookmark-outline';
  title: string;
  hint: string;
  onPress: () => unknown;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      onPress={() => void onPress()}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 56,
        padding: space[3],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.line : c.surfaceSunken,
      })}
    >
      <Icon name={icon} size={22} color={c.yapi} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.ink, fontWeight: '700' }}>{title}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text>
      </View>
      <Icon name="chevron-forward" size={16} color={c.inkMuted} directional />
    </Pressable>
  );
}

/** Hosts: the invite link, to share (guests ask to join; a host lets each one in). */
function InviteSheet({ album, visible, onClose, onChanged }: { album: TogetherDetail; visible: boolean; onClose: () => void; onChanged: () => unknown }) {
  const c = useColors();
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const invite = album.invite;
  const url = invite?.code ? `${webUrl}/together/join/${invite.code}` : null;
  const set = async (enabled: boolean, reset = false) => {
    setError(null);
    try {
      await (await client()).together.setInvite(album.id, enabled, reset);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <BottomSheet visible={visible} title={t('together.inviteSheet.title')} onClose={onClose}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <SwitchRow label={t('together.inviteSheet.on')} hint={t('together.inviteSheet.hint')} value={!!invite?.enabled} onValueChange={(v) => void set(v)} />
      {invite?.enabled && url ? (
        <View style={{ gap: space[2] }}>
          <Text selectable style={{ color: c.inkMuted, fontSize: 13 }}>
            {url}
          </Text>
          <Button
            label={t('together.inviteSheet.share')}
            icon="share-outline"
            onPress={() => Share.share(Platform.OS === 'ios' ? { url, message: album.title } : { message: `${album.title}\n${url}`, title: album.title })}
          />
          <Button label={t('together.inviteSheet.reset')} variant="secondary" onPress={() => set(true, true)} />
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('together.inviteSheet.resetHint')}</Text>
        </View>
      ) : null}
    </BottomSheet>
  );
}

/** Everyone in it; hosts add friends or everyone from the chat or event, choose co-hosts and take people out. */
function PeopleSheet({
  album,
  visible,
  meId,
  onClose,
  onChanged,
}: {
  album: TogetherDetail;
  visible: boolean;
  meId?: string;
  onClose: () => void;
  onChanged: (a: TogetherDetail) => void;
}) {
  const c = useColors();
  const { t, tp } = useT();
  const friends = useFriends();
  const menu = useActionSheet();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inIt = new Set(album.members.map((m) => m.user.id));
  const run = async (p: Promise<{ together: TogetherDetail; added?: number; skipped?: number }>) => {
    setError(null);
    try {
      const r = await p;
      onChanged(r.together);
      if (r.added !== undefined)
        setNote([tp('together.members.added', r.added), r.skipped ? tp('together.create.skipped', r.skipped) : ''].filter(Boolean).join(' '));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const api = () => client().then((x) => x.together);
  return (
    <BottomSheet visible={visible} title={t('together.members.title')} onClose={onClose}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {note ? <Notice>{note}</Notice> : null}
      {album.members.map((m) => {
        const actions: ActionSheetAction[] = [];
        if (album.myRole === 'host' && m.role !== 'host')
          actions.push({
            label: m.role === 'cohost' ? t('together.members.makeMember') : t('together.members.makeCohost'),
            icon: 'person-outline',
            onPress: () => void run(api().then((x) => x.setRole(album.id, m.user.id, m.role === 'cohost' ? 'member' : 'cohost'))),
          });
        if (album.canManage && m.user.id !== meId && m.role !== 'host' && (album.myRole === 'host' || m.role === 'member'))
          actions.push({
            label: t('together.members.remove'),
            icon: 'person-remove-outline',
            destructive: true,
            onPress: () => void run(api().then((x) => x.removeMember(album.id, m.user.id))),
          });
        return (
          <Pressable
            key={m.user.id}
            accessibilityRole={actions.length ? 'button' : 'text'}
            accessibilityLabel={`${m.user.displayName}, ${t(`together.role.${m.role}` as MessageKey)}, ${tp('together.items', m.items)}`}
            disabled={!actions.length}
            onPress={() => menu.show({ title: t('together.members.options', { name: m.user.displayName }), actions })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 52 }}
          >
            <Avatar name={m.user.displayName} url={m.user.avatarUrl} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                {m.user.displayName}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>
                {t(`together.role.${m.role}` as MessageKey)} · {tp('together.items', m.items)}
              </Text>
            </View>
            {actions.length ? <Icon name="ellipsis-horizontal" size={18} color={c.inkMuted} /> : null}
          </Pressable>
        );
      })}
      {album.canManage ? (
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 15, marginTop: space[2] }}>
            {t('together.members.add')}
          </Text>
          <FriendPicker
            friends={friends ? friends.filter((f) => !inIt.has(f.id)) : null}
            picked={picked}
            onChange={setPicked}
            empty={t('together.who.noFriends')}
          />
          <Button
            label={t('together.members.addPicked')}
            disabled={!picked.size}
            onPress={async () => {
              await run(api().then((x) => x.addMembers(album.id, { userIds: [...picked] })));
              setPicked(new Set());
            }}
          />
          {album.conversationId ? (
            <Button
              label={t('together.members.fromChat')}
              variant="secondary"
              onPress={() => run(api().then((x) => x.addMembers(album.id, { fromChat: true })))}
            />
          ) : null}
          {album.eventId ? (
            <Button
              label={t('together.members.fromEvent')}
              variant="secondary"
              onPress={() => run(api().then((x) => x.addMembers(album.id, { fromEvent: true })))}
            />
          ) : null}
        </View>
      ) : null}
      {menu.sheet}
    </BottomSheet>
  );
}

/** Hosts: rename, describe, choose the cover from its photos and change when it closes. */
function EditSheet({
  album,
  visible,
  onClose,
  onSaved,
}: {
  album: TogetherDetail;
  visible: boolean;
  onClose: () => void;
  onSaved: (a: TogetherDetail) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [title, setTitle] = useState(album.title);
  const [description, setDescription] = useState(album.description);
  const [coverId, setCoverId] = useState<string | null>(null);
  const [changeEnd, setChangeEnd] = useState(false);
  const [win, setWin] = useState<TogetherWindow>('day');
  const [custom, setCustom] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closesAt = windowClosesAt(win, custom);
  const photos = album.items.filter((i) => !i.media.sensitive).slice(-40);
  return (
    <BottomSheet
      visible={visible}
      title={t('together.edit')}
      onClose={onClose}
      onDismiss={() => {
        setTitle(album.title);
        setDescription(album.description);
        setCoverId(null);
        setChangeEnd(false);
      }}
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field label={t('together.create.name')} value={title} onChangeText={setTitle} maxLength={TOGETHER_TITLE_MAX} />
      <Field label={t('together.create.description')} value={description} onChangeText={setDescription} maxLength={TOGETHER_DESCRIPTION_MAX} multiline />
      {photos.length ? (
        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('together.create.cover')}</Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {photos.map((p) => {
              const on = coverId === p.id;
              const src = thumbOf(p);
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={t(p.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', { name: p.author.displayName, time: '' })}
                  onPress={() => setCoverId(p.id)}
                  style={{ width: 64, height: 64, borderRadius: radius.sm, overflow: 'hidden', borderWidth: 3, borderColor: on ? c.yapi : 'transparent' }}
                >
                  {src ? <Image source={{ uri: src }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      {album.status === 'open' ? (
        <>
          <SwitchRow label={t('together.edit.changeEnd')} value={changeEnd} onValueChange={setChangeEnd} />
          {changeEnd ? <WindowPicker value={win} custom={custom} onChange={(w, d) => (setWin(w), setCustom(d))} /> : null}
        </>
      ) : null}
      <Button
        label={t('common.save')}
        disabled={!title.trim() || (changeEnd && closesAt === undefined)}
        onPress={async () => {
          setError(null);
          try {
            const r = await (
              await client()
            ).together.update(album.id, {
              title: title.trim(),
              description: description.trim(),
              ...(coverId ? { coverItemId: coverId } : {}),
              ...(changeEnd && closesAt !== undefined ? { closesAt } : {}),
            });
            onSaved(r.together);
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}

function ReopenSheet({
  album,
  visible,
  onClose,
  onSaved,
}: {
  album: TogetherDetail;
  visible: boolean;
  onClose: () => void;
  onSaved: (a: TogetherDetail) => void;
}) {
  const { t } = useT();
  const [win, setWin] = useState<TogetherWindow>('day');
  const [custom, setCustom] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closesAt = windowClosesAt(win, custom);
  return (
    <BottomSheet visible={visible} title={t('together.reopenTitle')} onClose={onClose}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <WindowPicker value={win} custom={custom} onChange={(w, d) => (setWin(w), setCustom(d))} />
      <Button
        label={t('together.reopen')}
        disabled={closesAt === undefined}
        onPress={async () => {
          if (closesAt === undefined) return;
          try {
            onSaved((await (await client()).together.reopen(album.id, closesAt)).together);
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}

/** Your own photos from it as one post (up to the carousel limit), the best of yours chosen first. */
function PostSheet({ album, visible, onClose }: { album: TogetherDetail; visible: boolean; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const mine = useMemo(() => album.items.filter((i) => i.mine && !i.media.processing), [album.items]);
  const initial = useMemo(() => {
    const best = mine.filter((i) => i.best).map((i) => i.id);
    return (best.length ? best : mine.map((i) => i.id)).slice(0, TOGETHER_POST_MAX);
  }, [mine]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'friends' | 'followers' | 'public'>('friends');
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const chosen = picked ?? initial;
  return (
    <BottomSheet
      visible={visible}
      title={t('together.post.title')}
      onClose={onClose}
      onDismiss={() => {
        setPicked(null);
        setCaption(null);
        setMsg(null);
      }}
    >
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {mine.length ? (
        <>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('together.post.pick', { count: TOGETHER_POST_MAX })}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {mine.map((p) => {
              const on = chosen.includes(p.id);
              const src = thumbOf(p);
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: !on && chosen.length >= TOGETHER_POST_MAX }}
                  accessibilityLabel={
                    p.caption || t(p.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', { name: p.author.displayName, time: '' })
                  }
                  disabled={!on && chosen.length >= TOGETHER_POST_MAX}
                  onPress={() => setPicked(on ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])}
                  style={{ width: 64, height: 64, borderRadius: radius.sm, overflow: 'hidden', borderWidth: 3, borderColor: on ? c.yapi : 'transparent' }}
                >
                  {src ? <Image source={{ uri: src }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors /> : null}
                </Pressable>
              );
            })}
          </View>
          <Field label={t('together.post.caption')} value={caption ?? album.title} onChangeText={setCaption} maxLength={2200} multiline />
          <Segmented
            label={t('m.chapters.audience')}
            value={visibility}
            onChange={setVisibility}
            options={(['friends', 'followers', 'public'] as const).map((v) => ({ id: v, label: t(`visibility.${v}` as MessageKey) }))}
          />
          <Button
            label={t('together.post.submit')}
            disabled={!chosen.length}
            onPress={async () => {
              setMsg(null);
              try {
                const items = mine.filter((i) => chosen.includes(i.id));
                const r = await (
                  await client()
                ).posts.create({
                  body: (caption ?? album.title).trim(),
                  visibility,
                  media: items.map((i) => ({ id: i.media.id, url: mediaUrl(i.media.url), kind: i.media.kind })),
                });
                setMsg({ tone: 'info', text: r.moderation ? r.moderation.message : t('together.post.done') });
              } catch (e) {
                setMsg({ tone: 'danger', text: errorMessage(e) });
              }
            }}
          />
        </>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('together.after.noneOwn')}</Text>
      )}
    </BottomSheet>
  );
}

/** A chapter of your own photos from it. */
function ChapterSheet({ album, visible, onClose }: { album: TogetherDetail; visible: boolean; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const [audience, setAudience] = useState<(typeof CHAPTER_AUDIENCES)[number]>('friends');
  const [error, setError] = useState<string | null>(null);
  const mine = album.items.some((i) => i.mine);
  return (
    <BottomSheet visible={visible} title={t('together.after.chapter')} onClose={onClose}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {mine ? (
        <>
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('together.chapter.body')}</Text>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.chapters.audience')}</Text>
          <View accessibilityRole="radiogroup" style={{ gap: 2 }}>
            {CHAPTER_AUDIENCES.map((aud) => (
              <Pressable
                key={aud}
                accessibilityRole="radio"
                accessibilityState={{ checked: audience === aud }}
                onPress={() => setAudience(aud)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
              >
                <Icon name={audience === aud ? 'radio-button-on' : 'radio-button-off'} size={22} color={audience === aud ? c.yapi : c.inkMuted} />
                <Text style={{ color: c.ink, fontSize: 15 }}>{t(`m.chapters.audience.${aud}` as MessageKey)}</Text>
              </Pressable>
            ))}
          </View>
          <Button
            label={t('together.chapter.submit')}
            onPress={async () => {
              setError(null);
              try {
                const r = await (await client()).together.chapter(album.id, { audience });
                onClose();
                AccessibilityInfo.announceForAccessibility(t('together.after.chapterDone'));
                router.push(`/chapter/${r.chapter.id}`);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('together.after.noneOwn')}</Text>
      )}
    </BottomSheet>
  );
}
