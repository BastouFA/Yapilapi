import { useVideoPlayer, VideoView } from 'expo-video';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import {
  TOGETHER_ADD_BATCH,
  TOGETHER_CAPTION_MAX,
  TOGETHER_COMMENT_MAX,
  TOGETHER_REACTIONS,
  TOGETHER_WINDOWS,
  togetherClosesAt,
  togetherClosesAtOk,
  type TogetherComment,
  type TogetherDetail,
  type TogetherItem,
  type TogetherReaction,
  type TogetherSummary,
  type TogetherWindow,
} from '../../../packages/shared/src/together';
import { client, errorMessage, mediaUrl } from './api';
import { useDataSaver } from './data-saver';
import { DateField } from './date-time';
import { useT, type Translator } from './i18n';
import { uploadPicked, type Picked } from './media';
import { useReducedMotion } from './motion';
import { useReport } from './report';
import { REACTION_ICON, REACTION_LABEL } from './rooms';
import { SensitiveCover } from './safety';
import { useRealtime } from './session';
import { radius, space } from './theme';
import { ActionSheet, Avatar, BottomSheet, Button, Field, Icon, Notice, useColors, userText, type ActionSheetAction } from './ui';

/*
 * Together on the phone: shared albums (packages/shared/src/together.ts). The album screen
 * (app/together/[id].tsx) puts these together: tiles, the full-screen viewer with stars,
 * reactions and comments, the slideshow, and adding several photos and videos at once from the
 * camera or the library.
 */

const DARK = '#07080E';
const PANEL = '#0E1019';
const ON_DARK = '#F2F3FA';
const MUTED_ON_DARK = '#B8BDD6';
const LINE_ON_DARK = '#3A3F5C';

// ── Words ───────────────────────────────────────────────────────────────

