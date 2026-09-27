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
  type MessageKey,
  type Page,
  type Post,
  type SavedFilter,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** The session's translators, for helpers used outside a component. */
type Tr = Pick<ReturnType<typeof useSession>, 't' | 'tp'>;
type T = Tr['t'];

/** Who can see a board, as the person choosing it reads it. */
export const VISIBILITY_LABEL: Record<BoardVisibility, MessageKey> = {
  private: 'm.boards.visibility.private',
  shared: 'm.boards.visibility.shared',
  public: 'm.boards.visibility.public',
};

/** Who can see a board, from where the viewer stands: the owner reads "Only you", others "Shared board". */
export function visibilityText(b: Board, t: T): string {
  if (b.role === 'owner') return t(VISIBILITY_LABEL[b.visibility]);
  return t(b.visibility === 'public' ? 'boards.publicBoard' : b.visibility === 'shared' ? 'boards.sharedBoard' : 'boards.privateBoard');
}

/** The small marker on a board card. Private boards don't need one. */
const VISIBILITY_MARK: Record<BoardVisibility, MessageKey | null> = { private: null, shared: 'm.boards.marker.shared', public: 'm.boards.marker.public' };

const SAVED_FILTER_LABEL: Record<SavedFilter, MessageKey> = {
  all: 'm.saved.filter.all',
  photos: 'm.saved.filter.photos',
  videos: 'm.saved.filter.videos',
  text: 'm.saved.filter.text',
};
export const savedFilterOptions = (t: T): { id: SavedFilter; label: string }[] =>
  (Object.keys(SAVED_FILTER_LABEL) as SavedFilter[]).map((id) => ({ id, label: t(SAVED_FILTER_LABEL[id]) }));

export const boardHref = (b: Pick<Board, 'id'>) => `/boards/${b.id}`;
export const postHref = (p: Post) => (p.format === 'reel' ? `/reels?start=${p.id}` : `/p/${p.id}`);
export const countPosts = (n: number, { tp }: Tr) => tp('m.boards.items', n);

// The server rejects emoji in descriptions; say so before sending.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;

