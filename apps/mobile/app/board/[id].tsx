import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, FlatList, Image, Pressable, RefreshControl, Text, View } from 'react-native';
import { BOARD_COLLABORATORS_MAX, type SavedFilter } from '../../../../packages/shared/src/constants';
import type { BoardDetail, Post, PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { BoardCover, SaveTile, tileRows, useBoardMeta, useBoards, usePostLabel, useSavedFilters, VISIBILITY_ICON, type SaveChange } from '../../lib/boards';
import { useT } from '../../lib/i18n';
import { useReport } from '../../lib/report';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import {
  type ActionSheetAction,
  Avatar,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Loading,
  Notice,
  ScreenError,
  Segmented,
  Title,
  useActionSheet,
  useColors,
  userText,
} from '../../lib/ui';

/** Avatars shown in the header before "+N". */
const FACES = 5;

/**
 * A board: cover, name, description, who can see it, whose it is and who adds to it, then its
 * posts in order. The owner edits it, invites and removes people, picks the cover, arranges and
 * removes posts, or deletes it; collaborators add, arrange and leave; an invited person accepts
 * or declines.
 */
export default function BoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useSession();
  const boardsApi = useBoards();
  const meta = useBoardMeta();
  const postLabel = usePostLabel();
  const filters = useSavedFilters();
  const [data, setData] = useState<BoardDetail | null | undefined>(undefined);
  // Why it couldn't load, when that isn't because it's gone or private; a board already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SavedFilter>('all');
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState(false);
  const [inviting, setInviting] = useState(false);
  // Arrange mode: a working copy of the whole board in order.
  const [order, setOrder] = useState<Post[] | null>(null);
  // Posts the viewer may take off: the owner any, a collaborator the ones they added.
  const [removable, setRemovable] = useState<Set<string>>(new Set());
  const markRemovable = (ids: string[]) => setRemovable((cur) => (ids.every((x) => cur.has(x)) ? cur : new Set([...cur, ...ids])));
  const orderStart = useRef('');
  const seq = useRef(0);
  const menu = useActionSheet();
  const report = useReport();

  const load = useCallback(async () => {
    try {
      setData(await (await client()).boards.get(id));
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setData(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);

  const loadItems = useCallback(
    async (f: SavedFilter, next?: string) => {
      const run = next ? seq.current : ++seq.current;
      try {
        const page = await (await client()).boards.items(id, f, next);
        if (run !== seq.current) return;
        markRemovable(page.removable);
        setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        if (run !== seq.current) return;
        setItems((cur) => cur ?? []);
        setError(errorMessage(e));
      }
    },
    [id],
  );

  // Back from the editor: the name, cover or visibility may have changed.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    setItems(null);
    setCursor(null);
    void loadItems(filter);
  }, [filter, loadItems]);

  if (data === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.boards.unavailable')} />
      </View>
    );

  const { board, collaborators } = data;
  const owner = board.role === 'owner';
  const member = owner || board.role === 'collaborator';
  const accepted = collaborators.filter((x) => x.status === 'accepted');
  const faces: PublicUser[] = [board.owner, ...accepted.map((x) => x.user)];
  const say = (text: string) => {
    setNote(text);
    AccessibilityInfo.announceForAccessibility(text);
  };

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) say(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const boards = () => client().then((a) => a.boards);

  const refresh = async () => {
    setError(null);
    await Promise.all([load(), loadItems(filter)]);
  };

  function confirm(title: string, body: string, action: string, fn: () => Promise<void>) {
    Alert.alert(title, body, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: action, style: 'destructive', onPress: () => void fn() },
    ]);
  }

  const removeItem = (post: Post) =>
    act(async () => {
      await (await boards()).removeItem(board.id, post.id);
      setItems((cur) => cur?.filter((x) => x.id !== post.id) ?? null);
      setOrder((cur) => cur?.filter((x) => x.id !== post.id) ?? null);
      await load();
    }, t('m.boards.itemRemoved'));

  const setCover = (post: Post | null) =>
    act(async () => {
      await (await boards()).update(board.id, { coverPostId: post ? post.id : null });
      await load();
    }, t('m.boards.coverSet'));

  /** Keep the tiles in step with the sheet: an unsaved post also leaves the boards you own. */
  const onChange = (post: Post) => (ch: SaveChange) => {
    if (ch.note !== undefined)
      setItems((cur) => cur?.map((x) => (x.id === post.id ? { ...x, viewer: { ...x.viewer, note: ch.note, saved: true } } : x)) ?? null);
    if (ch.boardsChanged) void refresh();
  };

  function more(post: Post) {
    const actions: ActionSheetAction[] = [];
    if (me) actions.push({ label: t('m.boards.saveTo'), icon: 'bookmarks-outline', onPress: () => boardsApi.openSaveSheet(post, onChange(post)) });
    if (owner) actions.push({ label: t('m.boards.useAsCover'), icon: 'image-outline', onPress: () => void setCover(post) });
    if (member && removable.has(post.id))
      actions.push({ label: t('m.boards.removeItem'), icon: 'trash-outline', destructive: true, onPress: () => void removeItem(post) });
    if (me && post.author.id !== me.id)
      actions.push({
        label: t('post.report'),
        icon: 'flag-outline',
        destructive: true,
        onPress: () => report.open({ type: 'post', id: post.id, authorId: post.author.id, authorName: post.author.displayName }),
      });
    menu.show({ title: postLabel(post), actions });
  }

  /** Arrange: load the whole board in order (no filter), then move posts up or down. */
  async function startArranging() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const api = await boards();
      let page = await api.items(board.id, 'all');
      const all = [...page.items];
      const canRemove = [...page.removable];
      while (page.nextCursor) {
        page = await api.items(board.id, 'all', page.nextCursor);
        all.push(...page.items.filter((x) => !all.some((y) => y.id === x.id)));
        canRemove.push(...page.removable);
      }
      markRemovable(canRemove);
      orderStart.current = all.map((x) => x.id).join();
      setOrder(all);
      setPeople(false);
      setInviting(false);
      AccessibilityInfo.announceForAccessibility(t('m.boards.arrangeHint'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    if (!order) return;
    const to = index + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [p] = next.splice(index, 1);
    next.splice(to, 0, p!);
    setOrder(next);
    AccessibilityInfo.announceForAccessibility(t('m.boards.moved', { index: to + 1, total: next.length }));
  }

  async function finishArranging() {
    if (!order) return;
    const changed = order.map((x) => x.id).join() !== orderStart.current;
    await act(async () => {
      if (changed)
        await (
          await boards()
        ).reorder(
          board.id,
          order.map((x) => x.id),
        );
      setFilter('all');
      setItems(order);
      setCursor(null);
      setOrder(null);
      await load();
    }, t('m.boards.orderSaved'));
  }

  const visibilityLine = owner
    ? t(`m.boards.visibility.${board.visibility}`)
    : board.visibility === 'public'
      ? t('m.boards.marker.public')
      : board.visibility === 'shared'
        ? t('m.boards.marker.shared')
        : t('m.boards.visibility.private');

  const header = (
    <View style={{ gap: space[4], marginBottom: space[1] }}>
      <Stack.Screen options={{ title: board.name }} />
      <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'center' }}>
        <BoardCover board={board} size={96} />
        <View style={{ flex: 1, gap: 4 }}>
          <Title sub={meta(board)}>{board.name}</Title>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name={VISIBILITY_ICON[board.visibility]} size={14} color={c.inkMuted} />
            <Text style={{ color: c.inkMuted, fontSize: 13, flexShrink: 1 }}>{visibilityLine}</Text>
          </View>
          {!owner ? (
            <Pressable accessibilityRole="link" hitSlop={6} onPress={() => router.push(`/u/${board.owner.username}`)}>
              <Text style={[{ color: c.yapi, fontSize: 13, fontWeight: '700' }, userText]} numberOfLines={1}>
                {t('m.boards.by', { name: board.owner.displayName })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {board.description ? <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{board.description}</Text> : null}

      {faces.length > 1 || owner ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: people }}
          accessibilityLabel={`${t('m.boards.people')}: ${tp('m.boards.collaborators', accepted.length)}`}
          onPress={() => setPeople((v) => !v)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], alignSelf: 'flex-start', minHeight: 36 }}
        >
          <View style={{ flexDirection: 'row' }}>
            {faces.slice(0, FACES).map((u, i) => (
              <View key={u.id} style={{ marginStart: i ? -10 : 0, borderRadius: 16, borderWidth: 2, borderColor: c.ground }}>
                <Avatar name={u.displayName} url={u.avatarUrl} size={28} />
              </View>
            ))}
          </View>
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>
            {faces.length > FACES ? `+${faces.length - FACES} · ` : ''}
            {tp('m.boards.collaborators', accepted.length)}
          </Text>
          <Icon name={people ? 'chevron-up' : 'chevron-down'} size={14} color={c.inkMuted} />
        </Pressable>
      ) : null}

      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {board.role === 'invited' ? (
        <Card style={{ gap: space[2] }}>
          <Text style={[{ color: c.ink, fontWeight: '700', lineHeight: 20 }, userText]}>{t('m.boards.invitedYou', { name: board.owner.displayName })}</Text>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.boards.invitedHint')}</Text>
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button
              label={t('m.common.accept')}
              size="sm"
              disabled={busy}
              onPress={() =>
                void act(async () => {
                  await (await boards()).join(board.id);
                  await refresh();
                }, t('m.boards.joined'))
              }
            />
            <Button
              label={t('m.common.decline')}
              size="sm"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void act(async () => {
                  await (await boards()).leave(board.id);
                  router.back();
                })
              }
            />
          </View>
        </Card>
      ) : null}

      {order ? (
        <Card style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.boards.arrangeHint')}</Text>
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button label={t('m.common.done')} size="sm" disabled={busy} onPress={() => finishArranging()} />
            <Button label={t('common.cancel')} size="sm" variant="secondary" disabled={busy} onPress={() => setOrder(null)} />
          </View>
        </Card>
      ) : member ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {owner ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon="create-outline"
                label={t('m.boards.edit')}
                onPress={() => router.push(`/board-edit?id=${board.id}`)}
              />
              <Button
                variant="secondary"
                size="sm"
                icon="person-add-outline"
                label={t('m.boards.invite')}
                onPress={() => {
                  setInviting((v) => !v);
                  setPeople(true);
                }}
              />
            </>
          ) : null}
          {(items?.length ?? 0) > 1 || cursor ? (
            <Button variant="secondary" size="sm" icon="swap-vertical" label={t('m.boards.arrange')} disabled={busy} onPress={() => startArranging()} />
          ) : null}
          {owner ? (
            <Button
              variant="ghost"
              size="sm"
              label={t('m.common.delete')}
              onPress={() =>
                confirm(t('m.boards.deleteTitle'), t('m.boards.deleteBody'), t('m.common.delete'), () =>
                  act(async () => {
                    await (await boards()).remove(board.id);
                    router.back();
                  }),
                )
              }
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              label={t('m.boards.leave')}
              onPress={() =>
                confirm(t('m.boards.leaveTitle'), t('m.boards.leaveBody'), t('m.boards.leave'), () =>
                  act(async () => {
                    await (await boards()).leave(board.id);
                    router.back();
                  }),
                )
              }
            />
          )}
        </View>
      ) : null}

      {inviting && owner && !order ? (
        <InvitePicker
          full={collaborators.length >= BOARD_COLLABORATORS_MAX}
          exclude={[board.owner.id, ...collaborators.map((x) => x.user.id)]}
          busy={busy}
          onPick={(u) =>
            void act(
              async () => {
                setData(await (await boards()).invite(board.id, u.id));
              },
              t('m.boards.invited', { name: u.displayName }),
            )
          }
        />
      ) : null}

      {people && !order ? (
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.boards.people')}
          </Text>
          <PersonLine user={board.owner} note={t('m.boards.owner')} />
          {collaborators.map((m) => (
            <PersonLine
              key={m.user.id}
              user={m.user}
              note={m.status === 'invited' ? t('m.boards.pending') : undefined}
              end={
                owner ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    label={t('m.common.remove')}
                    disabled={busy}
                    onPress={() =>
                      confirm(
                        t('m.boards.removePerson', { name: m.user.displayName }),
                        t('m.boards.removePersonBody', { name: m.user.displayName }),
                        t('m.common.remove'),
                        () =>
                          act(async () => {
                            await (await boards()).removeCollaborator(board.id, m.user.id);
                            await load();
                          }),
                      )
                    }
                  />
                ) : null
              }
            />
          ))}
        </View>
      ) : null}

      {!order ? <Segmented label={t('m.saved.filter')} value={filter} onChange={setFilter} options={filters} /> : null}
      {menu.sheet}
      {report.sheet}
    </View>
  );

  if (order)
    return (
      <FlatList
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[2], paddingBottom: space[8] }}
        data={order}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={header}
        renderItem={({ item: post, index }) => (
          <ArrangeRow
            post={post}
            label={postLabel(post)}
            position={t('m.boards.position', { index: index + 1, total: order.length })}
            first={index === 0}
            last={index === order.length - 1}
            busy={busy}
            onUp={() => move(index, -1)}
            onDown={() => move(index, 1)}
            onRemove={removable.has(post.id) ? () => void removeItem(post) : undefined}
          />
        )}
      />
    );

  return (
    <FlatList
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      data={items ? tileRows(items) : []}
      keyExtractor={(row) => row.map((p) => p.id).join('|')}
      ListHeaderComponent={header}
      renderItem={({ item: row }) => (
        <View style={{ flexDirection: 'row', gap: space[3] }}>
          {row.map((post) => (
            <SaveTile
              key={post.id}
              post={post}
              note={member ? (post.viewer.note ?? '') : undefined}
              onEditNote={member ? () => boardsApi.openNote(post, onChange(post)) : undefined}
              onMore={me ? () => more(post) : undefined}
              moreLabel={t('m.post.more')}
            />
          ))}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      )}
      ListEmptyComponent={
        items === null ? (
          <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} style={{ padding: space[6] }} />
        ) : filter === 'all' ? (
          <EmptyState title={t('m.boards.empty')} body={board.canAdd ? t('m.boards.emptyBody') : undefined} />
        ) : (
          <EmptyState title={t('m.saved.emptyFilter')} />
        )
      }
      ListFooterComponent={loadingMore ? <ActivityIndicator color={c.yapi} accessibilityLabel={t('m.common.loadingMore')} /> : null}
      onEndReached={async () => {
        if (!cursor || loadingMore) return;
        setLoadingMore(true);
        await loadItems(filter, cursor);
        setLoadingMore(false);
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        />
      }
    />
  );
}

