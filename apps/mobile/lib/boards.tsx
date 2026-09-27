import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BOARD_NAME_MAX, SAVE_NOTE_MAX, type BoardVisibility, type SavedFilter } from '../../../packages/shared/src/constants';
import type { Board, Post } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { useT } from './i18n';
import { palette, radius, space } from './theme';
import { Button, EmptyState, Field, Icon, Loading, useColors, userText, type IconName } from './ui';

const WHITE = '#FFFFFF';

/** Only tiny inline previews (data URIs) are shown as placeholders; never a remote URL. */
const isInline = (s: string | null | undefined): s is string => !!s && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(s);

/** Open a saved post where it lives: reels in the Reels player, everything else on its page. */
export function openPost(post: Post) {
  if (post.format === 'reel') router.push({ pathname: '/reels', params: { start: post.id } });
  else router.push(`/p/${post.id}`);
}

export const VISIBILITY_ICON: Record<BoardVisibility, IconName> = {
  private: 'lock-closed-outline',
  shared: 'people-outline',
  public: 'globe-outline',
};

/** Filter options for the Saved page and a board, in the app's language. */
export function useSavedFilters() {
  const { t } = useT();
  return useMemo(
    () =>
      (['all', 'photos', 'videos', 'text'] as const satisfies readonly SavedFilter[]).map((id) => ({
        id,
        label: t(`m.saved.filter.${id}`),
      })),
    [t],
  );
}

/** A board's cover: the chosen post's picture, a text snippet, or the brand gradient for an empty board. */
export function BoardCover({ board, size }: { board: Board; size?: number }) {
  const c = useColors();
  const box = size ? { width: size, height: size } : { width: '100%' as const, aspectRatio: 1 };
  const style = [box, { borderRadius: radius.md, overflow: 'hidden' as const, backgroundColor: c.surfaceSunken }];
  const cv = board.cover;
  if (cv?.imageUrl) return <Image source={{ uri: mediaUrl(cv.imageUrl) }} style={style} resizeMode="cover" accessibilityIgnoresInvertColors />;
  if (cv && isInline(cv.placeholder)) return <Image source={{ uri: cv.placeholder }} blurRadius={20} style={style} resizeMode="cover" />;
  if (cv?.text)
    return (
      <View style={[style, { backgroundColor: c.yapiSoft, padding: space[2], justifyContent: 'center' }]}>
        <Text
          style={[{ color: c.ink, fontSize: size && size < 72 ? 10 : 13, lineHeight: size && size < 72 ? 13 : 18, fontWeight: '600' }, userText]}
          numberOfLines={5}
        >
          {cv.text}
        </Text>
      </View>
    );
  return (
    <LinearGradient
      colors={[c.yapi, c.gradEnd]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[box, { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }]}
    >
      <Icon name="bookmark" size={size ? Math.round(size * 0.36) : 32} color={WHITE} />
    </LinearGradient>
  );
}

/** "12 posts · Shared" (the marker only when the board isn't just yours). */
export function useBoardMeta() {
  const { t, tp } = useT();
  return useCallback(
    (b: Board) =>
      [
        tp('m.boards.items', b.itemCount),
        b.role === 'invited'
          ? t('m.boards.marker.invited')
          : b.visibility === 'public'
            ? t('m.boards.marker.public')
            : b.visibility === 'shared'
              ? t('m.boards.marker.shared')
              : null,
      ]
        .filter(Boolean)
        .join(' · '),
    [t, tp],
  );
}

