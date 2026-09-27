'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Avatar,
  AvatarGroup,
  Badge,
  BottomSheet,
  Button,
  EmptyState,
  joinNames,
  List,
  ListItem,
  Segments,
  Skeleton,
  type MenuAction,
} from '@yapilapi/design-system';
import { BOARD_COLLABORATORS_MAX, type BoardDetail, type Post, type PublicUser, type SavedFilter } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PeoplePicker } from '@/components/PeoplePicker';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import {
  BoardCover,
  BoardEditor,
  MoreButton,
  NoteSheet,
  SAVED_FILTER_OPTIONS,
  SaveGrid,
  SaveOptionsSheet,
  SaveToSheet,
  visibilityText,
  countPosts,
  tileShortLabel,
  usePaged,
} from '@/components/Boards';
import { useSession } from '../../../providers';

/**
 * A board: its cover, name, description, who can see it, the owner and collaborators, and its
 * posts in the board's order. The owner edits it, picks the cover, invites and removes
 * collaborators, and deletes it (the saves stay). Collaborators add, arrange and leave; an
 * invited person accepts or declines. Anyone can view a public board, even without an account.
 */
export default function BoardPage() {
  const { id } = useParams<{ id: string }>();
  const { me, toast } = useSession();
  const router = useRouter();
  const [detail, setDetail] = useState<BoardDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [filter, setFilter] = useState<SavedFilter>('all');
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState(false);
  const [options, setOptions] = useState<Post | null>(null);
  const [noteFor, setNoteFor] = useState<Post | null>(null);
  const [saveTo, setSaveTo] = useState<Post | null>(null);
  // Arrange mode: every post you can see on the board, in the order you're making.
  const [order, setOrder] = useState<Post[] | null>(null);
  const [arranging, setArranging] = useState<'loading' | 'saving' | null>(null);
  const [moved, setMoved] = useState('');
  const refocus = useRef<string | null>(null);

  const loadDetail = useCallback(
    () =>
      api.boards.get(id).then(
        (d) => setDetail(d),
        () => setMissing(true),
      ),
    [id],
  );
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // Posts the viewer may take off: the owner any, a collaborator the ones they added.
  const [removable, setRemovable] = useState<Set<string>>(new Set());
  const load = useCallback(
    async (cursor?: string) => {
      const page = await api.boards.items(id, filter, cursor);
      setRemovable((cur) => {
        const next = cursor ? new Set(cur) : new Set<string>();
        page.removable?.forEach((pid) => next.add(pid));
        return next;
      });
      return page;
    },
    [id, filter],
  );
  const items = usePaged(load, `${id}-${filter}`);
  const patch = (pid: string, fn: (p: Post) => Post) => items.setItems((cur) => cur?.map((p) => (p.id === pid ? fn(p) : p)) ?? cur);

  // After a move, keep focus on the button that was pressed (or its partner at either end).
  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    const [pid, by] = key.split(':');
    const btn = document.querySelector<HTMLButtonElement>(`[data-move="${pid}:${by}"]`);
    const other = document.querySelector<HTMLButtonElement>(`[data-move="${pid}:${by === '1' ? '-1' : '1'}"]`);
    (btn && !btn.disabled ? btn : other)?.focus();
  }, [order]);

  if (missing)
    return me ? (
      <div className="yp-shell__inner">
        <EmptyState
          title="This board isn't available"
          body="It may have been deleted, or it may be private."
          action={
            <Link href="/saved" className="yp-btn yp-btn--secondary">
              Go to Saved
            </Link>
          }
        />
      </div>
    ) : (
      <NeedsAccount title="Sign in to see this board" body="Private and shared boards are only visible to the people on them." />
    );
  if (!detail)
    return (
      <div className="yp-shell__inner">
        <Skeleton height={120} />
        <Skeleton height={320} />
      </div>
    );

  const { board, collaborators } = detail;
  const owner = board.role === 'owner';
  const member = owner || board.role === 'collaborator';
  const accepted = collaborators.filter((c) => c.status === 'accepted');

  const act = (fn: () => Promise<unknown>, done?: string, after?: () => void) => async () => {
    try {
      await fn();
      if (done) toast(done);
      if (after) after();
      else await loadDetail();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  async function startArrange() {
    setArranging('loading');
    try {
      const all: Post[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.boards.items(id, 'all', cursor);
        all.push(...page.items.filter((p) => !all.some((x) => x.id === p.id)));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      setFilter('all');
      setOrder(all);
      setMoved('');
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setArranging(null);
    }
  }

  function move(i: number, by: -1 | 1) {
    if (!order) return;
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    refocus.current = `${order[i]!.id}:${by}`;
    setOrder(next);
    setMoved(`${tileShortLabel(order[i]!)} moved to position ${j + 1} of ${next.length}`);
  }

  async function saveOrder() {
    if (!order) return;
    setArranging('saving');
    try {
      await api.boards.reorder(
        id,
        order.map((p) => p.id),
      );
      toast('Order saved');
      setOrder(null);
      setMoved('');
      items.reload();
      await loadDetail();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setArranging(null);
    }
  }

  const actions: MenuAction[] = options
    ? [
        ...(me
          ? [
              { label: 'Save to a board', icon: 'bookmark' as const, onSelect: () => (setOptions(null), setSaveTo(options)) },
              {
                label: options.viewer.note ? 'Edit note' : 'Add a note',
                icon: 'message' as const,
                onSelect: () => (setOptions(null), setNoteFor(options)),
              },
            ]
          : []),
        ...(owner && board.coverPostId !== options.id
          ? [
              {
                label: 'Use as cover',
                icon: 'image' as const,
                onSelect: () => {
                  setOptions(null);
                  void act(() => api.boards.update(board.id, { coverPostId: options.id }), 'Cover changed')();
                },
              },
            ]
          : []),
        ...(member && removable.has(options.id)
          ? [
              {
                label: 'Remove from board',
                icon: 'trash' as const,
                danger: true,
                onSelect: () => {
                  const p = options;
                  setOptions(null);
                  void act(
                    () => api.boards.removeItem(board.id, p.id),
                    'Removed from the board. It stays in your saves.',
                    () => {
                      items.setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
                      void loadDetail();
                    },
                  )();
                },
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="yp-shell__inner">
      <div className="board-hero">
        <span className="board-hero__cover">
          <BoardCover board={board} />
        </span>
        <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
          <h1 dir="auto">{board.name}</h1>
          <span className="muted">
            By <Link href={`/u/${board.owner.username}`}>{board.owner.displayName}</Link> · {countPosts(board.itemCount)}
          </span>
          <span className="row">
            <Badge tone="neutral">{visibilityText(board)}</Badge>
          </span>
        </div>
      </div>
      {board.description ? (
        <p dir="auto" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {board.description}
        </p>
      ) : null}

      {board.role === 'invited' ? (
        <div className="board-banner" role="group" aria-label="Invitation">
          <span>
            <bdi>{board.owner.displayName}</bdi> invited you to add to this board.
          </span>
          <span className="row">
            <Button size="sm" onClick={act(() => api.boards.join(board.id), 'You can add to this board now')}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={act(
                () => api.boards.leave(board.id),
                'Invitation declined',
                () => router.push('/saved'),
              )}
            >
              Decline
            </Button>
          </span>
        </div>
      ) : null}

      {accepted.length || owner ? (
        <div className="row board-people">
          {accepted.length ? (
            <>
              <AvatarGroup>
                {accepted.slice(0, 5).map((c) => (
                  <Avatar key={c.user.id} name={c.user.displayName} src={c.user.avatarUrl} size="sm" />
                ))}
              </AvatarGroup>
              <span className="muted">
                With {joinNames(accepted.slice(0, 3).map((c) => (c.user.id === me?.id ? { ...c.user, displayName: 'you' } : c.user)))}
                {accepted.length > 3 ? ` and ${accepted.length - 3} more` : ''}
              </span>
            </>
          ) : collaborators.length ? (
            <span className="muted">Waiting for {joinNames(collaborators.map((c) => c.user))} to accept.</span>
          ) : (
            <span className="muted">Just you so far.</span>
          )}
        </div>
      ) : null}

      {order ? (
        <div className="board-banner" role="group" aria-label="Arrange">
          <span>Move posts earlier or later, then save the order.</span>
          <span className="row">
            <Button size="sm" loading={arranging === 'saving'} onClick={saveOrder}>
              Save order
            </Button>
            <Button size="sm" variant="ghost" disabled={arranging === 'saving'} onClick={() => (setOrder(null), setMoved(''))}>
              Cancel
            </Button>
          </span>
        </div>
      ) : member ? (
        <div className="row">
          {owner ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="secondary" size="sm" icon="users" onClick={() => setPeople(true)}>
                {collaborators.length ? 'Collaborators' : 'Invite'}
              </Button>
            </>
          ) : null}
          {board.itemCount > 1 ? (
            <Button variant="secondary" size="sm" loading={arranging === 'loading'} onClick={startArrange}>
              Arrange
            </Button>
          ) : null}
          {owner && board.coverPostId ? (
            <Button variant="ghost" size="sm" onClick={act(() => api.boards.update(board.id, { coverPostId: null }), 'The first post is the cover now')}>
              Use first post as cover
            </Button>
          ) : null}
          {owner ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!confirm('Delete this board? The posts stay in your Saved.')) return;
                try {
                  await api.boards.remove(board.id);
                  toast('Board deleted. The posts are still in your Saved.');
                  router.push('/saved');
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              Delete
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={act(
                () => api.boards.leave(board.id),
                'You left the board',
                () => router.push('/saved'),
              )}
            >
              Leave
            </Button>
          )}
        </div>
      ) : null}

      <p className="yp-visually-hidden" role="status">
        {moved}
      </p>

      {order ? (
        <SaveGrid posts={order} label="Posts on this board, arranging" arrange={{ onMove: move }} />
      ) : (
        <>
          <Segments label="Show" value={filter} onChange={setFilter} options={SAVED_FILTER_OPTIONS} />
          {items.items === null ? (
            <Skeleton height={320} />
          ) : items.items.length ? (
            <>
              <SaveGrid posts={items.items} label="Posts on this board" onOptions={me ? setOptions : undefined} />
              <MoreButton cursor={items.cursor} loading={items.loadingMore} onMore={items.more} />
            </>
          ) : (
            <EmptyState
              title={filter === 'all' ? 'No posts on this board yet' : 'Nothing like that here'}
              body={
                filter !== 'all'
                  ? 'Try another filter.'
                  : board.canAdd
                    ? 'Add posts with "Save to a board" in any post\'s menu, or press and hold its save button.'
                    : undefined
              }
            />
          )}
        </>
      )}

      {!me ? <JoinNote text="Join YAPILAPI to save posts and make boards of your own." /> : null}

      <SaveOptionsSheet post={options} actions={actions} onClose={() => setOptions(null)} />
      <NoteSheet post={noteFor} onClose={() => setNoteFor(null)} onSaved={(pid, note) => patch(pid, (x) => ({ ...x, viewer: { ...x.viewer, note } }))} />
      <SaveToSheet
        post={saveTo}
        onNote={(pid, note) => patch(pid, (x) => ({ ...x, viewer: { ...x.viewer, note } }))}
        onClose={() => {
          setSaveTo(null);
          void loadDetail();
        }}
      />
      {owner ? (
        <>
          <BoardEditor
            open={editing}
            board={board}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              toast('Saved');
              void loadDetail();
            }}
          />
          <CollaboratorsSheet
            open={people}
            boardId={board.id}
            detail={detail}
            onClose={() => setPeople(false)}
            onChanged={(d) => (d ? setDetail(d) : void loadDetail())}
          />
        </>
      ) : null}
    </div>
  );
}

/** The owner invites friends (or mutual follows) to add to the board, cancels invites and removes collaborators. */
function CollaboratorsSheet({
  open,
  boardId,
  detail,
  onClose,
  onChanged,
}: {
  open: boolean;
  boardId: string;
  detail: BoardDetail;
  onClose: () => void;
  onChanged: (d?: BoardDetail) => void;
}) {
  const { toast } = useSession();
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const room = BOARD_COLLABORATORS_MAX - detail.collaborators.length;
  useEffect(() => {
    if (!open) setPicked([]);
  }, [open]);

  return (
    <BottomSheet open={open} onClose={onClose} title="Collaborators">
      <div className="stack">
        {detail.collaborators.length ? (
          <List label="Collaborators">
            {detail.collaborators.map(({ user, status }) => (
              <ListItem
                key={user.id}
                start={<Avatar name={user.displayName} src={user.avatarUrl} size="sm" />}
                primary={user.displayName}
                secondary={status === 'invited' ? 'Invited, not answered yet' : 'Can add and arrange posts'}
                end={
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === user.id}
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(user.id);
                      try {
                        await api.boards.removeCollaborator(boardId, user.id);
                        toast(status === 'invited' ? 'Invite cancelled' : `${user.displayName} is off the board`);
                        onChanged();
                      } catch (e) {
                        toast(errorMessage(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {status === 'invited' ? 'Cancel invite' : 'Remove'}
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No collaborators yet. They can add posts to the board and arrange them.
          </p>
        )}
        {room > 0 ? (
          <>
            <PeoplePicker
              label="Invite people"
              hint={`Friends, and people you follow who follow you back. ${detail.board.visibility === 'private' ? 'Inviting someone makes this board shared.' : ''}`}
              scope="mutuals"
              max={room}
              canPick={() => true}
              exclude={detail.collaborators.map((c) => c.user.id)}
              picked={picked}
              onChange={setPicked}
            />
            <Button
              disabled={!picked.length || !!busy}
              loading={busy === 'invite'}
              onClick={async () => {
                setBusy('invite');
                let last: BoardDetail | undefined;
                const failed: PublicUser[] = [];
                for (const u of picked) {
                  try {
                    last = await api.boards.invite(boardId, u.id);
                  } catch (e) {
                    failed.push(u);
                    toast(`${u.displayName}: ${errorMessage(e)}`);
                  }
                }
                setPicked(failed);
                if (last) {
                  onChanged(last);
                  if (!failed.length) toast(picked.length === 1 ? 'Invite sent' : 'Invites sent');
                }
                setBusy(null);
              }}
            >
              Send {picked.length === 1 ? 'invite' : 'invites'}
            </Button>
          </>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            A board can have up to {BOARD_COLLABORATORS_MAX} collaborators.
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