function PersonLine({ user, note, end }: { user: PublicUser; note?: string; end?: ReactNode }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${t('m.title.profile')}: ${user.displayName}${note ? `, ${note}` : ''}`}
        onPress={() => router.push(`/u/${user.username}`)}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
      >
        <Avatar name={user.displayName} url={user.avatarUrl} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
            {user.displayName}
          </Text>
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {note ?? `@${user.username}`}
          </Text>
        </View>
      </Pressable>
      {end}
    </View>
  );
}

/** One post in Arrange mode: a small picture, where it sits, and Move up / Move down / Remove. */
function ArrangeRow({
  post,
  label,
  position,
  first,
  last,
  busy,
  onUp,
  onDown,
  onRemove,
}: {
  post: Post;
  label: string;
  position: string;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove?: () => void;
}) {
  const c = useColors();
  const { t } = useT();
  const image = post.media.find((m) => m.kind === 'image');
  const uri = post.locked ? null : image ? (image.variants?.thumb ?? image.url) : (post.media.find((m) => m.kind === 'video')?.posterUrl ?? null);
  const iconButton = (icon: 'chevron-up' | 'chevron-down' | 'close', a11y: string, onPress: () => void, disabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? c.surfaceSunken : c.surface,
        borderWidth: 1,
        borderColor: c.line,
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Icon name={icon} size={18} color={icon === 'close' ? c.danger : c.ink} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: c.surface, borderRadius: radius.md, padding: space[2] }}>
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: c.yapiSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {uri ? (
          <Image source={{ uri: mediaUrl(uri) }} style={{ width: 48, height: 48 }} blurRadius={image?.sensitive ? 30 : 0} />
        ) : (
          <Icon name={post.locked ? 'lock-closed' : 'document-text-outline'} size={18} color={c.inkMuted} />
        )}
      </View>
      <View style={{ flex: 1 }} accessible accessibilityLabel={`${label}, ${position}`}>
        <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 14 }, userText]} numberOfLines={1}>
          {post.body.trim() || post.author.displayName}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 12 }}>{position}</Text>
      </View>
      {iconButton('chevron-up', `${t('m.boards.moveUp')}, ${label}`, onUp, first || busy)}
      {iconButton('chevron-down', `${t('m.boards.moveDown')}, ${label}`, onDown, last || busy)}
      {onRemove ? iconButton('close', `${t('m.boards.removeItem')}, ${label}`, onRemove, busy) : null}
    </View>
  );
}

/** Invite people you can add to a board: friends, and people you follow who follow you back. */
function InvitePicker({ exclude, full, busy, onPick }: { exclude: string[]; full: boolean; busy: boolean; onPick: (u: PublicUser) => void }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const run = ++seq.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim().replace(/^@/, ''), 12, 'mutuals'))
          .then(
            (r) => run === seq.current && setItems(r.items.map((x) => x.user)),
            () => run === seq.current && setItems([]),
          ),
      q ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);
  const shown = (items ?? []).filter((u) => !exclude.includes(u.id));
  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800' }}>
        {t('m.boards.inviteTitle')}
      </Text>
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.boards.inviteHint')}</Text>
      {full ? (
        <Text style={{ color: c.inkMuted }}>{t('m.boards.max', { count: BOARD_COLLABORATORS_MAX })}</Text>
      ) : (
        <>
          <Field
            label={t('m.closeFriends.search')}
            hideLabel
            placeholder={t('m.closeFriends.search')}
            value={q}
            onChangeText={setQ}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View accessibilityRole="list" accessibilityLabel={t('m.ac.people')} style={{ gap: space[2] }}>
            {items === null ? null : shown.length ? (
              shown.map((u) => (
                <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                  <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
                  <View style={{ flex: 1 }}>
                    <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                      {u.displayName}
                    </Text>
                    <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                      @{u.username}
                    </Text>
                  </View>
                  <Button size="sm" label={t('m.boards.inviteOne')} disabled={busy} onPress={() => onPick(u)} />
                </View>
              ))
            ) : (
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.boards.noneFound')}</Text>
            )}
          </View>
        </>
      )}
    </Card>
  );
}