/** "Sat 04:00", or with the date when it's more than a week away. */
export function whenShort(iso: string, tr: Pick<Translator, 'date'>): string {
  const at = new Date(iso);
  const far = Math.abs(at.getTime() - Date.now()) > 6 * 86_400_000;
  return tr.date(at, far ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function statusText(s: Pick<TogetherSummary, 'status' | 'closesAt' | 'closedAt'>, tr: Translator): string {
  if (s.status === 'closed') return s.closedAt ? tr.t('together.status.closedAt', { time: whenShort(s.closedAt, tr) }) : tr.t('together.status.closed');
  return s.closesAt ? tr.t('together.status.until', { time: whenShort(s.closesAt, tr) }) : tr.t('together.status.untilClosed');
}

export function thumbOf(item: TogetherItem, big = false): string | null {
  const v = item.media.variants ?? {};
  const url = item.media.kind === 'video' ? (item.media.posterUrl ?? v.thumb ?? null) : ((big ? v.medium : (v.thumb ?? v.medium)) ?? item.media.url);
  return url ? mediaUrl(url) : null;
}

export function tileLabel(item: TogetherItem, tr: Translator): string {
  const base = tr.t(item.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', {
    name: item.author.displayName,
    time: whenShort(item.takenAt, tr),
  });
  return item.starred ? `${base}. ${tr.t('together.tile.starred')}` : base;
}

// ── When it's open ──────────────────────────────────────────────────────

const WINDOW_LABEL: Record<TogetherWindow, MessageKey> = {
  tonight: 'together.window.tonight',
  day: 'together.window.day',
  weekend: 'together.window.weekend',
  week: 'together.window.week',
  custom: 'together.window.custom',
  open: 'together.window.open',
};

/** The chosen window as a closing time: null for "until I close it"; undefined when a custom time isn't allowed. */
export function windowClosesAt(w: TogetherWindow, custom: Date | null): string | null | undefined {
  if (w === 'custom') return custom && togetherClosesAtOk(custom) ? custom.toISOString() : undefined;
  return togetherClosesAt(w)?.toISOString() ?? null;
}

/** Tonight, 24 hours, this weekend, a week, a chosen time, or until a host closes it. */
export function WindowPicker({
  value,
  custom,
  onChange,
}: {
  value: TogetherWindow;
  custom: Date | null;
  onChange: (w: TogetherWindow, custom: Date | null) => void;
}) {
  const c = useColors();
  const tr = useT();
  const { t } = tr;
  const at = windowClosesAt(value, custom);
  return (
    <View style={{ gap: space[2] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>
        {t('together.window.label')}
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('together.window.label')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {TOGETHER_WINDOWS.map((w) => {
          const on = value === w;
          return (
            <Pressable
              key={w}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={t(WINDOW_LABEL[w])}
              onPress={() => onChange(w, w === 'custom' && !custom ? new Date(Date.now() + 3 * 3_600_000) : custom)}
              style={({ pressed }) => ({
                minHeight: 44,
                paddingHorizontal: space[4],
                borderRadius: radius.full,
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: on ? c.ink : c.lineStrong,
                backgroundColor: on ? c.ink : pressed ? c.surfaceSunken : c.surface,
              })}
            >
              <Text style={{ color: on ? c.surface : c.ink, fontWeight: '700' }}>{t(WINDOW_LABEL[w])}</Text>
            </Pressable>
          );
        })}
      </View>
      {value === 'custom' ? (
        <DateField
          label={t('together.window.customLabel')}
          value={custom}
          onChange={(d) => onChange('custom', d)}
          min={new Date(Date.now() + 15 * 60_000)}
          max={new Date(Date.now() + 59 * 86_400_000)}
          note={at === undefined ? t('together.window.invalid') : undefined}
        />
      ) : null}
      <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
        {at ? t('together.window.until', { time: whenShort(at, tr) }) : at === null ? t('together.status.untilClosed') : t('together.window.invalid')}
      </Text>
    </View>
  );
}

// ── Tiles ───────────────────────────────────────────────────────────────

export function Tile({ item, size, onPress }: { item: TogetherItem; size: number; onPress: () => void }) {
  const c = useColors();
  const tr = useT();
  const saver = useDataSaver().active;
  const src = thumbOf(item, size > 160 && !saver);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={tileLabel(item, tr)}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: 6,
        overflow: 'hidden',
        backgroundColor: c.surfaceSunken,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {src ? (
        <Image
          source={{ uri: src }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
          blurRadius={item.media.sensitive ? 30 : 0}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={item.media.kind === 'video' ? 'videocam-outline' : 'image-outline'} size={22} color={c.inkMuted} />
        </View>
      )}
      {item.media.kind === 'video' ? (
        <View style={[st.badge, { top: 6, end: 6 }]}>
          <Icon name="play" size={11} color="#FFFFFF" />
        </View>
      ) : null}
      {item.media.sensitive ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name="eye-off-outline" size={20} color="#FFFFFF" />
        </View>
      ) : null}
      {item.stars ? (
        <View style={[st.badge, { bottom: 6, start: 6 }, item.starred && { backgroundColor: '#FFBE3D' }]}>
          <Icon name="star" size={11} color={item.starred ? '#0B0C14' : '#FFFFFF'} />
          <Text style={{ color: item.starred ? '#0B0C14' : '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{item.stars}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ── Picking and adding ──────────────────────────────────────────────────

/** "2024:10:12 18:30:22" (the file's own date, in local time), as a Date. Only the date is read, never the place. */
function exifDate(exif: Record<string, unknown> | null | undefined): Date | null {
  const raw = exif?.DateTimeOriginal ?? exif?.DateTimeDigitized ?? exif?.DateTime;
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() ? null : d;
}

export type PickResult = Picked[] | 'denied' | null;

/** Several photos and videos from the library (up to 20 at a time). */
export async function pickFromLibrary(): Promise<PickResult> {
  const launch = () =>
    ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: TOGETHER_ADD_BATCH,
      quality: 0.9,
      exif: true,
    });
  let r: ImagePicker.ImagePickerResult;
  try {
    r = await launch();
  } catch {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.accessPrivileges !== 'limited') return 'denied';
    r = await launch();
  }
  return r.canceled ? null : r.assets;
}

/** A photo or a video, taken now with the camera. */
export async function takeWithCamera(): Promise<PickResult> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return 'denied';
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.9, exif: true, videoMaxDuration: 60 });
  return r.canceled ? null : r.assets;
}

type Pending = { key: string; asset: Picked; caption: string; progress: number; state: 'waiting' | 'uploading' | 'done' | 'failed' };

/**
 * The chosen photos and videos, each with an optional caption; then each uploads (photos made
 * smaller first on Data saver; big videos in resumable chunks) and they're added in groups of
 * 20 with the date the file says it was taken.
 */
export function AddSheet({ album, assets, onClose, onAdded }: { album: TogetherDetail; assets: Picked[]; onClose: () => void; onAdded: (n: number) => void }) {
  const c = useColors();
  const { t, tp } = useT();
  const saver = useDataSaver().active;
  const [list, setList] = useState<Pending[]>(() => assets.map((a, i) => ({ key: `${a.uri}-${i}`, asset: a, caption: '', progress: 0, state: 'waiting' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = list.filter((p) => p.state === 'done').length;
  const failed = list.filter((p) => p.state === 'failed').length;
  const patch = (key: string, p: Partial<Pending>) => setList((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function start() {
    setBusy(true);
    setError(null);
    const ready: { key: string; mediaId: string; caption: string; takenAt?: string }[] = [];
    for (const p of list) {
      if (p.state === 'done') continue;
      patch(p.key, { state: 'uploading', progress: 0 });
      try {
        const media = await uploadPicked(p.asset, (f) => patch(p.key, { progress: f }));
        const taken = exifDate(p.asset.exif as Record<string, unknown> | undefined);
        ready.push({ key: p.key, mediaId: media.id, caption: p.caption.trim(), takenAt: taken?.toISOString() });
      } catch {
        patch(p.key, { state: 'failed' });
      }
    }
    let added = 0;
    for (let k = 0; k < ready.length; k += TOGETHER_ADD_BATCH) {
      const batch = ready.slice(k, k + TOGETHER_ADD_BATCH);
      try {
        const r = await (
          await client()
        ).together.addItems(
          album.id,
          batch.map(({ mediaId, caption, takenAt }) => ({ mediaId, caption, takenAt })),
        );
        added += r.items.length;
        for (const b of batch) patch(b.key, { state: 'done', progress: 1 });
      } catch (e) {
        setError(errorMessage(e));
        for (const b of batch) patch(b.key, { state: 'failed' });
      }
    }
    setBusy(false);
    if (added) {
      onAdded(added);
      AccessibilityInfo.announceForAccessibility(tp('together.add.done', added));
    }
    setList((l) => {
      if (!l.some((p) => p.state === 'failed')) setTimeout(onClose, 0);
      return l;
    });
  }

  return (
    <BottomSheet visible title={t('together.add.title', { title: album.title })} onClose={busy ? () => {} : onClose}>
      {saver ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('together.add.dataSaver')}</Text> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {list.map((p) => (
        <View key={p.key} style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: radius.sm,
              overflow: 'hidden',
              backgroundColor: c.surfaceSunken,
              borderWidth: p.state === 'failed' ? 2 : 0,
              borderColor: c.danger,
            }}
          >
            <Image source={{ uri: p.asset.uri }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Field
              label={t('together.add.caption')}
              hideLabel
              placeholder={t('together.add.caption')}
              value={p.caption}
              maxLength={TOGETHER_CAPTION_MAX}
              editable={!busy && p.state !== 'done'}
              onChangeText={(v) => patch(p.key, { caption: v })}
            />
            {p.state === 'uploading' || p.state === 'done' ? (
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(p.progress * 100) }}
                style={{ height: 4, borderRadius: 2, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
              >
                <View style={{ width: `${Math.round(p.progress * 100)}%`, height: 4, backgroundColor: c.yapi }} />
              </View>
            ) : p.state === 'failed' ? (
              <Text style={{ color: c.danger, fontSize: 13 }}>{t('together.add.failedOne')}</Text>
            ) : null}
          </View>
          {!busy && p.state !== 'done' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.common.remove')}
              hitSlop={8}
              onPress={() => setList((l) => l.filter((x) => x.key !== p.key))}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="close" size={20} color={c.inkMuted} />
            </Pressable>
          ) : null}
        </View>
      ))}
      <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
        {busy ? t('together.add.uploading', { done, total: list.length }) : failed ? t('together.add.failed') : ''}
      </Text>
      <Button
        label={failed ? t('m.common.retry') : tp('together.add.submit', list.length)}
        icon="cloud-upload-outline"
        disabled={busy || !list.some((p) => p.state !== 'done')}
        onPress={() => start()}
      />
    </BottomSheet>
  );
}

// ── Saving ──────────────────────────────────────────────────────────────

/** Save to my photos: the file is fetched, then the share sheet offers Save Image or Save Video. */
export async function saveItem(item: TogetherItem, t: Translator['t']) {
  const url = mediaUrl(item.media.kind === 'video' ? item.media.url : (item.media.variants?.large ?? item.media.url));
  const file = await File.downloadFileAsync(url, new File(Paths.cache, item.fileName), { idempotent: true });
  if (!(await Sharing.isAvailableAsync())) throw new Error(t('together.viewer.saveFailed'));
  const video = item.media.kind === 'video';
  await Sharing.shareAsync(file.uri, {
    mimeType: video ? 'video/mp4' : 'image/jpeg',
    UTI: video ? 'public.mpeg-4' : 'public.jpeg',
    dialogTitle: t('together.viewer.save'),
  });
}

// ── The viewer ──────────────────────────────────────────────────────────

function VideoPage({ item, active, width, height, label }: { item: TogetherItem; active: boolean; width: number; height: number; label: string }) {
  const saver = useDataSaver().active;
  const src = mediaUrl(saver ? (item.media.variants?.mp4_360 ?? item.media.url) : item.media.url);
  const player = useVideoPlayer(src, (p) => {
    p.loop = false;
  });
  useEffect(() => {
    if (active && !saver) player.play();
    else if (!active) player.pause();
  }, [active, saver, player]);
  return (
    <View style={{ width, height }}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls
        allowsPictureInPicture={false}
        accessibilityLabel={label}
      />
    </View>
  );
}

function CommentsSheet({
  album,
  item,
  visible,
  onClose,
  onCount,
}: {
  album: TogetherDetail;
  item: TogetherItem;
  visible: boolean;
  onClose: () => void;
  onCount: (n: number) => void;
}) {
  const c = useColors();
  const tr = useT();
  const { t, tp } = tr;
  const [list, setList] = useState<TogetherComment[] | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setList(null);
    void client()
      .then((api) => api.together.comments(album.id, item.id))
      .then(
        (r) => setList(r.items),
        () => setList([]),
      );
  }, [visible, album.id, item.id, item.comments]);
  const done = (items: TogetherComment[]) => {
    setList(items);
    onCount(items.length);
  };
  return (
    <BottomSheet visible={visible} title={tp('together.viewer.commentsCount', list?.length ?? item.comments)} onClose={onClose}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {list === null ? null : list.length ? (
        list.map((cm) => (
          <View key={cm.id} style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-start' }}>
            <Avatar name={cm.author.displayName} url={cm.author.avatarUrl} size={32} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>
                {cm.author.displayName} <Text style={{ color: c.inkMuted, fontWeight: '400', fontSize: 12 }}>{whenShort(cm.createdAt, tr)}</Text>
              </Text>
              <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{cm.body}</Text>
            </View>
            {cm.canDelete ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('together.viewer.deleteComment')}
                hitSlop={8}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                onPress={async () => {
                  try {
                    done((await (await client()).together.removeComment(album.id, item.id, cm.id)).items);
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              >
                <Icon name="trash-outline" size={18} color={c.inkMuted} />
              </Pressable>
            ) : null}
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('together.viewer.noComments')}</Text>
      )}
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field
            label={t('together.viewer.commentPlaceholder')}
            hideLabel
            placeholder={t('together.viewer.commentPlaceholder')}
            value={body}
            maxLength={TOGETHER_COMMENT_MAX}
            onChangeText={setBody}
          />
        </View>
        <Button
          label={t('together.viewer.send')}
          size="sm"
          disabled={!body.trim()}
          onPress={async () => {
            setError(null);
            try {
              done((await (await client()).together.comment(album.id, item.id, body.trim())).items);
              setBody('');
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        />
      </View>
    </BottomSheet>
  );
}

/**
 * Full screen: swipe between photos and videos; below each, who added it, when it was taken and
 * its caption, a star, the reactions and the comments. The menu saves it to your photos, reports
 * it, makes it the cover or removes it.
 */
export function Viewer({
  album,
  items,
  startId,
  onClose,
  onItem,
  onRemoved,
}: {
  album: TogetherDetail;
  items: TogetherItem[];
  startId: string;
  onClose: () => void;
  onItem: (item: TogetherItem) => void;
  onRemoved: (id: string) => void;
}) {
  const tr = useT();
  const { t, tp } = tr;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduce = useReducedMotion();
  const saver = useDataSaver().active;
  const report = useReport();
  const start = Math.max(
    0,
    items.findIndex((i) => i.id === startId),
  );
  const [index, setIndex] = useState(start);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [comments, setComments] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList<TogetherItem>>(null);
  const item = items[Math.min(index, items.length - 1)];
  const stageH = Math.round(height * 0.62);

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<TogetherItem>[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setIndex(first.index);
  }).current;

  useEffect(() => {
    if (!items.length) onClose();
  }, [items.length, onClose]);
  if (!item) return null;

  const run = async (p: Promise<{ item: TogetherItem }>) => {
    setError(null);
    try {
      onItem((await p).item);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const api = () => client().then((x) => x.together);
  const mine = item.reactions.find((r) => r.mine)?.kind ?? null;

  const actions: ActionSheetAction[] = [
    {
      label: t('together.viewer.save'),
      icon: 'download-outline',
      onPress: () => void saveItem(item, t).catch((e) => setError(errorMessage(e))),
    },
    ...(item.mine ? [{ label: t('together.viewer.editCaption'), icon: 'create-outline' as const, onPress: () => setEditing(item.caption) }] : []),
    ...(album.canManage && !item.media.sensitive
      ? [
          {
            label: t('together.viewer.cover'),
            icon: 'image-outline' as const,
            onPress: () =>
              void api()
                .then((x) => x.update(album.id, { coverItemId: item.id }))
                .then(
                  () => AccessibilityInfo.announceForAccessibility(t('together.saved')),
                  (e) => setError(errorMessage(e)),
                ),
          },
        ]
      : []),
    ...(!item.mine
      ? [
          {
            label: t('together.viewer.report'),
            icon: 'flag-outline' as const,
            destructive: true,
            onPress: () => report.open({ type: 'together_item', id: item.id, authorId: item.author.id, authorName: item.author.displayName }),
          },
        ]
      : []),
    ...(item.mine || album.canManage
      ? [
          {
            label: t('together.viewer.remove'),
            icon: 'trash-outline' as const,
            destructive: true,
            onPress: () =>
              void api()
                .then((x) => x.removeItem(album.id, item.id))
                .then(
                  () => onRemoved(item.id),
                  (e) => setError(errorMessage(e)),
                ),
          },
        ]
      : []),
  ];

  const shown = (x: TogetherItem) => !x.media.sensitive || revealed.has(x.id);

  return (
    <Modal visible transparent={false} animationType={reduce ? 'none' : 'fade'} onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: DARK }}>
        <View style={{ paddingTop: insets.top + space[1], paddingHorizontal: space[3], flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: MUTED_ON_DARK }}>
            {t('together.viewer.position', { index: index + 1, total: items.length })}
          </Text>
          <DarkButton icon="ellipsis-horizontal" label={t('together.viewer.more')} onPress={() => setMenu(true)} />
          <DarkButton icon="close" label={t('m.common.close')} onPress={onClose} />
        </View>
        <FlatList
          ref={list}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={start}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(x) => x.id}
          windowSize={3}
          initialNumToRender={1}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          onViewableItemsChanged={onViewable}
          style={{ flexGrow: 0, height: stageH }}
          renderItem={({ item: x, index: i }) =>
            x.media.kind === 'video' && shown(x) ? (
              <VideoPage item={x} active={i === index} width={width} height={stageH} label={tileLabel(x, tr)} />
            ) : (
              <View style={{ width, height: stageH }}>
                <Image
                  source={{
                    uri: mediaUrl(
                      x.media.kind === 'video'
                        ? (x.media.posterUrl ?? x.media.url)
                        : saver
                          ? (x.media.variants?.medium ?? x.media.url)
                          : (x.media.variants?.large ?? x.media.url),
                    ),
                  }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="contain"
                  blurRadius={shown(x) ? 0 : 40}
                  accessible
                  accessibilityLabel={shown(x) ? (x.media.altText ?? tileLabel(x, tr)) : undefined}
                  accessibilityIgnoresInvertColors
                />
                {shown(x) ? null : <SensitiveCover onReveal={() => setRevealed((s) => new Set(s).add(x.id))} />}
              </View>
            )
          }
        />
        <ScrollView
          style={{ flex: 1, backgroundColor: PANEL }}
          contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: insets.bottom + space[4] }}
        >
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Avatar name={item.author.displayName} url={item.author.avatarUrl} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: ON_DARK, fontWeight: '700' }, userText]} numberOfLines={1}>
                {item.author.displayName}
              </Text>
              <Text style={{ color: MUTED_ON_DARK, fontSize: 13 }}>
                {t(item.takenFromFile ? 'together.viewer.taken' : 'together.viewer.added', { time: whenShort(item.takenAt, tr) })}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: item.starred }}
              accessibilityLabel={item.starred ? t('together.viewer.unstar') : t('together.viewer.star')}
              onPress={() => void run(api().then((x) => x.star(album.id, item.id, !item.starred)))}
              style={{
                minHeight: 44,
                paddingHorizontal: space[3],
                borderRadius: radius.full,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                borderWidth: 1,
                borderColor: item.starred ? '#FFBE3D' : LINE_ON_DARK,
                backgroundColor: item.starred ? '#FFBE3D' : 'transparent',
              }}
            >
              <Icon name={item.starred ? 'star' : 'star-outline'} size={18} color={item.starred ? '#0B0C14' : ON_DARK} />
              <Text style={{ color: item.starred ? '#0B0C14' : ON_DARK, fontWeight: '700' }}>
                {item.stars ? tp('together.viewer.stars', item.stars) : t('together.viewer.star')}
              </Text>
            </Pressable>
          </View>
          {editing !== null ? (
            <View style={{ gap: space[2] }}>
              <TextInput
                accessibilityLabel={t('together.add.caption')}
                value={editing}
                onChangeText={setEditing}
                maxLength={TOGETHER_CAPTION_MAX}
                placeholder={t('together.add.caption')}
                placeholderTextColor={MUTED_ON_DARK}
                style={[
                  { minHeight: 44, borderWidth: 1, borderColor: LINE_ON_DARK, borderRadius: radius.md, paddingHorizontal: space[3], color: ON_DARK },
                  userText,
                ]}
              />
              <View style={{ flexDirection: 'row', gap: space[2] }}>
                <Button
                  label={t('common.save')}
                  size="sm"
                  onPress={async () => {
                    await run(api().then((x) => x.setCaption(album.id, item.id, editing)));
                    setEditing(null);
                  }}
                />
                <Button label={t('common.cancel')} size="sm" variant="secondary" onPress={() => setEditing(null)} />
              </View>
            </View>
          ) : item.caption ? (
            <Text style={[{ color: ON_DARK, fontSize: 16, lineHeight: 23 }, userText]}>{item.caption}</Text>
          ) : null}
          <View accessibilityRole="toolbar" accessibilityLabel={t('together.viewer.react')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
            {TOGETHER_REACTIONS.map((k: TogetherReaction) => {
              const n = item.reactions.find((r) => r.kind === k)?.count ?? 0;
              const on = mine === k;
              return (
                <Pressable
                  key={k}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={n ? t('together.viewer.reaction', { reaction: t(REACTION_LABEL[k]), count: n }) : t(REACTION_LABEL[k])}
                  onPress={() => void run(api().then((x) => x.react(album.id, item.id, on ? null : k)))}
                  style={{
                    minWidth: 48,
                    minHeight: 44,
                    paddingHorizontal: 10,
                    borderRadius: radius.full,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    borderWidth: 1,
                    borderColor: on ? '#FF8AA0' : LINE_ON_DARK,
                    backgroundColor: on ? '#3A1624' : 'transparent',
                  }}
                >
                  <Icon name={REACTION_ICON[k]} size={20} color={ON_DARK} />
                  {n ? <Text style={{ color: ON_DARK, fontSize: 13 }}>{n}</Text> : null}
                </Pressable>
              );
            })}
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setComments(true)}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space[2] }}
          >
            <Icon name="chatbubble-outline" size={18} color={ON_DARK} />
            <Text style={{ color: ON_DARK, fontWeight: '700' }}>{tp('together.viewer.commentsCount', item.comments)}</Text>
          </Pressable>
        </ScrollView>
      </View>
      <ActionSheet visible={menu} title={t('together.viewer.more')} actions={actions} onClose={() => setMenu(false)} />
      <CommentsSheet
        album={album}
        item={item}
        visible={comments}
        onClose={() => setComments(false)}
        onCount={(n) => n !== item.comments && onItem({ ...item, comments: n })}
      />
      {report.sheet}
    </Modal>
  );
}