/** "12 posts · Shared", "3 posts · Invited". */
export function boardMeta(b: Board, tr: Tr): string {
  const parts = [countPosts(b.itemCount, tr)];
  const mark = b.role === 'invited' ? 'm.boards.marker.invited' : VISIBILITY_MARK[b.visibility];
  if (mark) parts.push(tr.t(mark));
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
  const tr = useSession();
  const { t } = tr;
  const others = board.role !== 'owner' && board.role !== null;
  const people = board.collaboratorCount;
  const mark = board.role === 'invited' ? 'm.boards.marker.invited' : VISIBILITY_MARK[board.visibility];
  const meta = boardMeta(board, tr);
  return (
    <Link
      href={boardHref(board)}
      className="board-card"
      aria-label={
        others ? t('boards.cardLabelOwner', { name: board.name, meta, owner: board.owner.displayName }) : t('boards.cardLabel', { name: board.name, meta })
      }
    >
      <span className="board-card__cover">
        <BoardCover board={board} />
        {mark ? (
          <span className="board-card__mark">
            <Icon name={board.role === 'invited' ? 'bell' : board.visibility === 'public' ? 'globe' : 'users'} size={12} />
            {t(mark)}
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
        <span>{countPosts(board.itemCount, tr)}</span>
      </span>
    </Link>
  );
}

/** Boards as a grid of cards, with a "New board" card first when `onNew` is given. */
export function BoardGrid({ boards, onNew, label }: { boards: Board[]; onNew?: () => void; label: string }) {
  const { t } = useSession();
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
            <span className="board-card__name">{t('m.boards.new')}</span>
            <span className="board-card__meta">{t('boards.groupSaves')}</span>
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
  const { t } = useSession();
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
        title={t('boards.publicNone')}
        body={isSelf ? t('boards.publicNoneSelf') : t('boards.publicNoneOther', { name })}
        action={
          isSelf ? (
            <Link href="/saved" className="yp-btn yp-btn--secondary">
              {t('boards.goToSaved')}
            </Link>
          ) : undefined
        }
      />
    );
  return <BoardGrid boards={boards} label={t('boards.publicBoardsOf', { name })} />;
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
  const { toast, t } = useSession();
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
    <BottomSheet open={open} onClose={onClose} title={t(board ? 'm.boards.edit' : 'm.boards.new')}>
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
          label={t('m.boards.nameLabel')}
          value={name}
          maxLength={BOARD_NAME_MAX}
          required
          placeholder={t('boards.namePlaceholder')}
          onChange={(e) => setName(e.currentTarget.value)}
          hint={`${name.length}/${BOARD_NAME_MAX}`}
        />
        <TextField
          label={t('boards.descriptionOptional')}
          multiline
          rows={2}
          value={description}
          maxLength={BOARD_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.currentTarget.value)}
          error={emoji ? t('m.boards.noEmoji') : undefined}
          hint={`${description.length}/${BOARD_DESCRIPTION_MAX}`}
        />
        <Select label={t('m.boards.visibilityLabel')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as BoardVisibility)}>
          {BOARD_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {t(VISIBILITY_LABEL[v])}
            </option>
          ))}
        </Select>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t(visibility === 'private' ? 'boards.privateHint' : visibility === 'shared' ? 'boards.sharedHint' : 'boards.publicHint')}
        </p>
        <Button type="submit" loading={busy} disabled={!name.trim() || emoji}>
          {t(board ? 'common.save' : 'm.boards.create')}
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
  const tr = useSession();
  const { toast, t } = tr;
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
      toast(t(on ? 'boards.addedTo' : 'boards.removedFrom', { name: b.name }));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <BottomSheet open={!!postId} onClose={onClose} title={t('m.boards.saveTo')}>
      <div className="stack">
        {boards === null ? (
          <Skeleton height={120} />
        ) : boards.length ? (
          <ul className="save-pick" aria-label={t('boards.yourBoards')}>
            {boards.map((b) => (
              <li key={b.id}>
                <button type="button" aria-pressed={!!b.contains} disabled={!!busy} onClick={() => toggle(b)}>
                  <span className="save-pick__cover">
                    <BoardCover board={b} />
                  </span>
                  <span className="save-pick__text">
                    <strong dir="auto">{b.name}</strong>
                    <span className="muted">
                      {b.role === 'collaborator' ? `${t('boards.ownersBoard', { name: b.owner.displayName })} · ` : ''}
                      {boardMeta(b, tr)}
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
            {t('boards.noneStartOne')}
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
              toast(t('boards.addedTo', { name: board.name }));
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <TextField
            label={t('m.boards.newLabel')}
            placeholder={t('boards.nameIt')}
            value={name}
            maxLength={BOARD_NAME_MAX}
            className="save-pick__new"
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button type="submit" variant="secondary" loading={busy === 'new'} disabled={!name.trim() || !!busy}>
            {t('m.chapters.create')}
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
              toast(t(r.note ? 'boards.noteSaved' : 'boards.noteRemoved'));
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <TextField
            label={t('m.saved.noteLabel')}
            multiline
            rows={2}
            value={note}
            maxLength={SAVE_NOTE_MAX}
            placeholder={t('boards.notePlaceholder')}
            hint={t('boards.noteHint', { length: note.length, max: SAVE_NOTE_MAX })}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {t(saved ? 'common.saved' : 'boards.savesToo')}
            </span>
            <span className="row">
              <Button type="submit" size="sm" variant="secondary" loading={busy === 'note'} disabled={!!busy || note.trim() === savedNote}>
                {t('m.saved.saveNote')}
              </Button>
              <Button size="sm" onClick={onClose}>
                {t('m.common.done')}
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
  const { toast, t } = useSession();
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
      toast(t(r.note ? 'boards.noteSaved' : 'boards.noteRemoved'));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open={!!post} onClose={onClose} title={t(post?.viewer.note ? 'm.saved.editNote' : 'm.saved.addNote')}>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(note);
        }}
      >
        <TextField
          label={t('m.saved.noteLabel')}
          multiline
          rows={3}
          value={note}
          maxLength={SAVE_NOTE_MAX}
          placeholder={t('boards.notePlaceholder')}
          hint={t('boards.noteHint', { length: note.length, max: SAVE_NOTE_MAX })}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <div className="row">
          <Button type="submit" loading={busy}>
            {t('m.saved.saveNote')}
          </Button>
          {post?.viewer.note ? (
            <Button variant="ghost" disabled={busy} onClick={() => submit('')}>
              {t('boards.removeNote')}
            </Button>
          ) : null}
        </div>
      </form>
    </BottomSheet>
  );
}

/** A list of actions for one save, as a sheet (tiles are too small for a dropdown menu). */
export function SaveOptionsSheet({ post, actions, onClose }: { post: Post | null; actions: MenuAction[]; onClose: () => void }) {
  const { t } = useSession();
  return (
    <BottomSheet open={!!post} onClose={onClose} title={post ? tileTitle(post, t) : t('boards.options')}>
      <List label={t('boards.options')}>
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
export function tileTitle(p: Post, t: T): string {
  const m = p.media.find((x) => x.kind !== 'audio');
  const key: MessageKey = p.locked
    ? 'boards.tile.locked'
    : p.format === 'reel'
      ? 'boards.tile.reel'
      : m?.kind === 'video'
        ? 'boards.tile.video'
        : m
          ? 'boards.tile.photo'
          : 'm.post.by';
  return t(key, { name: p.author.displayName });
}

const tileLabel = (p: Post, t: T, n = 80) =>
  p.body && !p.locked ? t('boards.tile.withText', { title: tileTitle(p, t), text: p.body.slice(0, n) }) : tileTitle(p, t);
/** Short enough to repeat on every button of a tile, long enough to tell two posts by one person apart. */
export const tileShortLabel = (p: Post, t: T) => tileLabel(p, t, 32);

function TileMedia({ post }: { post: Post }) {
  const { t } = useSession();
  if (post.locked) {
    const ph = post.locked.placeholder;
    const bg = ph && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(ph) ? { backgroundImage: `url(${ph})` } : undefined;
    return (
      <span className="save-tile__lock" style={bg}>
        <Icon name="lock" size={22} />
        <span>{t('post.locked.title')}</span>
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
            {t('boards.sensitive')}
          </span>
        ) : null}
        {m.kind === 'video' || post.format === 'reel' ? (
          <span className="save-tile__badge">
            <Icon name="play" size={12} filled />
            {t(post.format === 'reel' ? 'm.create.mode.reel' : 'm.create.video')}
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
      {post.body ? post.body.slice(0, 160) : t(post.poll ? 'm.sticker.kind.poll' : 'm.create.mode.post')}
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
  const { t } = useSession();
  return (
    <ul className="save-grid" aria-label={label}>
      {posts.map((p, i) => (
        <li key={p.id} className="save-tile">
          <Link href={postHref(p)} className="save-tile__media" aria-label={tileLabel(p, t)}>
            <TileMedia post={p} />
          </Link>
          {arrange ? (
            <span
              className="save-tile__arrange"
              role="group"
              aria-label={t('boards.tilePosition', { title: tileShortLabel(p, t), index: i + 1, total: posts.length })}
            >
              <Button
                size="sm"
                variant="secondary"
                data-move={`${p.id}:-1`}
                disabled={i === 0}
                aria-label={t('boards.moveEarlierLabel', { title: tileShortLabel(p, t) })}
                onClick={() => arrange.onMove(i, -1)}
              >
                {t('boards.earlier')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-move={`${p.id}:1`}
                disabled={i === posts.length - 1}
                aria-label={t('boards.moveLaterLabel', { title: tileShortLabel(p, t) })}
                onClick={() => arrange.onMove(i, 1)}
              >
                {t('boards.later')}
              </Button>
            </span>
          ) : p.viewer.note || onOptions ? (
            <span className="save-tile__foot">
              {p.viewer.note ? (
                <p className="save-tile__note" dir="auto">
                  <span className="yp-visually-hidden">{t('boards.yourNote')} </span>
                  {p.viewer.note}
                </p>
              ) : (
                <span />
              )}
              {onOptions ? (
                <button
                  type="button"
                  className="yp-action save-tile__more"
                  aria-label={t('boards.optionsFor', { title: tileShortLabel(p, t) })}
                  onClick={() => onOptions(p)}
                >
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
  const { t } = useSession();
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
        {t('boards.showMore')}
      </Button>
    </>
  );
}
