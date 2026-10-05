'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, BottomSheet, Button, Dialog, EmptyState, Icon, Skeleton, Switch } from '@yapilapi/design-system';
import type { ChapterDetail, GuestbookEntry } from '@yapilapi/api-client';
import { CHAPTER_GUESTBOOK_MAX, formatRelativeTime, type PublicUser } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
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
  const session = useSession();
  const { me, toast, locale, flags, t, tp } = session;
  const router = useRouter();
  const [data, setData] = useState<ChapterDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone or private; a chapter already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guestbook, setGuestbook] = useState<GuestbookEntry[]>([]);
  const [line, setLine] = useState('');
  const [playing, setPlaying] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [confirmSeal, setConfirmSeal] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.chapters.get(id);
      setData(d);
      setLoadError(null);
      const g = await api.chapters.guestbook(id).catch(() => ({ items: [] as GuestbookEntry[], open: false }));
      setGuestbook(g.items);
    } catch (e) {
      if (isGone(e)) setMissing(true);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (missing) return <EmptyState level={1} title={t('chapters.unavailable')} body={t('chapters.unavailableBody')} />;
  if (!data && loadError)
    return (
      <div className="yp-shell__inner">
        <EmptyState level={1} title={loadError} action={<Button onClick={() => void load()}>{t('m.common.retry')}</Button>} />
      </div>
    );
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
            <Link href={`/u/${chapter.owner.username}`}>{chapter.owner.displayName}</Link> · {chapterMeta(chapter, session)}
          </span>
          <span className="row">
            <Badge tone="neutral">{t(AUDIENCE_LABEL[chapter.audience])}</Badge>
            {chapter.capsule ? <Badge tone="neutral">{t(chapter.capsule.open ? 'chapters.capsuleOpened' : 'm.chapters.capsule')}</Badge> : null}
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
            <Icon name="lock" size={16} /> {t('m.chapters.sealedUntil', { date: formatDay(chapter.capsule!.opensAt, locale) })}
          </strong>
          <span className="muted">
            {tp('chapters.storiesInside', chapter.storyCount)} {t(chapter.capsule!.sealed ? 'm.chapters.addingClosed' : 'm.chapters.addingOpen')}{' '}
            {t('m.chapters.sealedBody')}
          </span>
          {owner && !chapter.capsule!.sealed ? (
            <Button size="sm" variant="secondary" onClick={() => setConfirmSeal(true)} disabled={!chapter.storyCount}>
              {t('m.chapters.seal')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        {stories.length && !sealed ? (
          <Button icon="play" onClick={() => setPlaying(0)}>
            {t('m.chapters.play')}
          </Button>
        ) : null}
        {chapter.role === 'invited' ? (
          <>
            <Button onClick={act(() => api.chapters.join(chapter.id), t('chapters.joined'))}>{t('m.chapters.join')}</Button>
            <Button variant="ghost" onClick={act(() => api.chapters.removeContributor(chapter.id, me!.id), t('chapters.declined'))}>
              {t('m.chapters.decline')}
            </Button>
          </>
        ) : null}
        {chapter.canAdd ? (
          <Link href="/archive" className="yp-btn yp-btn--secondary">
            {t('m.chapters.addFromArchive')}
          </Link>
        ) : null}
        {owner ? (
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t('m.chapters.edit')}
            </Button>
            {chapter.canAdd ? (
              <Button variant="secondary" icon="users" onClick={() => setInviting(true)}>
                {t('m.chapters.invite')}
              </Button>
            ) : null}
            {stories.length && flags.MEMORY !== false ? (
              <Link href={`/recaps/new?source=chapter&sourceId=${chapter.id}`} className="yp-btn yp-btn--secondary">
                <Icon name="play" size={16} />
                {t('m.recap.make')}
              </Link>
            ) : null}
            <Button
              variant="ghost"
              onClick={async () => {
                if (!confirm(`${t('m.chapters.delete.title')} ${t('m.chapters.delete.body')}`)) return;
                try {
                  await api.chapters.remove(chapter.id);
                  toast(t('chapters.deleted'));
                  router.push(`/u/${chapter.owner.username}`);
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('m.common.delete')}
            </Button>
          </>
        ) : null}
      </div>

      {chapter.role === 'contributor' ? (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Switch
            label={t('m.chapters.showOnProfile')}
            checked={!!chapter.showOnProfile}
            onChange={(v) => void act(() => api.chapters.showOnProfile(chapter.id, v))()}
          />
          <Button size="sm" variant="ghost" onClick={act(() => api.chapters.removeContributor(chapter.id, me!.id), t('chapters.left'))}>
            {t('m.chapters.leave')}
          </Button>
        </div>
      ) : null}

      {contributors.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('m.chapters.contributors')}</h2>
          <ul className="guestbook">
            {contributors.map((m) => (
              <li key={m.user.id}>
                <Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
                <div>
                  <Link href={`/u/${m.user.username}`}>{m.user.displayName}</Link>
                  {m.status === 'invited' ? <span className="muted"> · {t('m.chapters.pending')}</span> : null}
                </div>
                {owner ? (
                  <Button size="sm" variant="ghost" onClick={act(() => api.chapters.removeContributor(chapter.id, m.user.id), t('chapters.removed'))}>
                    {t('m.chapters.remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stories.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t(sealed ? 'm.chapters.yourStoriesInside' : 'm.chapters.storiesHeading')}</h2>
          <ul className="story-grid">
            {stories.map((s, n) => (
              <li key={s.id} className="story-tile">
                <button
                  type="button"
                  className="story-tile__media"
                  onClick={() => !sealed && setPlaying(n)}
                  aria-label={t('chapters.playFrom', { index: n + 1 })}
                >
                  {s.mediaKind === 'image' && s.mediaUrl ? (
                    <img src={s.mediaUrl} alt="" loading="lazy" decoding="async" />
                  ) : s.posterUrl ? (
                    <img src={s.posterUrl} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <p dir="auto">{s.body}</p>
                  )}
                </button>
                <span className="story-tile__meta">
                  <bdi>{s.author.displayName}</bdi> · {formatDay(s.createdAt, locale)}
                </span>
                {owner || s.mine ? (
                  <Button size="sm" variant="ghost" onClick={act(() => api.chapters.removeStory(chapter.id, s.id), t('chapters.storyRemoved'))}>
                    {t('m.chapters.remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : !sealed ? (
        <EmptyState title={t('chapters.noStories')} body={chapter.canAdd ? t('chapters.noStoriesBody') : undefined} />
      ) : null}

      {!sealed ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('m.chapters.guestbook')}</h2>
          {me ? (
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const { entry } = await api.chapters.sign(chapter.id, line.trim());
                  setLine('');
                  toast(t(entry.pending ? 'chapters.linePending' : 'm.chapters.signed'));
                  await load();
                } catch (err) {
                  toast(errorMessage(err));
                }
              }}
            >
              <label htmlFor="guestbook-line" className="yp-visually-hidden">
                {t('chapters.yourLine')}
              </label>
              <input
                id="guestbook-line"
                className="yp-input"
                style={{ flex: 1 }}
                value={line}
                maxLength={CHAPTER_GUESTBOOK_MAX}
                placeholder={t('chapters.linePlaceholder', { max: CHAPTER_GUESTBOOK_MAX })}
                onChange={(e) => setLine(e.currentTarget.value)}
              />
              <Button type="submit" disabled={!line.trim()}>
                {t('m.chapters.sign')}
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
                    {g.pending ? <span className="muted">{t('m.chapters.onlyYou')}</span> : null}
                    {g.hidden ? <span className="muted">{t('m.chapters.hidden')}</span> : null}
                  </div>
                  {owner ? (
                    <Button size="sm" variant="ghost" onClick={act(() => api.chapters.hideLine(chapter.id, g.id, !g.hidden))}>
                      {t(g.hidden ? 'm.chapters.show' : 'm.chapters.hide')}
                    </Button>
                  ) : g.mine ? (
                    <Button size="sm" variant="ghost" onClick={act(() => api.chapters.deleteLine(chapter.id, g.id), t('chapters.lineDeleted'))}>
                      {t('m.common.delete')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('m.chapters.noLines')}</p>
          )}
        </section>
      ) : null}

      {owner && chapter.capsule ? (
        // Sealing can't be undone: say what it means first.
        <Dialog
          open={confirmSeal}
          onClose={() => setConfirmSeal(false)}
          title={t('m.chapters.sealConfirmTitle')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmSeal(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  setConfirmSeal(false);
                  void act(() => api.chapters.seal(chapter.id), t('chapters.sealed'))();
                }}
              >
                {t('m.chapters.seal')}
              </Button>
            </>
          }
        >
          <p>{t('m.chapters.sealConfirmBody', { date: formatDay(chapter.capsule.opensAt, locale) })}</p>
        </Dialog>
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
              toast(t('common.saved'));
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
                toast(t('m.chapters.invited', { name: u.displayName }));
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
  const { t } = useSession();
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
    <BottomSheet open={open} onClose={onClose} title={t('m.chapters.inviteTitle')}>
      <div className="stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          {t('m.chapters.inviteHint')}
        </p>
        <label htmlFor="invite-q" className="yp-visually-hidden">
          {t('m.stories.searchPeople')}
        </label>
        <input id="invite-q" className="yp-input" placeholder={t('m.closeFriends.search')} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
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
                  {t('m.chapters.invite')}
                </Button>
              </li>
            ))}
        </ul>
      </div>
    </BottomSheet>
  );
}