/** A board in a grid: cover, name, count and a shared or public marker. Someone else's board also says whose it is. */
export function BoardCard({ board, showOwner }: { board: Board; showOwner?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const meta = useBoardMeta();
  const line = meta(board);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[board.name, showOwner ? t('m.boards.by', { name: board.owner.displayName }) : null, line].filter(Boolean).join(', ')}
      onPress={() => router.push(`/board/${board.id}`)}
      style={({ pressed }) => ({ flex: 1, gap: 6, opacity: pressed ? 0.8 : 1 })}
    >
      <View>
        <BoardCover board={board} />
        {board.visibility !== 'private' || board.role === 'invited' ? (
          <View
            style={{
              position: 'absolute',
              top: space[2],
              end: space[2],
              width: 26,
              height: 26,
              borderRadius: 13,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.55)',
            }}
          >
            <Icon name={board.role === 'invited' ? 'mail-outline' : VISIBILITY_ICON[board.visibility]} size={14} color={WHITE} />
          </View>
        ) : null}
      </View>
      <View style={{ gap: 1 }}>
        <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 14 }, userText]} numberOfLines={1}>
          {board.name}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={1}>
          {showOwner ? `${board.owner.displayName} · ${line}` : line}
        </Text>
      </View>
    </Pressable>
  );
}

/** The dashed "New board" card that starts the grid. */
export function NewBoardCard() {
  const c = useColors();
  const { t } = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('m.boards.new')}
      onPress={() => router.push('/board-edit')}
      style={({ pressed }) => ({ flex: 1, gap: 6, opacity: pressed ? 0.8 : 1 })}
    >
      <View
        style={{
          width: '100%',
          aspectRatio: 1,
          borderRadius: radius.md,
          borderWidth: 2,
          borderStyle: 'dashed',
          borderColor: c.lineStrong,
          alignItems: 'center',
          justifyContent: 'center',
          gap: space[1],
        }}
      >
        <Icon name="add" size={28} color={c.yapi} />
      </View>
      <Text style={{ color: c.ink, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
        {t('m.boards.new')}
      </Text>
    </Pressable>
  );
}

/** Boards laid out two to a row (the last row keeps its half width). */
export function BoardGrid({ items, lead, showOwner }: { items: Board[]; lead?: ReactNode; showOwner?: boolean }) {
  const cells: ReactNode[] = [...(lead ? [lead] : []), ...items.map((b) => <BoardCard key={b.id} board={b} showOwner={showOwner} />)];
  const rows: ReactNode[][] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  return (
    <View style={{ gap: space[4] }}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: space[3] }}>
          {row.map((cell, j) => (
            <View key={j} style={{ flex: 1 }}>
              {cell}
            </View>
          ))}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

/** What a tile shows for a post: its picture or video poster, or its text. */
function thumbOf(post: Post) {
  const image = post.media.find((m) => m.kind === 'image');
  const video = post.media.find((m) => m.kind === 'video');
  if (image) return { uri: image.variants?.thumb ?? image.variants?.medium ?? image.url, video: false, sensitive: !!image.sensitive };
  if (video?.posterUrl) return { uri: video.posterUrl, video: true, sensitive: !!video.sensitive };
  return { uri: null, video: !!video, sensitive: false };
}

/** "Post by Ada, a day out by the sea" for screen readers. */
export function usePostLabel() {
  const { t } = useT();
  return useCallback(
    (post: Post) => {
      const snippet = post.locked ? t('post.locked.title') : post.body.trim().slice(0, 80);
      return [t('m.post.by', { name: post.author.displayName }), snippet].filter(Boolean).join(', ');
    },
    [t],
  );
}

/**
 * A saved post as a square tile: picture, video poster or text, a lock for posts for
 * subscribers. Under it, your private note and a way to edit it. Long-press (or the screen
 * reader's actions) for more.
 */
