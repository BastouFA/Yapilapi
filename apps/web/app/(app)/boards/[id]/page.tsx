'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar, AvatarGroup, Badge, BottomSheet, Button, EmptyState, List, ListItem, Segments, Skeleton, type MenuAction } from '@yapilapi/design-system';
import { BOARD_COLLABORATORS_MAX, type BoardDetail, type Post, type PublicUser, type SavedFilter } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PeoplePicker } from '@/components/PeoplePicker';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import {
  BoardCover,
  BoardEditor,
  MoreButton,
  NoteSheet,
  SaveGrid,
  SaveOptionsSheet,
  SaveToSheet,
  savedFilterOptions,
  visibilityText,
  countPosts,
  tileShortLabel,
  usePaged,
} from '@/components/Boards';
import { useSession } from '../../../providers';

type T = ReturnType<typeof useSession>['t'];

/** "Ada", "Ada and Bola", "Ada, Bola and Chi", with the words of the reader's language. */
function joinNames(names: string[], t: T): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(t('m.collab.joinSep'))}${t('m.collab.joinLast')}${names.at(-1)}`;
}

/** Fills a sentence around a link: the text before `{name}`, the link, then the text after. */
function around(template: string, node: ReactNode) {
  const [before = '', after = ''] = template.split('{name}');
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

/**
 * A board: its cover, name, description, who can see it, the owner and collaborators, and its
 * posts in the board's order. The owner edits it, picks the cover, invites and removes
 * collaborators, and deletes it (the saves stay). Collaborators add, arrange and leave; an
 * invited person accepts or declines. Anyone can view a public board, even without an account.
 */
export default function BoardPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const { me, toast, t, tp } = session;
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
          title={t('boards.unavailableTitle')}
          body={t('boards.unavailableBody')}
          action={
            <Link href="/saved" className="yp-btn yp-btn--secondary">
              {t('boards.goToSaved')}
            </Link>
          }
        />
      </div>
    ) : (
      <NeedsAccount title={t('boards.signInTitle')} body={t('boards.signInBody')} />
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
    setMoved(t('boards.movedTo', { title: tileShortLabel(order[i]!, t), index: j + 1, total: next.length }));
  }

  async function saveOrder() {
    if (!order) return;
    setArranging('saving');
    try {
      await api.boards.reorder(
        id,
        order.map((p) => p.id),
      );
      toast(t('boards.orderSaved'));
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
              { label: t('m.boards.saveTo'), icon: 'bookmark' as const, onSelect: () => (setOptions(null), setSaveTo(options)) },
              {
                label: t(options.viewer.note ? 'm.saved.editNote' : 'm.saved.addNote'),
                icon: 'message' as const,
                onSelect: () => (setOptions(null), setNoteFor(options)),
              },
            ]
          : []),
        ...(owner && board.coverPostId !== options.id
          ? [
              {
                label: t('m.boards.useAsCover'),
                icon: 'image' as const,
                onSelect: () => {
                  setOptions(null);
                  void act(() => api.boards.update(board.id, { coverPostId: options.id }), t('boards.coverChanged'))();
                },
              },
            ]
          : []),
        ...(member && removable.has(options.id)
          ? [
              {
                label: t('m.boards.removeItem'),
                icon: 'trash' as const,
                danger: true,
                onSelect: () => {
                  const p = options;
                  setOptions(null);
                  void act(
                    () => api.boards.removeItem(board.id, p.id),
                    t('boards.itemRemoved'),
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
            {around(
              t('m.boards.by'),
              <bdi>
                <Link href={`/u/${board.owner.username}`}>{board.owner.displayName}</Link>
              </bdi>,
            )}{' '}
            · {countPosts(board.itemCount, session)}
          </span>
          <span className="row">
            <Badge tone="neutral">{visibilityText(board, t)}</Badge>
          </span>
        </div>
      </div>
      {board.description ? (
        <p dir="auto" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {board.description}
        </p>
      ) : null}

      {board.role === 'invited' ? (
        <div className="board-banner" role="group" aria-label={t('boards.invitation')}>
          <span>{t('boards.invitedYou', { name: board.owner.displayName })}</span>
          <span className="row">
            <Button size="sm" onClick={act(() => api.boards.join(board.id), t('boards.joined'))}>
              {t('m.common.accept')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={act(
                () => api.boards.leave(board.id),
                t('boards.inviteDeclined'),
                () => router.push('/saved'),
              )}
            >
              {t('m.common.decline')}
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
                {(() => {
                  const names = joinNames(
                    accepted.slice(0, 3).map((c) => (c.user.id === me?.id ? t('boards.you') : c.user.displayName)),
                    t,
                  );
                  return accepted.length > 3 ? tp('boards.withMore', accepted.length - 3, { names }) : t('boards.with', { names });
                })()}
              </span>
            </>
          ) : collaborators.length ? (
            <span className="muted">
              {t('boards.waiting', {
                names: joinNames(
                  collaborators.map((c) => c.user.displayName),
                  t,
                ),
              })}
            </span>
          ) : (
            <span className="muted">{t('boards.justYou')}</span>
          )}
        </div>
      ) : null}

      {order ? (
        <div className="board-banner" role="group" aria-label={t('m.boards.arrange')}>
          <span>{t('boards.arrangeHint')}</span>
          <span className="row">
            <Button size="sm" loading={arranging === 'saving'} onClick={saveOrder}>
              {t('boards.saveOrder')}
            </Button>
            <Button size="sm" variant="ghost" disabled={arranging === 'saving'} onClick={() => (setOrder(null), setMoved(''))}>
              {t('common.cancel')}
            </Button>
          </span>
        </div>
      ) : member ? (
        <div className="row">
          {owner ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                {t('m.post.edit')}
              </Button>
              <Button variant="secondary" size="sm" icon="users" onClick={() => setPeople(true)}>
                {t(collaborators.length ? 'boards.collaborators' : 'm.boards.inviteOne')}
              </Button>
            </>
          ) : null}
          {board.itemCount > 1 ? (
            <Button variant="secondary" size="sm" loading={arranging === 'loading'} onClick={startArrange}>
              {t('m.boards.arrange')}
            </Button>
          ) : null}
          {owner && board.coverPostId ? (
            <Button variant="ghost" size="sm" onClick={act(() => api.boards.update(board.id, { coverPostId: null }), t('boards.firstIsCover'))}>
              {t('boards.useFirstAsCover')}
            </Button>
          ) : null}
          {owner ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!confirm(t('boards.deleteConfirm'))) return;
                try {
                  await api.boards.remove(board.id);
                  toast(t('boards.deleted'));
                  router.push('/saved');
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('m.common.delete')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={act(
                () => api.boards.leave(board.id),
                t('boards.left'),
                () => router.push('/saved'),
              )}
            >
              {t('communities.leave')}
            </Button>
          )}
        </div>
      ) : null}

      <p className="yp-visually-hidden" role="status">
        {moved}
      </p>

      {order ? (
        <SaveGrid posts={order} label={t('boards.postsArranging')} arrange={{ onMove: move }} />
      ) : (
        <>
          <Segments label={t('m.saved.filter')} value={filter} onChange={setFilter} options={savedFilterOptions(t)} />
          {items.items === null ? (
            <Skeleton height={320} />
          ) : items.items.length ? (
            <>
              <SaveGrid posts={items.items} label={t('boards.posts')} onOptions={me ? setOptions : undefined} />
              <MoreButton cursor={items.cursor} loading={items.loadingMore} onMore={items.more} />
            </>
          ) : (
            <EmptyState
              title={t(filter === 'all' ? 'm.boards.empty' : 'boards.emptyFilter')}
              body={filter !== 'all' ? t('boards.tryAnotherFilter') : board.canAdd ? t('boards.emptyBody') : undefined}
            />
          )}
        </>
      )}

      {!me ? <JoinNote text={t('boards.joinNote')} /> : null}

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
              toast(t('common.saved'));
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
  const { toast, t, tp } = useSession();
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const room = BOARD_COLLABORATORS_MAX - detail.collaborators.length;
  useEffect(() => {
    if (!open) setPicked([]);
  }, [open]);

  return (
    <BottomSheet open={open} onClose={onClose} title={t('boards.collaborators')}>
      <div className="stack">
        {detail.collaborators.length ? (
          <List label={t('boards.collaborators')}>
            {detail.collaborators.map(({ user, status }) => (
              <ListItem
                key={user.id}
                start={<Avatar name={user.displayName} src={user.avatarUrl} size="sm" />}
                primary={user.displayName}
                secondary={t(status === 'invited' ? 'boards.pending' : 'boards.canArrange')}
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
                        toast(status === 'invited' ? t('boards.inviteCancelled') : t('boards.personRemoved', { name: user.displayName }));
                        onChanged();
                      } catch (e) {
                        toast(errorMessage(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {t(status === 'invited' ? 'boards.cancelInvite' : 'm.common.remove')}
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('boards.noCollaborators')}
          </p>
        )}
        {room > 0 ? (
          <>
            <PeoplePicker
              label={t('m.boards.invite')}
              hint={t(detail.board.visibility === 'private' ? 'boards.inviteHintPrivate' : 'boards.inviteHint')}
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
                  if (!failed.length) toast(tp('boards.invitesSent', picked.length));
                }
                setBusy(null);
              }}
            >
              {tp('boards.sendInvites', picked.length)}
            </Button>
          </>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('m.boards.max', { count: BOARD_COLLABORATORS_MAX })}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
