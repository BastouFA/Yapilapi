'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Segments, Skeleton, type MenuAction } from '@yapilapi/design-system';
import type { Board, Post, SavedFilter } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import {
  BoardEditor,
  BoardGrid,
  MoreButton,
  NoteSheet,
  SAVED_FILTER_OPTIONS,
  SaveGrid,
  SaveOptionsSheet,
  SaveToSheet,
  boardHref,
  usePaged,
} from '@/components/Boards';
import { useSession } from '../../providers';

const EMPTY: Record<SavedFilter, { title: string; body: string }> = {
  all: { title: 'Nothing saved yet', body: 'Tap the bookmark on any post or reel to keep it here. Only you can see what you save.' },
  photos: { title: 'No saved photos', body: 'Photos you save show up here.' },
  videos: { title: 'No saved videos', body: 'Videos and reels you save show up here.' },
  text: { title: 'No saved text posts', body: 'Posts without photos or videos that you save show up here.' },
};

/**
 * Saved: your boards (and the ones you collaborate on), then everything you saved, newest
 * first, with a filter. Only you see your saves and your notes on them.
 */
export default function SavedPage() {
  const { toast } = useSession();
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
        { label: 'Save to a board', icon: 'bookmark', onSelect: () => (setOptions(null), setSaveTo(options)) },
        { label: options.viewer.note ? 'Edit note' : 'Add a note', icon: 'message', onSelect: () => (setOptions(null), setNoteFor(options)) },
        {
          label: 'Remove from saved',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            const p = options;
            setOptions(null);
            try {
              await api.posts.unsave(p.id);
              saves.setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
              toast('Removed from saved and from your boards');
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
        <h1>Saved</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Only you can see what you save and your notes. Group saves into boards, and share a board with friends or on your profile if you like.
      </p>

      <section className="stack-sm" aria-labelledby="boards-title">
        <h2 id="boards-title" className="section-title">
          Boards
        </h2>
        {boards === null ? <Skeleton height={180} /> : <BoardGrid boards={boards} label="Your boards" onNew={() => setCreating(true)} />}
      </section>

      <section className="stack-sm" aria-labelledby="saves-title">
        <h2 id="saves-title" className="section-title">
          All saves
        </h2>
        <Segments label="Show" value={filter} onChange={setFilter} options={SAVED_FILTER_OPTIONS} />
        {saves.items === null ? (
          <Skeleton height={320} />
        ) : saves.items.length ? (
          <>
            <SaveGrid posts={saves.items} label="Saved posts" onOptions={setOptions} />
            <MoreButton cursor={saves.cursor} loading={saves.loadingMore} onMore={saves.more} />
          </>
        ) : (
          <EmptyState title={EMPTY[filter].title} body={EMPTY[filter].body} />
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