export function SaveTile({
  post,
  note,
  onEditNote,
  onMore,
  moreLabel,
}: {
  post: Post;
  /** Your note; undefined hides the note row (someone else's board). */
  note?: string;
  onEditNote?: () => void;
  onMore?: () => void;
  moreLabel?: string;
}) {
  const c = useColors();
  const { t } = useT();
  const label = usePostLabel()(post);
  const th = thumbOf(post);
  const locked = !!post.locked;
  const actions = [
    ...(onMore && moreLabel ? [{ name: 'more', label: moreLabel }] : []),
    ...(onEditNote ? [{ name: 'note', label: note ? t('m.saved.editNote') : t('m.saved.addNote') }] : []),
  ];
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'more') onMore?.();
    if (e.nativeEvent.actionName === 'note') onEditNote?.();
  };
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityActions={actions.length ? actions : undefined}
        onAccessibilityAction={onAction}
        onPress={() => openPost(post)}
        onLongPress={onMore}
        style={({ pressed }) => ({
          width: '100%',
          aspectRatio: 1,
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: locked ? c.surfaceSunken : th.uri ? c.surfaceSunken : c.yapiSoft,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        {locked ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[1], padding: space[2] }}>
            {isInline(post.locked?.placeholder) ? (
              <Image source={{ uri: post.locked!.placeholder! }} blurRadius={20} style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 }} />
            ) : null}
            <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' }}>
              <Icon name="lock-closed" size={18} color={WHITE} />
            </View>
            <Text style={{ color: c.ink, fontSize: 12, fontWeight: '700', textAlign: 'center' }} numberOfLines={2}>
              {t('post.locked.title')}
            </Text>
          </View>
        ) : th.uri ? (
          <Image source={{ uri: mediaUrl(th.uri) }} blurRadius={th.sensitive ? 40 : 0} style={{ flex: 1 }} resizeMode="cover" />
        ) : (
          <View style={{ flex: 1, padding: space[3], justifyContent: 'center' }}>
            <Text style={[{ color: c.ink, fontSize: 14, lineHeight: 19, fontWeight: '600' }, userText]} numberOfLines={6}>
              {post.body}
            </Text>
          </View>
        )}
        {th.video && !locked ? (
          <View
            style={{
              position: 'absolute',
              top: space[2],
              end: space[2],
              width: 26,
              height: 26,
              borderRadius: 13,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.55)',
            }}
          >
            <Icon name="play" size={13} color={WHITE} />
          </View>
        ) : null}
      </Pressable>
      <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
        {post.author.displayName}
      </Text>
      {note !== undefined && onEditNote ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={note ? `${t('m.saved.editNote')}: ${note}` : t('m.saved.addNote')}
          hitSlop={4}
          onPress={onEditNote}
          style={{ flexDirection: 'row', gap: 4, alignItems: 'flex-start', minHeight: 24 }}
        >
          <Icon name={note ? 'document-text-outline' : 'add'} size={14} color={note ? c.inkMuted : c.yapi} />
          <Text
            style={[{ flex: 1, color: note ? c.ink : c.yapi, fontSize: 12, lineHeight: 16, fontWeight: note ? '400' : '600' }, note ? userText : null]}
            numberOfLines={3}
          >
            {note || t('m.saved.addNote')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Posts laid out as tiles, two to a row. */
export function tileRows<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

// ─── The sheet, the note editor and the "Saved" confirmation ─────────────────────────────────

/** What changed for a post in the sheet, so the screen that opened it can keep up. */
export type SaveChange = { saved: boolean; note?: string; boardsChanged?: boolean };
type OnChange = (change: SaveChange) => void;

interface BoardsApi {
  /** "Save to…": your boards with checks, a new board, and your private note. */
  openSaveSheet: (post: Post, onChange?: OnChange) => void;
  /** Edit only the note. */
  openNote: (post: Post, onChange?: OnChange) => void;
  /** The quiet "Saved. Add to a board" confirmation after a save. */
  confirmSaved: (post: Post, onChange?: OnChange) => void;
}

const noop = () => {};
const Ctx = createContext<BoardsApi>({ openSaveSheet: noop, openNote: noop, confirmSaved: noop });
export const useBoards = () => useContext(Ctx);

const SNACK_MS = 5000;
const SNACK_SCREEN_READER_MS = 12000;

/** Holds the "Save to…" sheet, the note editor and the confirmation for the whole app. */
export function BoardsProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<{ post: Post; onChange?: OnChange } | null>(null);
  const [noteFor, setNoteFor] = useState<{ post: Post; onChange?: OnChange } | null>(null);
  const [snack, setSnack] = useState<{ post: Post; onChange?: OnChange; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useT();

  const hideSnack = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSnack(null);
  }, []);

  const api = useMemo<BoardsApi>(
    () => ({
      openSaveSheet: (post, onChange) => {
        hideSnack();
        setSheet({ post, onChange });
      },
      openNote: (post, onChange) => setNoteFor({ post, onChange }),
      confirmSaved: (post, onChange) => {
        if (timer.current) clearTimeout(timer.current);
        setSnack({ post, onChange, key: Date.now() });
        AccessibilityInfo.announceForAccessibility(`${t('m.saved.done')} ${t('m.saved.addToBoard')}`);
        void AccessibilityInfo.isScreenReaderEnabled()
          .catch(() => false)
          .then((reader) => {
            timer.current = setTimeout(() => setSnack(null), reader ? SNACK_SCREEN_READER_MS : SNACK_MS);
          });
      },
    }),
    [hideSnack, t],
  );

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <Ctx.Provider value={api}>
      {children}
      {snack ? <SavedSnack onAdd={() => api.openSaveSheet(snack.post, snack.onChange)} onClose={hideSnack} /> : null}
      <SaveSheet target={sheet} onClose={() => setSheet(null)} />
      <NoteSheet target={noteFor} onClose={() => setNoteFor(null)} />
    </Ctx.Provider>
  );
}

