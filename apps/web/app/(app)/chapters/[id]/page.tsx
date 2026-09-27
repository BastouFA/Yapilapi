'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, BottomSheet, Button, EmptyState, Icon, Skeleton, Switch } from '@yapilapi/design-system';
import type { ChapterDetail, GuestbookEntry } from '@yapilapi/api-client';
import { CHAPTER_GUESTBOOK_MAX, formatRelativeTime, type PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { AUDIENCE_LABEL, ChapterCover, ChapterEditor, ChapterPlayer, chapterMeta, formatDay, isSealed } from '@/components/Chapters';
import { useSession } from '../../../providers';

/**
 * A chapter: its cover, who can see it, its stories (credited to whoever shared each one), the
 * people adding to it and its guestbook. The owner edits, invites, seals a time capsule and
 * removes stories, people or lines; contributors add, leave and choose whether it shows on
 * their profile.
 */
export default function ChapterPage() {
  const { id } = useParams<{ id: string }>();
  const { me, toast, locale, flags } = useSession();
  const router = useRouter();
  const [data, setData] = useState<ChapterDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [guestbook, setGuestbook] = useState<GuestbookEntry[]>([]);
  const [line, setLine] = useState('');
  const [playing, setPlaying] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.chapters.get(id);
      setData(d);
      const g = await api.chapters.guestbook(id).catch(() => ({ items: [] as GuestbookEntry[], open: false }));
      setGuestbook(g.items);
    } catch {
      setMissing(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (missing) return <EmptyState title="This chapter isn't available" body="It may have been deleted, or you may not be able to see it." />;
  if (!data)
    return (
      <div className="yp-shell__inner">
        <Skeleton height={120} />
        <Skeleton height={240} />
      </div>
    );

  const { chapter, stories, contributors } = data;
  const owner = chapter.role === 'owner';
  const sealed = isSealed(chapter);
  const act = (fn: () => Promise<unknown>, done?: string) => async () => {
    try {
      await fn();
      if (done) toast(done);
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <div className="yp-shell__inner">
      <div className="chapter-hero">
        <ChapterCover chapter={chapter} size={104} />
        <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
          <h1 dir="auto">{chapter.title}</h1>
          <span className="muted">
            <Link href={`/u/${chapter.owner.username}`}>{chapter.owner.displayName}</Link> · {chapterMeta(chapter, locale)}
          </span>
          <span className="row">
            <Badge tone="neutral">{AUDIENCE_LABEL[chapter.audience]}</Badge>
            {chapter.capsule ? <Badge tone="neutral">{chapter.capsule.open ? 'Time capsule, opened' : 'Time capsule'}</Badge> : null}
          </span>
        </div>
      </div>
      {chapter.description ? (
        <p dir="auto" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {chapter.description}
        </p>
      ) : null}

      {sealed ? (
        <div className="yp-card stack-sm" style={{ padding: 'var(--space-4)' }}>
          <strong>
            <Icon name="lock" size={16} /> Sealed until {formatDay(chapter.capsule!.opensAt, locale)}
          </strong>
          <span className="muted">
            {chapter.storyCount === 1 ? '1 story inside.' : `${chapter.storyCount} stories inside.`}{' '}
            {chapter.capsule!.sealed ? 'Nothing more can be added.' : 'Stories can still be added until it is sealed.'} Everyone who can see it finds out what
            is inside on that day.
          </span>
          {owner && !chapter.capsule!.sealed ? (
            <Button size="sm" variant="secondary" onClick={act(() => api.chapters.seal(chapter.id), 'Sealed')} disabled={!chapter.storyCount}>
              Seal it now
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        {stories.length && !sealed ? (
          <Button icon="play" onClick={() => setPlaying(0)}>
            Play
          </Button>
        ) : null}
        {chapter.role === 'invited' ? (
          <>
            <Button onClick={act(() => api.chapters.join(chapter.id), 'You can add your stories now')}>Add my stories to it</Button>
            <Button variant="ghost" onClick={act(() => api.chapters.removeContributor(chapter.id, me!.id), 'Invitation declined')}>
              Decline
            </Button>
          </>
        ) : null}
        {chapter.canAdd ? (
          <Link href="/archive" className="yp-btn yp-btn--secondary">
            Add from your archive
          </Link>
        ) : null}
        {owner ? (
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {chapter.canAdd ? (
              <Button variant="secondary" icon="users" onClick={() => setInviting(true)}>
                Invite
              </Button>
            ) : null}
            {stories.length && flags.MEMORY !== false ? (
              <Link href={`/recaps/new?source=chapter&sourceId=${chapter.id}`} className="yp-btn yp-btn--secondary">
                <Icon name="play" size={16} />
                Make a recap video
              </Link>
            ) : null}
            <Button
              variant="ghost"
              onClick={async () => {
                if (!confirm('Delete this chapter? The stories stay in your archive.')) return;
                try {
                  await api.chapters.remove(chapter.id);
                  toast('Chapter deleted');
                  router.push(`/u/${chapter.owner.username}`);
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>

      {chapter.role === 'contributor' ? (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Switch
            label="Show on my profile too"
            checked={!!chapter.showOnProfile}
            onChange={(v) => void act(() => api.chapters.showOnProfile(chapter.id, v))()}
          />
          <Button size="sm" variant="ghost" onClick={act(() => api.chapters.removeContributor(chapter.id, me!.id), 'You left the chapter')}>
            Leave
          </Button>
        </div>
      ) : null}

      {contributors.length ? (
        <section className="stack-sm">
          <h2 className="section-title">Adding to it</h2>
          <ul className="guestbook">
            {contributors.map((m) => (
              <li key={m.user.id}>
                <Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
                <div>
                  <Link href={`/u/${m.user.username}`}>{m.user.displayName}</Link>
                  {m.status === 'invited' ? <span className="muted"> · Invited</span> : null}
                </div>
                {owner ? (
                  <Button size="sm" variant="ghost" onClick={act(() => api.chapters.removeContributor(chapter.id, m.user.id), 'Removed')}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stories.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{sealed ? 'Your stories inside' : 'Stories'}</h2>
          <ul className="story-grid">
            {stories.map((s, n) => (
              <li key={s.id} className="story-tile">
                <button type="button" className="story-tile__media" onClick={() => !sealed && setPlaying(n)} aria-label={`Play from story ${n + 1}`}>
                  {s.mediaKind === 'image' && s.mediaUrl ? (
                    <img src={s.mediaUrl} alt="" />
                  ) : s.posterUrl ? (
                    <img src={s.posterUrl} alt="" />
                  ) : (
                    <p dir="auto">{s.body}</p>
                  )}
                </button>
                <span className="story-tile__meta">
                  <bdi>{s.author.displayName}</bdi> · {formatDay(s.createdAt, locale)}
                </span>
                {owner || s.mine ? (
                  <Button size="sm" variant="ghost" onClick={act(() => api.chapters.removeStory(chapter.id, s.id), 'Removed from the chapter')}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : !sealed ? (
        <EmptyState title="No stories yet" body={chapter.canAdd ? 'Add stories from your archive, or from your story while it is up.' : undefined} />
      ) : null}

      {!sealed ? (
        <section className="stack-sm">
          <h2 className="section-title">Guestbook</h2>
          {me ? (
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const { entry } = await api.chapters.sign(chapter.id, line.trim());
                  setLine('');
                  toast(entry.pending ? 'Your line shows to others after a quick check.' : 'Your line is in the guestbook.');
                  await load();
                } catch (err) {
                  toast(errorMessage(err));
                }
              }}
            >
              <label htmlFor="guestbook-line" className="yp-visually-hidden">
                Your line
              </label>
              <input
                id="guestbook-line"
                className="yp-input"
                style={{ flex: 1 }}
                value={line}
                maxLength={CHAPTER_GUESTBOOK_MAX}
                placeholder="One short line, up to 140 characters"
                onChange={(e) => setLine(e.currentTarget.value)}
              />
              <Button type="submit" disabled={!line.trim()}>
                Sign
              </Button>
            </form>
          ) : null}
          {guestbook.length ? (
            <ul className="guestbook">
              {guestbook.map((g) => (
                <li key={g.id} className={g.hidden ? 'guestbook__hidden' : undefined}>
                  <Avatar name={g.author.displayName} src={g.author.avatarUrl} size="sm" />
                  <div>
                    <strong>{g.author.displayName}</strong> <span className="muted">{formatRelativeTime(g.createdAt, locale)}</span>
                    <p dir="auto">{g.body}</p>
                    {g.pending ? <span className="muted">Only you see this until it has been checked.</span> : null}
                    {g.hidden ? <span className="muted">Hidden from others.</span> : null}
                  </div>
                  {owner ? (
                    <Button size="sm" variant="ghost" onClick={act(() => api.chapters.hideLine(chapter.id, g.id, !g.hidden))}>
                      {g.hidden ? 'Show' : 'Hide'}
                    </Button>
                  ) : g.mine ? (
                    <Button size="sm" variant="ghost" onClick={act(() => api.chapters.deleteLine(chapter.id, g.id), 'Line deleted')}>
                      Delete
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No lines yet.</p>
          )}
        </section>
      ) : null}

      {playing !== null ? <ChapterPlayer detail={data} start={playing} onClose={() => (setPlaying(null), void load())} /> : null}
      {owner ? (
        <>
          <ChapterEditor
            open={editing}
            chapter={chapter}
            stories={stories}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              toast('Saved');
              void load();
            }}
          />
          <InviteSheet
            open={inviting}
            onClose={() => setInviting(false)}
            exclude={contributors.map((c) => c.user.id)}
            onPick={async (u) => {
              try {
                await api.chapters.invite(chapter.id, u.id);
                toast(`Invited ${u.displayName}`);
                await load();
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/** People who follow you, to invite as contributors. Only people you also follow can accept. */
function InviteSheet({ open, onClose, exclude, onPick }: { open: boolean; onClose: () => void; exclude: string[]; onPick: (u: PublicUser) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<{ user: PublicUser; relation: string | null }[]>([]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(
      () =>
        api.people.suggest(q.trim(), 12, 'followers').then(
          (r) => setItems(r.items),
          () => setItems([]),
        ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, open]);
  return (
    <BottomSheet open={open} onClose={onClose} title="Invite to add stories">
      <div className="stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          You can invite people you follow who follow you back. Their stories show with their name.
        </p>
        <label htmlFor="invite-q" className="yp-visually-hidden">
          Search people
        </label>
        <input id="invite-q" className="yp-input" placeholder="Type a name or username" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        <ul className="guestbook">
          {items
            .filter((s) => !exclude.includes(s.user.id))
            .map((s) => (
              <li key={s.user.id}>
                <Avatar name={s.user.displayName} src={s.user.avatarUrl} size="sm" />
                <div>
                  <strong>{s.user.displayName}</strong>
                  <div className="muted">@{s.user.username}</div>
                </div>
                <Button size="sm" onClick={() => onPick(s.user)}>
                  Invite
                </Button>
              </li>
            ))}
        </ul>
      </div>
    </BottomSheet>
  );
}
