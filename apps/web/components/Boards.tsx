'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Avatar,
  AvatarGroup,
  BottomSheet,
  Button,
  EmptyState,
  Icon,
  List,
  ListItem,
  Select,
  Skeleton,
  TextField,
  type MenuAction,
} from '@yapilapi/design-system';
import {
  BOARD_DESCRIPTION_MAX,
  BOARD_NAME_MAX,
  BOARD_VISIBILITIES,
  SAVE_NOTE_MAX,
  type Board,
  type BoardVisibility,
  type Page,
  type Post,
  type SavedFilter,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Who can see a board, as the person choosing it reads it. */
export const VISIBILITY_LABEL: Record<BoardVisibility, string> = {
  private: 'Only you',
  shared: 'You and collaborators',
  public: 'Public on your profile',
};

/** Who can see a board, from where the viewer stands: the owner reads "Only you", others "Shared board". */
export function visibilityText(b: Board): string {
  if (b.role === 'owner') return VISIBILITY_LABEL[b.visibility];
  return b.visibility === 'public' ? 'Public board' : b.visibility === 'shared' ? 'Shared board' : 'Private board';
}

/** The small marker on a board card. Private boards don't need one. */
const VISIBILITY_MARK: Record<BoardVisibility, string | null> = { private: null, shared: 'Shared', public: 'Public' };

export const SAVED_FILTER_OPTIONS: { id: SavedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'photos', label: 'Photos' },
  { id: 'videos', label: 'Videos' },
  { id: 'text', label: 'Text' },
];

export const boardHref = (b: Pick<Board, 'id'>) => `/boards/${b.id}`;
export const postHref = (p: Post) => (p.format === 'reel' ? `/reels?start=${p.id}` : `/p/${p.id}`);
export const countPosts = (n: number) => (n === 1 ? '1 post' : `${n} posts`);

// The server rejects emoji in descriptions; say so before sending.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;

/** "12 posts · Shared", "3 posts · Invited". */
export function boardMeta(b: Board): string {
  const parts = [countPosts(b.itemCount)];
  if (b.role === 'invited') parts.push('Invited');
  else if (VISIBILITY_MARK[b.visibility]) parts.push(VISIBILITY_MARK[b.visibility]!);
  return parts.join(' · ');
}

/** A board's cover: the chosen (or first) post's picture, a snippet of its text, or an empty frame. */
export function BoardCover({ board }: { board: Board }) {
  const c = board.cover;
  const placeholder = c?.placeholder && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(c.placeholder) ? c.placeholder : null;
  if (c?.imageUrl)
    return (
      <span className="board-cover" aria-hidden style={placeholder ? { backgroundImage: `url(${placeholder})` } : undefined}>
        <img src={c.imageUrl} alt="" loading="lazy" />
      </span>
    );
  if (c?.text)
    return (
      <span className="board-cover board-cover--text" aria-hidden>
        <span dir="auto">{c.text.slice(0, 120)}</span>
      </span>
    );
  return (
    <span
      className="board-cover board-cover--empty"
      aria-hidden
      style={placeholder ? { backgroundImage: `url(${placeholder})`, backgroundSize: 'cover' } : undefined}
    >
      <Icon name="bookmark" size={28} />
    </span>
  );
}

