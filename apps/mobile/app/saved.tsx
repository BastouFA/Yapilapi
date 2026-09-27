import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import type { SavedFilter } from '../../../packages/shared/src/constants';
import type { Board, Post } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { BoardGrid, NewBoardCard, SaveTile, tileRows, useBoards, useSavedFilters, type SaveChange } from '../lib/boards';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { EmptyState, Loading, Notice, Segmented, useColors } from '../lib/ui';

/** Boards shown before "Show all boards" (with the New board card, three rows). */
const BOARDS_PREVIEW = 5;

/**
 * Saved: your boards, then everything you saved (posts and reels), newest first, with a filter.
 * Each save shows your private note, which you can edit; press and hold a tile for "Save to…".
 */
export default function Saved() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const boardsApi = useBoards();
  const filters = useSavedFilters();
  const [filter, setFilter] = useState<SavedFilter>('all');
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [allBoards, setAllBoards] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Answers to an older filter are dropped.
  const seq = useRef(0);

  const loadSaves = useCallback(async (f: SavedFilter, next?: string) => {
    const id = next ? seq.current : ++seq.current;
    try {
      const page = await (await client()).me.saved(f, next);
      if (id !== seq.current) return;
      setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (id !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);

  const loadBoards = useCallback(async () => {
    try {
      setBoards((await (await client()).boards.mine()).items);
    } catch (e) {
      setBoards((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    setItems(null);
    setCursor(null);
    void loadSaves(filter);
  }, [me, filter, loadSaves]);

  // Coming back from a board or the board editor: names, covers and counts may have changed.
  useFocusEffect(
    useCallback(() => {
      if (me) void loadBoards();
    }, [me, loadBoards]),
  );

  const more = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    await loadSaves(filter, cursor);
    setLoadingMore(false);
  };

  /** Keep the list in step with what changed in the sheet or the note editor. */
  const onChange = (post: Post) => (ch: SaveChange) => {
    if (!ch.saved) setItems((cur) => cur?.filter((x) => x.id !== post.id) ?? null);
    else if (ch.note !== undefined) setItems((cur) => cur?.map((x) => (x.id === post.id ? { ...x, viewer: { ...x.viewer, note: ch.note } } : x)) ?? null);
    if (ch.boardsChanged) void loadBoards();
  };

  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  const shownBoards = boards ? (allBoards ? boards : boards.slice(0, BOARDS_PREVIEW)) : [];
  const header = (
    <View style={{ gap: space[4], marginBottom: space[1] }}>
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.saved.hint')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('m.boards.title')}
        </Text>
        {boards === null ? (
          <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} />
        ) : (
          <>
            {!boards.length ? <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.boards.noneHint')}</Text> : null}
            <BoardGrid items={shownBoards} lead={<NewBoardCard />} />
            {boards.length > BOARDS_PREVIEW ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: allBoards }}
                hitSlop={8}
                onPress={() => setAllBoards((v) => !v)}
                style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}
              >
                <Text style={{ color: c.yapi, fontWeight: '700' }}>
                  {allBoards ? t('m.boards.showFewer') : t('m.boards.showAll', { count: boards.length })}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
      <View style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('m.saved.saves')}
        </Text>
        <Segmented label={t('m.saved.filter')} value={filter} onChange={setFilter} options={filters} />
      </View>
    </View>
  );

  return (
    <FlatList
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
              note={post.viewer.note ?? ''}
              onEditNote={() => boardsApi.openNote(post, onChange(post))}
              onMore={() => boardsApi.openSaveSheet(post, onChange(post))}
              moreLabel={t('m.boards.saveTo')}
            />
          ))}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      )}
      ListEmptyComponent={
        items === null ? (
          <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} style={{ padding: space[6] }} />
        ) : filter === 'all' ? (
          <EmptyState title={t('m.saved.empty')} body={t('m.saved.emptyBody')} />
        ) : (
          <EmptyState title={t('m.saved.emptyFilter')} />
        )
      }
      ListFooterComponent={loadingMore ? <ActivityIndicator color={c.yapi} accessibilityLabel={t('m.common.loadingMore')} /> : null}
      onEndReached={() => void more()}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            setError(null);
            await Promise.all([loadSaves(filter), loadBoards()]);
            setRefreshing(false);
          }}
        />
      }
    />
  );
}