function SavedSnack({ onAdd, onClose }: { onAdd: () => void; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', start: space[4], end: space[4], bottom: insets.bottom + 96, alignItems: 'center', zIndex: 60 }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          backgroundColor: c.ink,
          borderRadius: radius.full,
          paddingStart: space[4],
          paddingEnd: space[1],
          minHeight: 44,
          maxWidth: '100%',
        }}
      >
        <Text style={{ color: c.ground, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
          {t('m.saved.done')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.saved.addToBoard')}
          onPress={onAdd}
          hitSlop={4}
          style={({ pressed }) => ({
            paddingHorizontal: space[3],
            height: 36,
            justifyContent: 'center',
            borderRadius: radius.full,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          {/* The snackbar is inverted (ink background), so the link takes the other theme's accent. */}
          <Text style={{ color: palette(c.theme === 'dark' ? 'light' : 'dark').yapiStrong, fontWeight: '800' }}>{t('m.saved.addToBoard')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.common.close')}
          onPress={onClose}
          hitSlop={6}
          style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="close" size={16} color={c.ground} />
        </Pressable>
      </View>
    </View>
  );
}

/** The bottom sheet frame shared by "Save to…" and the note editor. */
function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} style={{ flex: 1 }} onPress={onClose} />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: c.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              padding: space[4],
              paddingBottom: Math.max(insets.bottom, space[4]),
              maxHeight: '85%',
              gap: space[3],
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {title}
              </Text>
              <Button label={t('m.common.done')} size="sm" variant="ghost" onPress={onClose} />
            </View>
            {children}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SaveSheet({ target, onClose }: { target: { post: Post; onChange?: OnChange } | null; onClose: () => void }) {
  const c = useColors();
  const { t, number } = useT();
  const meta = useBoardMeta();
  const post = target?.post ?? null;
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef<SaveChange | null>(null);

  useEffect(() => {
    if (!post) return;
    setBoards(null);
    setName('');
    setStatus(null);
    setError(null);
    changed.current = null;
    let live = true;
    void client().then(async (api) => {
      try {
        const [mine, state] = await Promise.all([api.boards.mine(post.id), api.posts.saveState(post.id)]);
        if (!live) return;
        setBoards(mine.items.filter((b) => b.canAdd));
        setSaved(state.saved);
        setNote(state.note);
        setDraft(state.note);
      } catch (e) {
        if (!live) return;
        setBoards([]);
        setError(errorMessage(e));
      }
    });
    return () => {
      live = false;
    };
  }, [post]);

  const report = (next: Partial<SaveChange> & { saved: boolean }) => {
    changed.current = { ...changed.current, ...next, boardsChanged: next.boardsChanged || changed.current?.boardsChanged };
  };
  const close = () => {
    if (changed.current) target?.onChange?.(changed.current);
    onClose();
  };
  const say = (text: string) => {
    setStatus(text);
    AccessibilityInfo.announceForAccessibility(text);
  };

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const toggleBoard = (b: Board) =>
    run(b.id, async () => {
      const api = await client();
      if (b.contains) {
        await api.boards.removeItem(b.id, post!.id);
        setBoards((cur) => cur?.map((x) => (x.id === b.id ? { ...x, contains: false, itemCount: Math.max(0, x.itemCount - 1) } : x)) ?? null);
        report({ saved, boardsChanged: true });
        say(t('m.boards.removed', { name: b.name }));
      } else {
        await api.boards.addItem(b.id, post!.id);
        setBoards((cur) => cur?.map((x) => (x.id === b.id ? { ...x, contains: true, itemCount: x.itemCount + 1 } : x)) ?? null);
        setSaved(true);
        report({ saved: true, boardsChanged: true });
        say(t('m.boards.added', { name: b.name }));
      }
    });

  const toggleSaved = () =>
    run('saved', async () => {
      const api = await client();
      if (saved) {
        await api.posts.unsave(post!.id);
        setSaved(false);
        // Unsaving also takes it off the boards you own.
        setBoards(
          (cur) => cur?.map((x) => (x.role === 'owner' && x.contains ? { ...x, contains: false, itemCount: Math.max(0, x.itemCount - 1) } : x)) ?? null,
        );
        report({ saved: false, boardsChanged: true });
        say(t('m.saved.removed'));
      } else {
        await api.posts.save(post!.id);
        setSaved(true);
        report({ saved: true });
        say(t('m.saved.done'));
      }
    });

  const saveNote = () =>
    run('note', async () => {
      const r = await (await client()).posts.setSaveNote(post!.id, draft.trim());
      setNote(r.note);
      setDraft(r.note);
      setSaved(true);
      report({ saved: true, note: r.note });
      say(r.note ? t('m.saved.noteSaved') : t('m.saved.noteCleared'));
    });

  const create = () =>
    run('new', async () => {
      const r = await (await client()).boards.create({ name: name.trim(), postIds: [post!.id] });
      setBoards((cur) => [{ ...r.board, contains: true }, ...(cur ?? [])]);
      setName('');
      setSaved(true);
      report({ saved: true, boardsChanged: true });
      say(t('m.boards.created', { name: r.board.name }));
    });

  return (
    <Sheet visible={!!post} title={t('m.boards.sheetTitle')} onClose={close}>
      {boards === null ? (
        <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} />
      ) : (
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space[3] }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Icon name={saved ? 'bookmark' : 'bookmark-outline'} size={18} color={saved ? c.yapi : c.inkMuted} />
            <Text style={{ flex: 1, color: c.ink, fontWeight: '600' }}>{saved ? t('m.saved.inSaved') : t('m.saved.notSaved')}</Text>
            <Button
              size="sm"
              variant="secondary"
              label={saved ? t('m.post.unsave') : t('post.save')}
              disabled={busy !== null}
              onPress={() => void toggleSaved()}
            />
          </View>

          <View accessibilityRole="list" style={{ gap: space[2] }}>
            {boards.length ? (
              boards.map((b) => (
                <Pressable
                  key={b.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: !!b.contains, disabled: busy !== null }}
                  accessibilityLabel={`${b.name}, ${meta(b)}`}
                  disabled={busy !== null}
                  onPress={() => void toggleBoard(b)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[3],
                    padding: space[2],
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: b.contains ? c.yapi : c.line,
                    backgroundColor: b.contains ? c.yapiSoft : pressed ? c.surfaceSunken : c.surface,
                  })}
                >
                  <BoardCover board={b} size={44} />
                  <View style={{ flex: 1 }}>
                    <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                      {b.name}
                    </Text>
                    <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                      {b.role === 'owner' ? meta(b) : `${t('m.boards.by', { name: b.owner.displayName })} · ${meta(b)}`}
                    </Text>
                  </View>
                  {busy === b.id ? (
                    <ActivityIndicator color={c.yapi} />
                  ) : (
                    <Icon name={b.contains ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={b.contains ? c.yapi : c.lineStrong} />
                  )}
                </Pressable>
              ))
            ) : (
              <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.boards.noneToAdd')}</Text>
            )}
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space[2] }}>
            <View style={{ flex: 1 }}>
              <Field
                label={t('m.boards.newLabel')}
                placeholder={t('m.boards.namePlaceholder')}
                value={name}
                onChangeText={setName}
                maxLength={BOARD_NAME_MAX}
                returnKeyType="done"
                onSubmitEditing={() => name.trim() && busy === null && void create()}
              />
            </View>
            <Button label={t('m.boards.create')} size="md" disabled={!name.trim() || busy !== null} onPress={() => void create()} />
          </View>

          <View style={{ gap: space[1] }}>
            <Field
              label={t('m.saved.noteLabel')}
              placeholder={t('m.saved.notePlaceholder')}
              value={draft}
              onChangeText={setDraft}
              maxLength={SAVE_NOTE_MAX}
              multiline
              style={{ minHeight: 72, paddingTop: space[2], textAlignVertical: 'top' }}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Icon name="lock-closed-outline" size={13} color={c.inkMuted} />
              <Text style={{ flex: 1, color: c.inkMuted, fontSize: 12 }}>{t('m.saved.noteHint')}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 12 }} accessibilityElementsHidden importantForAccessibility="no">
                {number(draft.length)}/{number(SAVE_NOTE_MAX)}
              </Text>
            </View>
            {draft.trim() !== note ? (
              <Button
                label={t('m.saved.saveNote')}
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onPress={() => void saveNote()}
                style={{ alignSelf: 'flex-start' }}
              />
            ) : null}
          </View>

          {status ? (
            <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
              {status}
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: c.danger }}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      )}
    </Sheet>
  );
}

