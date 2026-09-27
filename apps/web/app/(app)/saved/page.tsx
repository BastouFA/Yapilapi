'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Segments, Skeleton, type MenuAction } from '@yapilapi/design-system';
import type { Board, MessageKey, Post, SavedFilter } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import {
  BoardEditor,
  BoardGrid,
  MoreButton,
  NoteSheet,
  SaveGrid,
  SaveOptionsSheet,
  SaveToSheet,
  boardHref,
  savedFilterOptions,
  usePaged,
} from '@/components/Boards';
import { useSession } from '../../providers';

const EMPTY: Record<SavedFilter, { title: MessageKey; body: MessageKey }> = {
  all: { title: 'm.saved.empty', body: 'saved.emptyBody' },
  photos: { title: 'saved.emptyPhotos', body: 'saved.emptyPhotosBody' },
  videos: { title: 'saved.emptyVideos', body: 'saved.emptyVideosBody' },
  text: { title: 'saved.emptyText', body: 'saved.emptyTextBody' },
};

/**
 * Saved: your boards (and the ones you collaborate on), then everything you saved, newest
 * first, with a filter. Only you see your saves and your notes on them.
 */
export default function SavedPage() {
  const { toast, t } = useSession();
  const router = useRouter();
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [filter, setFilter] = useState<SavedFilter>('all');
  const [creating, setCreating] = useState(false);
  const [options, setOptions] = useState<Post | null>(null);
  const [noteFor, setNoteFor] = useState<Post | null>(null);
  const [saveTo, setSaveTo] = useState<Post | null>(null);

  const loadBoards = useCallback(
    () =>
      api.boards.mine().then(
        (r) => setBoards(r.items),
        (e) => {
          setBoards([]);
          toast(errorMessage(e));
        },
      ),
    [toast],
  );
  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  const load = useCallback((cursor?: string) => api.me.saved(filter, cursor), [filter]);
  const saves = usePaged(load, filter);
  const patch = (id: string, fn: (p: Post) => Post) => saves.setItems((cur) => cur?.map((p) => (p.id === id ? fn(p) : p)) ?? cur);

  const actions: MenuAction[] = options
    ? [
        { label: t('m.boards.saveTo'), icon: 'bookmark', onSelect: () => (setOptions(null), setSaveTo(options)) },
        {
          label: t(options.viewer.note ? 'm.saved.editNote' : 'm.saved.addNote'),
          icon: 'message',
          onSelect: () => (setOptions(null), setNoteFor(options)),
        },
        {
          label: t('m.post.unsave'),
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            const p = options;
            setOptions(null);
            try {
              await api.posts.unsave(p.id);
              saves.setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
              toast(t('saved.removedEverywhere'));
              void loadBoards();
            } catch (e) {
              toast(errorMessage(e));
            }
          },
        },
      ]
    : [];

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.saved.title')}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('saved.intro')}
      </p>

      <section className="stack-sm" aria-labelledby="boards-title">
        <h2 id="boards-title" className="section-title">
          {t('m.boards.title')}
        </h2>
        {boards === null ? <Skeleton height={180} /> : <BoardGrid boards={boards} label={t('boards.yourBoards')} onNew={() => setCreating(true)} />}
      </section>

      <section className="stack-sm" aria-labelledby="saves-title">
        <h2 id="saves-title" className="section-title">
          {t('saved.allSaves')}
        </h2>
        <Segments label={t('m.saved.filter')} value={filter} onChange={setFilter} options={savedFilterOptions(t)} />
        {saves.items === null ? (
          <Skeleton height={320} />
        ) : saves.items.length ? (
          <>
            <SaveGrid posts={saves.items} label={t('saved.savedPosts')} onOptions={setOptions} />
            <MoreButton cursor={saves.cursor} loading={saves.loadingMore} onMore={saves.more} />
          </>
        ) : (
          <EmptyState title={t(EMPTY[filter].title)} body={t(EMPTY[filter].body)} />
        )}
      </section>

      <SaveOptionsSheet post={options} actions={actions} onClose={() => setOptions(null)} />
      <NoteSheet post={noteFor} onClose={() => setNoteFor(null)} onSaved={(id, note) => patch(id, (x) => ({ ...x, viewer: { ...x.viewer, note } }))} />
      <SaveToSheet
        post={saveTo}
        onNote={(id, note) => patch(id, (x) => ({ ...x, viewer: { ...x.viewer, note } }))}
        onClose={() => {
          setSaveTo(null);
          void loadBoards();
        }}
      />
      <BoardEditor
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(b) => {
          setCreating(false);
          router.push(boardHref(b));
        }}
      />
    </div>
  );
}