function DarkButton({
  icon,
  label,
  onPress,
}: {
  icon: 'close' | 'ellipsis-horizontal' | 'play' | 'pause' | 'play-skip-forward';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)',
      })}
    >
      <Icon name={icon} size={22} color="#FFFFFF" />
    </Pressable>
  );
}

// ── Slideshow ───────────────────────────────────────────────────────────

const SLIDE_MS = 6_000;

/**
 * Full screen, for showing on a TV (with screen mirroring) at the event: one photo at a time with
 * a gentle crossfade (a plain cut with reduced motion), who added it and the caption. New photos
 * can play as they arrive, and screen readers hear how many came in.
 */
export function Slideshow({ album, onClose }: { album: TogetherDetail; onClose: () => void }) {
  const tr = useT();
  const { t, tp } = tr;
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const saver = useDataSaver().active;
  const [items, setItems] = useState(album.items.filter((x) => !x.media.sensitive && x.media.kind === 'image'));
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [live, setLive] = useState(true);
  const fade = useRef(new Animated.Value(1)).current;
  const queue = useRef<string[]>([]);
  const current = items.length ? items[i % items.length] : undefined;

  const next = useCallback(() => {
    const waiting = queue.current.shift();
    const at = waiting ? items.findIndex((x) => x.id === waiting) : -1;
    const go = () => setI((x) => (at >= 0 ? at : items.length ? (x + 1) % items.length : 0));
    if (reduce) return go();
    Animated.timing(fade, { toValue: 0, duration: 500, useNativeDriver: true }).start(() => {
      go();
      Animated.timing(fade, { toValue: 1, duration: 700, useNativeDriver: true }).start();
    });
  }, [items, reduce, fade]);

  useEffect(() => {
    if (!playing || !current) return;
    const timer = setTimeout(next, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [playing, current, next]);

  useRealtime((e) => {
    if (!live || e.type !== 'together.items' || e.data?.togetherId !== album.id || e.data?.removed) return;
    void client()
      .then((api) => api.together.get(album.id))
      .then(
        (r) => {
          const fresh = r.together.items.filter((x) => !x.media.sensitive && x.media.kind === 'image');
          setItems((old) => {
            const known = new Set(old.map((x) => x.id));
            const added = fresh.filter((x) => !known.has(x.id));
            if (added.length) {
              queue.current.push(...added.map((x) => x.id));
              AccessibilityInfo.announceForAccessibility(tp('together.show.new', added.length));
            }
            return fresh;
          });
        },
        () => {},
      );
  });

  return (
    <Modal visible animationType={reduce ? 'none' : 'fade'} onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <StatusBar hidden />
      <View style={{ flex: 1, backgroundColor: '#000' }} accessibilityLabel={t('together.show.label', { title: album.title })}>
        {current ? (
          <Animated.View style={{ flex: 1, opacity: fade }}>
            <Image
              source={{ uri: mediaUrl(saver ? (current.media.variants?.medium ?? current.media.url) : (current.media.variants?.large ?? current.media.url)) }}
              style={{ flex: 1 }}
              resizeMode="contain"
              accessible
              accessibilityLabel={current.media.altText ?? tileLabel(current, tr)}
              accessibilityIgnoresInvertColors
            />
            <View
              style={{
                position: 'absolute',
                start: space[4],
                bottom: insets.bottom + 88,
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[2],
                backgroundColor: 'rgba(0,0,0,0.6)',
                borderRadius: radius.full,
                paddingHorizontal: space[3],
                paddingVertical: space[2],
                maxWidth: '85%',
              }}
            >
              <Avatar name={current.author.displayName} url={current.author.avatarUrl} size={28} />
              <Text style={[{ color: '#FFFFFF', fontSize: 16, flexShrink: 1 }, userText]} numberOfLines={2}>
                <Text style={{ fontWeight: '700' }}>{current.author.displayName}</Text>
                {current.caption ? ` · ${current.caption}` : ''}
              </Text>
            </View>
          </Animated.View>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#C9CDE0', fontSize: 18 }}>{t('together.show.empty')}</Text>
          </View>
        )}
        <Text style={[{ position: 'absolute', top: insets.top + space[3], start: space[4], color: '#FFFFFF', fontSize: 20, fontWeight: '800' }, userText]}>
          {album.title}
        </Text>
        <View
          style={{
            position: 'absolute',
            start: 0,
            end: 0,
            bottom: 0,
            paddingBottom: insets.bottom + space[3],
            paddingHorizontal: space[4],
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            backgroundColor: 'rgba(0,0,0,0.55)',
            paddingTop: space[3],
          }}
        >
          <DarkButton icon={playing ? 'pause' : 'play'} label={playing ? t('m.common.pause') : t('m.common.play')} onPress={() => setPlaying((p) => !p)} />
          <DarkButton icon="play-skip-forward" label={t('together.viewer.next')} onPress={next} />
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: live }}
            accessibilityLabel={t('together.show.live')}
            onPress={() => setLive((v) => !v)}
            style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space[2] }}
          >
            <Icon name={live ? 'checkbox' : 'square-outline'} size={22} color="#FFFFFF" />
            <Text style={{ color: '#FFFFFF', flexShrink: 1 }}>{t('together.show.live')}</Text>
          </Pressable>
          <DarkButton icon="close" label={t('together.show.exit')} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  badge: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
});

/** The three views, grouped, as rows for one list: headings and rows of tiles. */
export type AlbumRow =
  { type: 'head'; key: string; title: string; meta: string; user?: TogetherItem['author'] } | { type: 'tiles'; key: string; items: TogetherItem[] };

export function useTileSize(columns: number) {
  const { width } = useWindowDimensions();
  return useMemo(() => Math.floor((width - space[4] * 2 - (columns - 1) * 4) / columns), [width, columns]);
}