function NoteSheet({ target, onClose }: { target: { post: Post; onChange?: OnChange } | null; onClose: () => void }) {
  const c = useColors();
  const { t, number } = useT();
  const post = target?.post ?? null;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!post) return;
    setDraft(post.viewer.note ?? '');
    setError(null);
  }, [post]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).posts.setSaveNote(post!.id, draft.trim());
      target?.onChange?.({ saved: true, note: r.note });
      AccessibilityInfo.announceForAccessibility(r.note ? t('m.saved.noteSaved') : t('m.saved.noteCleared'));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={!!post} title={post?.viewer.note ? t('m.saved.editNote') : t('m.saved.addNote')} onClose={onClose}>
      <Field
        label={t('m.saved.noteLabel')}
        placeholder={t('m.saved.notePlaceholder')}
        value={draft}
        onChangeText={setDraft}
        maxLength={SAVE_NOTE_MAX}
        multiline
        autoFocus
        style={{ minHeight: 96, paddingTop: space[2], textAlignVertical: 'top' }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Icon name="lock-closed-outline" size={13} color={c.inkMuted} />
        <Text style={{ flex: 1, color: c.inkMuted, fontSize: 12 }}>{t('m.saved.noteHint')}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 12 }} accessibilityElementsHidden importantForAccessibility="no">
          {number(draft.length)}/{number(SAVE_NOTE_MAX)}
        </Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.danger }}>
          {error}
        </Text>
      ) : null}
      <Button label={t('m.saved.saveNote')} disabled={busy || draft.trim() === (post?.viewer.note ?? '')} onPress={() => void save()} />
    </Sheet>
  );
}

// ─── Profile tab ────────────────────────────────────────────────────────────────────────────

/** The Boards tab on a profile: that person's public boards. */
export function ProfileBoards({ username, isSelf }: { username: string; isSelf: boolean }) {
  const { t } = useT();
  const [items, setItems] = useState<Board[] | null>(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    client()
      .then((api) => api.boards.forUser(username))
      .then(
        (r) => live && setItems(r.items),
        () => live && setItems([]),
      );
    return () => {
      live = false;
    };
  }, [username]);
  if (!items) return <Loading />;
  if (!items.length) return <EmptyState title={t('m.boards.publicNone')} body={isSelf ? t('m.boards.publicNoneSelf') : undefined} />;
  return <BoardGrid items={items} />;
}