/** A board in a grid: cover, name, how many posts, a Shared or Public marker, and who is on it. */
export function BoardCard({ board }: { board: Board }) {
  const others = board.role !== 'owner' && board.role !== null;
  const people = board.collaboratorCount;
  return (
    <Link
      href={boardHref(board)}
      className="board-card"
      aria-label={`${board.name}, ${boardMeta(board)}${others ? `, ${board.owner.displayName}'s board` : ''}`}
    >
      <span className="board-card__cover">
        <BoardCover board={board} />
        {board.visibility !== 'private' || board.role === 'invited' ? (
          <span className="board-card__mark">
            <Icon name={board.role === 'invited' ? 'bell' : board.visibility === 'public' ? 'globe' : 'users'} size={12} />
            {board.role === 'invited' ? 'Invited' : VISIBILITY_MARK[board.visibility]}
          </span>
        ) : null}
      </span>
      <span className="board-card__name" dir="auto">
        {board.name}
      </span>
      <span className="board-card__meta">
        {others || people ? (
          <AvatarGroup>
            <Avatar name={board.owner.displayName} src={board.owner.avatarUrl} size="sm" />
            {people ? (
              <span className="board-card__more" aria-hidden>
                +{people}
              </span>
            ) : null}
          </AvatarGroup>
        ) : null}
        <span>{countPosts(board.itemCount)}</span>
      </span>
    </Link>
  );
}

/** Boards as a grid of cards, with a "New board" card first when `onNew` is given. */
export function BoardGrid({ boards, onNew, label }: { boards: Board[]; onNew?: () => void; label: string }) {
  return (
    <ul className="board-grid" aria-label={label}>
      {onNew ? (
        <li>
          <button type="button" className="board-card board-card--new" onClick={onNew}>
            <span className="board-card__cover">
              <span className="board-cover board-cover--new" aria-hidden>
                <Icon name="plus" size={28} />
              </span>
            </span>
            <span className="board-card__name">New board</span>
            <span className="board-card__meta">Group your saves</span>
          </button>
        </li>
      ) : null}
      {boards.map((b) => (
        <li key={b.id}>
          <BoardCard board={b} />
        </li>
      ))}
    </ul>
  );
}

/** The public boards on a profile's Boards tab. */
export function ProfileBoards({ username, name, isSelf }: { username: string; name: string; isSelf: boolean }) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  useEffect(() => {
    setBoards(null);
    api.boards.forUser(username).then(
      (r) => setBoards(r.items),
      () => setBoards([]),
    );
  }, [username]);
  if (boards === null) return <Skeleton height={200} />;
  if (!boards.length)
    return (
      <EmptyState
        title="No public boards yet"
        body={isSelf ? 'Boards you make public show here. Your other boards stay in Saved.' : `${name} hasn't made any boards public.`}
        action={
          isSelf ? (
            <Link href="/saved" className="yp-btn yp-btn--secondary">
              Go to Saved
            </Link>
          ) : undefined
        }
      />
    );
  return <BoardGrid boards={boards} label={`${name}'s public boards`} />;
}

/**
 * Start or edit a board: name, a short description and who can see it. `postIds` go on a
 * new board straight away.
 */
export function BoardEditor({
  open,
  onClose,
  onSaved,
  board,
  postIds,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (b: Board) => void;
  board?: Board;
  postIds?: string[];
}) {
  const { toast } = useSession();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<BoardVisibility>('private');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(board?.name ?? '');
    setDescription(board?.description ?? '');
    setVisibility(board?.visibility ?? 'private');
  }, [open, board]);

  const emoji = EMOJI.test(description);
  return (
    <BottomSheet open={open} onClose={onClose} title={board ? 'Edit board' : 'New board'}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || emoji) return;
          setBusy(true);
          try {
            const body = { name: name.trim(), description: description.trim(), visibility };
            const r = board ? await api.boards.update(board.id, body) : await api.boards.create({ ...body, postIds });
            onSaved(r.board);
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label="Name"
          value={name}
          maxLength={BOARD_NAME_MAX}
          required
          placeholder="Recipes to try"
          onChange={(e) => setName(e.currentTarget.value)}
          hint={`${name.length}/${BOARD_NAME_MAX}`}
        />
        <TextField
          label="Description (optional)"
          multiline
          rows={2}
          value={description}
          maxLength={BOARD_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.currentTarget.value)}
          error={emoji ? 'Use words here, without emoji.' : undefined}
          hint={`${description.length}/${BOARD_DESCRIPTION_MAX}`}
        />
        <Select label="Who can see it" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as BoardVisibility)}>
          {BOARD_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABEL[v]}
            </option>
          ))}
        </Select>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {visibility === 'private'
            ? 'Only you can see this board. Inviting someone makes it shared.'
            : visibility === 'shared'
              ? 'You and the people you invite can see it and add to it.'
              : 'Anyone who can see your profile can see it, in the Boards tab. Collaborators can still add to it.'}
        </p>
        <Button type="submit" loading={busy} disabled={!name.trim() || emoji}>
          {board ? 'Save' : 'Create board'}
        </Button>
      </form>
    </BottomSheet>
  );
}

/**
 * "Save to a board": your boards you can add to, each with a check when this post is on it
 * (tap to add or take it off), a new board made with this post, and a private note on the save.
 * Adding to a board or writing a note saves the post too; `onSaved` hears about it.
 */
export function SaveToSheet({
  post,
  onClose,
  onSaved,
  onNote,
}: {
  post: Pick<Post, 'id'> | null;
  onClose: () => void;
  onSaved?: (postId: string) => void;
  /** The note was changed here. */
  onNote?: (postId: string, note: string) => void;
}) {
  const { toast } = useSession();
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const postId = post?.id ?? null;

  useEffect(() => {
    if (!postId) return;
    setBoards(null);
    setName('');
    setNote('');
    setSavedNote('');
    setSaved(false);
    api.boards.mine(postId).then(
      (r) => setBoards(r.items.filter((b) => b.canAdd)),
      (e) => {
        setBoards([]);
        toast(errorMessage(e));
      },
    );
    api.posts.saveState(postId).then(
      (s) => {
        setSaved(s.saved);
        setNote(s.note);
        setSavedNote(s.note);
      },
      () => {},
    );
  }, [postId, toast]);

  const markSaved = () => {
    if (!postId) return;
    setSaved(true);
    onSaved?.(postId);
  };

  async function toggle(b: Board) {
    if (!postId) return;
    setBusy(b.id);
    const on = !b.contains;
    try {
      if (on) await api.boards.addItem(b.id, postId);
      else await api.boards.removeItem(b.id, postId);
      setBoards((cur) => cur?.map((x) => (x.id === b.id ? { ...x, contains: on, itemCount: Math.max(0, x.itemCount + (on ? 1 : -1)) } : x)) ?? cur);
      if (on) markSaved();
      toast(on ? `Added to ${b.name}` : `Removed from ${b.name}`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <BottomSheet open={!!postId} onClose={onClose} title="Save to a board">
      <div className="stack">
        {boards === null ? (
          <Skeleton height={120} />
        ) : boards.length ? (
          <ul className="save-pick" aria-label="Your boards">
            {boards.map((b) => (
              <li key={b.id}>
                <button type="button" aria-pressed={!!b.contains} disabled={!!busy} onClick={() => toggle(b)}>
                  <span className="save-pick__cover">
                    <BoardCover board={b} />
                  </span>
                  <span className="save-pick__text">
                    <strong dir="auto">{b.name}</strong>
                    <span className="muted">
                      {b.role === 'collaborator' ? `${b.owner.displayName}'s board · ` : ''}
                      {boardMeta(b)}
                    </span>
                  </span>
                  <span className="save-pick__check" aria-hidden>
                    {b.contains ? <Icon name="check" size={18} /> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No boards yet. Start one with this post.
          </p>
        )}

        <form
          className="row"
          style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!postId || !name.trim()) return;
            setBusy('new');
            try {
              const { board } = await api.boards.create({ name: name.trim(), postIds: [postId] });
              setBoards((cur) => [{ ...board, contains: true }, ...(cur ?? [])]);
              setName('');
              markSaved();
              toast(`Added to ${board.name}`);
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <TextField
            label="New board"
            placeholder="Name it"
            value={name}
            maxLength={BOARD_NAME_MAX}
            className="save-pick__new"
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button type="submit" variant="secondary" loading={busy === 'new'} disabled={!name.trim() || !!busy}>
            Create
          </Button>
        </form>

        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!postId) return;
            setBusy('note');
            try {
              const r = await api.posts.setSaveNote(postId, note.trim());
              setNote(r.note);
              setSavedNote(r.note);
              markSaved();
              onNote?.(postId, r.note);
              toast(r.note ? 'Note saved' : 'Note removed');
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <TextField
            label="Private note"
            multiline
            rows={2}
            value={note}
            maxLength={SAVE_NOTE_MAX}
            placeholder="Why you saved it"
            hint={`Only you see this note. ${note.length}/${SAVE_NOTE_MAX}`}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {saved ? 'Saved' : 'Adding it to a board or writing a note saves it too.'}
            </span>
            <span className="row">
              <Button type="submit" size="sm" variant="secondary" loading={busy === 'note'} disabled={!!busy || note.trim() === savedNote}>
                Save note
              </Button>
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </span>
          </div>
        </form>
      </div>
    </BottomSheet>
  );
}

/** Write, change or clear your private note on a save. */
export function NoteSheet({ post, onClose, onSaved }: { post: Post | null; onClose: () => void; onSaved: (postId: string, note: string) => void }) {
  const { toast } = useSession();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (post) setNote(post.viewer.note ?? '');
  }, [post]);
  const submit = async (value: string) => {
    if (!post) return;
    setBusy(true);
    try {
      const r = await api.posts.setSaveNote(post.id, value.trim());
      onSaved(post.id, r.note);
      toast(r.note ? 'Note saved' : 'Note removed');
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open={!!post} onClose={onClose} title={post?.viewer.note ? 'Edit note' : 'Add a note'}>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(note);
        }}
      >
        <TextField
          label="Private note"
          multiline
          rows={3}
          value={note}
          maxLength={SAVE_NOTE_MAX}
          placeholder="Why you saved it"
          hint={`Only you see this note. ${note.length}/${SAVE_NOTE_MAX}`}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <div className="row">
          <Button type="submit" loading={busy}>
            Save note
          </Button>
          {post?.viewer.note ? (
            <Button variant="ghost" disabled={busy} onClick={() => submit('')}>
              Remove note
            </Button>
          ) : null}
        </div>
      </form>
    </BottomSheet>
  );
}

/** A list of actions for one save, as a sheet (tiles are too small for a dropdown menu). */
export function SaveOptionsSheet({ post, actions, onClose }: { post: Post | null; actions: MenuAction[]; onClose: () => void }) {
  return (
    <BottomSheet open={!!post} onClose={onClose} title={post ? tileTitle(post) : 'Options'}>
      <List label="Options">
        {actions.map((a) => (
          <ListItem
            key={a.label}
            onClick={a.onSelect}
            start={a.icon ? <Icon name={a.icon} /> : undefined}
            primary={a.danger ? <span className="save-options__danger">{a.label}</span> : a.label}
          />
        ))}
      </List>
    </BottomSheet>
  );
}

/** "Photo by Ada", "Reel by Ada", "Post by Ada". */
export function tileTitle(p: Post): string {
  const m = p.media.find((x) => x.kind !== 'audio');
  const kind = p.locked ? 'Post for subscribers' : p.format === 'reel' ? 'Reel' : m?.kind === 'video' ? 'Video' : m ? 'Photo' : 'Post';
  return `${kind} by ${p.author.displayName}`;
}

const tileLabel = (p: Post, n = 80) => `${tileTitle(p)}${p.body && !p.locked ? `: ${p.body.slice(0, n)}` : ''}`;
/** Short enough to repeat on every button of a tile, long enough to tell two posts by one person apart. */
export const tileShortLabel = (p: Post) => tileLabel(p, 32);

function TileMedia({ post }: { post: Post }) {
  if (post.locked) {
    const ph = post.locked.placeholder;
    const bg = ph && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(ph) ? { backgroundImage: `url(${ph})` } : undefined;
    return (
      <span className="save-tile__lock" style={bg}>
        <Icon name="lock" size={22} />
        <span>For subscribers</span>
      </span>
    );
  }
  const visual = post.media.filter((x) => x.kind !== 'audio');
  const m = visual[0];
  if (m) {
    const src = m.kind === 'image' ? (m.variants?.medium ?? m.variants?.thumb ?? m.url) : m.posterUrl;
    return (
      <>
        {src ? (
          <img src={src} alt="" loading="lazy" className={m.sensitive ? 'yp-blurred' : undefined} />
        ) : (
          <video src={m.variants?.mp4 ?? m.url} muted playsInline preload="metadata" aria-hidden className={m.sensitive ? 'yp-blurred' : undefined} />
        )}
        {m.sensitive ? (
          <span className="save-tile__badge save-tile__badge--start">
            <Icon name="eye" size={12} />
            Sensitive
          </span>
        ) : null}
        {m.kind === 'video' || post.format === 'reel' ? (
          <span className="save-tile__badge">
            <Icon name="play" size={12} filled />
            {post.format === 'reel' ? 'Reel' : 'Video'}
          </span>
        ) : visual.length > 1 ? (
          <span className="save-tile__badge">
            <Icon name="image" size={12} />
            {visual.length}
          </span>
        ) : null}
      </>
    );
  }
  return (
    <span className="save-tile__text" dir="auto">
      {post.body ? post.body.slice(0, 160) : post.poll ? 'Poll' : 'Post'}
    </span>
  );
}

/**
 * Saved posts and reels as a grid of tiles, each opening the post (reels in the Reels player),
 * with your private note underneath. `onOptions` adds an options button per tile. In
 * `arrange` mode each tile gets Move earlier and Move later buttons instead.
 */
export function SaveGrid({
  posts,
  label,
  onOptions,
  arrange,
}: {
  posts: Post[];
  label: string;
  onOptions?: (p: Post) => void;
  arrange?: { onMove: (index: number, by: -1 | 1) => void };
}) {
  return (
    <ul className="save-grid" aria-label={label}>
      {posts.map((p, i) => (
        <li key={p.id} className="save-tile">
          <Link href={postHref(p)} className="save-tile__media" aria-label={tileLabel(p)}>
            <TileMedia post={p} />
          </Link>
          {arrange ? (
            <span className="save-tile__arrange" role="group" aria-label={`${tileShortLabel(p)}, position ${i + 1} of ${posts.length}`}>
              <Button
                size="sm"
                variant="secondary"
                data-move={`${p.id}:-1`}
                disabled={i === 0}
                aria-label={`Move ${tileShortLabel(p)} earlier`}
                onClick={() => arrange.onMove(i, -1)}
              >
                Earlier
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-move={`${p.id}:1`}
                disabled={i === posts.length - 1}
                aria-label={`Move ${tileShortLabel(p)} later`}
                onClick={() => arrange.onMove(i, 1)}
              >
                Later
              </Button>
            </span>
          ) : p.viewer.note || onOptions ? (
            <span className="save-tile__foot">
              {p.viewer.note ? (
                <p className="save-tile__note" dir="auto">
                  <span className="yp-visually-hidden">Your note: </span>
                  {p.viewer.note}
                </p>
              ) : (
                <span />
              )}
              {onOptions ? (
                <button type="button" className="yp-action save-tile__more" aria-label={`Options for ${tileShortLabel(p)}`} onClick={() => onOptions(p)}>
                  <Icon name="more" />
                </button>
              ) : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A cursor-paged list for grids: the first page when `key` changes, the next one when the
 * reader nears the end (or presses "Show more").
 */
export function usePaged(load: (cursor?: string) => Promise<Page<Post>>, key: string) {
  const { toast } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    let live = true;
    setItems(null);
    loadRef.current().then(
      (p) => {
        if (!live) return;
        setItems(p.items);
        setCursor(p.nextCursor);
      },
      (e) => {
        if (!live) return;
        setItems([]);
        setCursor(null);
        toast(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [toast]);

  useEffect(() => reload(), [key, reload]);

  const more = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const p = await loadRef.current(cursor);
      setItems((cur) => [...(cur ?? []), ...p.items.filter((x) => !cur?.some((c) => c.id === x.id))]);
      setCursor(p.nextCursor);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, toast]);

  return { items, setItems, cursor, more, loadingMore, reload };
}

/** "Show more" under a grid, which also loads by itself as the reader nears it. */
export function MoreButton({ cursor, loading, onMore }: { cursor: string | null; loading: boolean; onMore: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && onMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, onMore]);
  if (!cursor) return null;
  return (
    <>
      <div ref={sentinel} />
      <Button variant="secondary" loading={loading} onClick={onMore}>
        Show more
      </Button>
    </>
  );
}
