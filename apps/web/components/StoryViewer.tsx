'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, BottomSheet, Button, Checkbox, Icon, List, ListItem, Select, SensitiveCover, useModalFocus } from '@yapilapi/design-system';
import type { Story, StoryGroup } from '@yapilapi/api-client';
import { formatRelativeTime, type MessageKey, type PublicUser, type StickerResults, type StorySticker } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { PeoplePicker } from '@/components/PeoplePicker';
import { StickerLayer, StoryCardView, StoryText } from '@/components/StoryStickers';

const PHOTO_MS = 5000;
/** Who a reshare goes to. */
const RESHARE_AUDIENCES = ['followers', 'friends', 'public', 'close_friends'] as const;

/**
 * Full-screen stories. Progress bars show where you are; photos and text stay
 * 5 seconds, videos play to the end. Tap (or ←/→) for previous and next, hold
 * (or Space) to pause, Escape to close. Viewing marks a story as seen; others'
 * stories can be liked, replied to (the reply arrives as a direct message),
 * sent to a chat, linked to, and added to your own story when they're public
 * or mention you. Stickers (polls, questions, sliders, countdowns, links,
 * places, mentions and tags) work in place. Your own show who saw them, what
 * people answered, and can be deleted.
 */
export function StoryViewer({
  groups,
  start,
  onClose,
  onChange,
}: {
  groups: StoryGroup[];
  start: number;
  onClose: () => void;
  /** Called after local changes (seen, liked, deleted, answered) so the strip can update. */
  onChange: (groups: StoryGroup[]) => void;
}) {
  const { toast, locale, t } = useSession();
  const [g, setG] = useState(start);
  const [i, setI] = useState(() => Math.max(0, groups[start]?.moments.findIndex((m) => !m.seen) ?? 0));
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reply, setReply] = useState('');
  const [viewers, setViewers] = useState<{
    items: { user: PublicUser; liked: boolean }[];
    results: StickerResults[];
    reshares: number;
    allowReshare: boolean;
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [answering, setAnswering] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const group = groups[g];
  const story = group?.moments[i];
  // Sensitive stories wait, blurred and paused, until the viewer chooses to see them.
  const [revealed, setRevealed] = useState<string[]>([]);
  const covered = !!story?.sensitive && !revealed.includes(story.id);
  useModalFocus(root, true, onClose);

  const next = useCallback(() => {
    if (!group) return onClose();
    if (i < group.moments.length - 1) setI(i + 1);
    else if (g < groups.length - 1) {
      setG(g + 1);
      setI(
        Math.max(
          0,
          groups[g + 1]!.moments.findIndex((m) => !m.seen),
        ),
      );
    } else onClose();
  }, [g, i, group, groups, onClose]);
  const prev = useCallback(() => {
    if (i > 0) setI(i - 1);
    else if (g > 0) {
      setG(g - 1);
      setI(groups[g - 1]!.moments.length - 1);
    }
  }, [g, i, groups]);

  const patchStory = (patch: Partial<Story>) =>
    onChange(groups.map((x, gi) => (gi !== g ? x : { ...x, moments: x.moments.map((m, mi) => (mi === i ? { ...m, ...patch } : m)) })));

  // Mark as seen (once) and reset progress when the story changes.
  useEffect(() => {
    setProgress(0);
    setReply('');
    setAnswering(false);
    if (covered) setPaused(true);
    if (!story || story.seen || group?.mine) return;
    void api.moments.view(story.id).catch(() => {});
    onChange(
      groups.map((x, gi) =>
        gi !== g
          ? x
          : { ...x, moments: x.moments.map((m, mi) => (mi === i ? { ...m, seen: true } : m)), allSeen: x.moments.every((m, mi) => mi === i || m.seen) },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // Photos and text advance on a timer; videos report their own progress.
  const stopped = paused || reply.length > 0 || !!viewers || sharing || answering;
  useEffect(() => {
    if (!story || story.mediaKind === 'video' || stopped) return;
    const started = performance.now() - progress * PHOTO_MS;
    let frame = 0;
    const tick = () => {
      const p = (performance.now() - started) / PHOTO_MS;
      if (p >= 1) return next();
      setProgress(p);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, stopped]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (stopped) v.pause();
    else void v.play().catch(() => {});
  }, [stopped, story?.id]);

  if (!group || !story) return null;
  const hold = { onPointerDown: () => setPaused(true), onPointerUp: () => setPaused(false), onPointerLeave: () => setPaused(false) };
  const addToStory = async (visibility: string) => {
    try {
      await api.moments.reshare(story.id, { visibility });
      toast('Added to your story');
      setSharing(false);
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <div
      ref={root}
      className="story"
      role="dialog"
      aria-modal="true"
      aria-label={`${group.author.displayName}'s story, ${i + 1} of ${group.moments.length}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === 'ArrowRight') next();
        else if (e.key === 'ArrowLeft') prev();
        else if (e.key === ' ') {
          e.preventDefault();
          setPaused((p) => !p);
        }
      }}
    >
      <div className="story__frame">
        <div className="story__bars" aria-hidden>
          {group.moments.map((m, mi) => (
            <span key={m.id} className="story__bar">
              <span style={{ width: `${mi < i ? 100 : mi > i ? 0 : Math.round(progress * 100)}%` }} />
            </span>
          ))}
        </div>
        <div className="story__head">
          <Avatar name={group.author.displayName} src={group.author.avatarUrl} size="sm" />
          <span className="story__who">
            <bdi>{group.mine ? 'Your story' : group.author.displayName}</bdi>
            <span>{formatRelativeTime(story.createdAt, locale)}</span>
          </span>
          {story.closeFriends ? (
            <span className="story__close-friends">
              <Icon name="users" size={14} />
              Close friends
            </span>
          ) : null}
          <button type="button" className="story__icon" onClick={() => setSharing(true)} aria-label="Share story">
            <Icon name="send" />
          </button>
          <button type="button" className="story__icon" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'}>
            <Icon name={paused ? 'play' : 'pause'} filled />
          </button>
          <button type="button" className="story__icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div className="story__media" {...hold}>
          {story.mediaKind === 'video' && story.mediaUrl ? (
            <video
              key={story.id}
              ref={videoRef}
              src={story.mediaUrl}
              poster={story.posterUrl ?? undefined}
              className={covered ? 'yp-blurred' : undefined}
              autoPlay={!covered}
              playsInline
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration) setProgress(v.currentTime / v.duration);
              }}
              onEnded={next}
            />
          ) : story.mediaKind === 'image' && story.mediaUrl ? (
            <img
              key={story.id}
              src={story.mediaUrl}
              alt={covered ? '' : story.body || `Story from ${group.author.displayName}`}
              className={covered ? 'yp-blurred' : undefined}
            />
          ) : story.reshareOf ? (
            <div className="story__reshare">
              <StoryCardView
                card={story.reshareOf}
                label={story.reshareOf.available ? `From @${story.reshareOf.author.username}` : undefined}
                action="Open the original"
              />
            </div>
          ) : (
            <p className="story__text" dir="auto">
              {story.body ? <StoryText text={story.body} /> : null}
            </p>
          )}
          {story.body && (story.mediaUrl || story.reshareOf) ? (
            <p className="story__caption" dir="auto">
              <StoryText text={story.body} />
            </p>
          ) : null}
          {covered ? (
            <SensitiveCover
              onReveal={() => {
                setRevealed((r) => [...r, story.id]);
                setPaused(false);
                void videoRef.current?.play().catch(() => {});
              }}
            />
          ) : null}
          <button type="button" className="story__tap story__tap--prev" onClick={prev} aria-label="Previous" />
          <button type="button" className="story__tap story__tap--next" onClick={next} aria-label="Next" />
          {!covered && story.stickers.length ? (
            <StickerLayer
              story={story}
              mine={group.mine}
              toast={toast}
              onBusy={setAnswering}
              onChange={(stickers: StorySticker[]) => patchStory({ stickers })}
            />
          ) : null}
        </div>

        {group.mine ? (
          <div className="story__foot">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () =>
                setViewers(await api.moments.viewers(story.id).catch(() => ({ items: [], results: [], reshares: 0, allowReshare: !!story.allowReshare })))
              }
            >
              Seen by {story.views ?? 0}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await api.moments.remove(story.id);
                  const rest = group.moments.filter((m) => m.id !== story.id);
                  const updated = rest.length ? groups.map((x, gi) => (gi === g ? { ...x, moments: rest } : x)) : groups.filter((_, gi) => gi !== g);
                  onChange(updated);
                  toast('Story deleted');
                  if (!rest.length) onClose();
                  else setI(Math.min(i, rest.length - 1));
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              Delete
            </Button>
          </div>
        ) : (
          <form
            className="story__foot"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!reply.trim()) return;
              try {
                await api.moments.reply(story.id, reply.trim());
                setReply('');
                toast(`Sent to ${group.author.displayName}`);
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            {story.mentionsYou && story.canReshare ? (
              <Button size="sm" variant="secondary" icon="plus" onClick={() => void addToStory('followers')}>
                Add to your story
              </Button>
            ) : null}
            <label htmlFor="story-reply" className="yp-visually-hidden">
              Reply to {group.author.displayName}
            </label>
            <input
              id="story-reply"
              className="story__reply"
              value={reply}
              maxLength={1000}
              placeholder={`Reply to ${group.author.displayName}`}
              onChange={(e) => setReply(e.currentTarget.value)}
            />
            <button
              type="button"
              className="story__icon"
              aria-pressed={story.liked}
              aria-label={story.liked ? 'Unlike' : 'Like'}
              onClick={async () => {
                const liked = !story.liked;
                patchStory({ liked });
                await api.moments.like(story.id, liked).catch((err) => toast(errorMessage(err)));
              }}
            >
              <Icon name="heart" filled={story.liked} />
            </button>
            {reply.trim() ? (
              <button type="submit" className="story__icon" aria-label="Send reply">
                <Icon name="send" />
              </button>
            ) : null}
          </form>
        )}
      </div>

      <ShareSheet
        open={sharing}
        story={story}
        mine={group.mine}
        authorName={group.author.displayName}
        onClose={() => setSharing(false)}
        onAddToStory={addToStory}
        onAllowReshare={async (allow) => {
          try {
            const r = await api.moments.update(story.id, { allowReshare: allow });
            patchStory({ allowReshare: r.allowReshare });
          } catch (e) {
            toast(errorMessage(e));
          }
        }}
        audienceLabel={(v) => t(`visibility.${v}` as MessageKey)}
      />

      <BottomSheet open={viewers !== null} onClose={() => setViewers(null)} title="Seen by">
        {viewers?.results.length ? <StickerResultList results={viewers.results} /> : null}
        {viewers && viewers.reshares > 0 ? (
          <p className="muted">
            Added to {viewers.reshares} {viewers.reshares === 1 ? 'story' : 'stories'}
          </p>
        ) : null}
        {viewers?.items.length ? (
          <List>
            {viewers.items.map((v) => (
              <ListItem
                key={v.user.id}
                start={<Avatar name={v.user.displayName} src={v.user.avatarUrl} size="sm" />}
                primary={v.user.displayName}
                secondary={`@${v.user.username}`}
                end={v.liked ? <Icon name="heart" filled label="Liked" /> : null}
              />
            ))}
          </List>
        ) : (
          <p className="muted">Nobody has seen this story yet.</p>
        )}
      </BottomSheet>
    </div>
  );
}

/** Send to people, copy the link, add to your own story, or (your own) choose whether others can reshare it. */
function ShareSheet({
  open,
  story,
  mine,
  authorName,
  onClose,
  onAddToStory,
  onAllowReshare,
  audienceLabel,
}: {
  open: boolean;
  story: Story;
  mine: boolean;
  authorName: string;
  onClose: () => void;
  onAddToStory: (visibility: string) => Promise<void>;
  onAllowReshare: (allow: boolean) => Promise<void>;
  audienceLabel: (v: string) => string;
}) {
  const { toast } = useSession();
  const [to, setTo] = useState<PublicUser[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState<string>('followers');
  useEffect(() => {
    if (!open) {
      setTo([]);
      setNote('');
    }
  }, [open]);
  return (
    <BottomSheet open={open} onClose={onClose} title="Share story">
      <div className="stack">
        <PeoplePicker picked={to} onChange={setTo} label="Send to" />
        {to.length ? (
          <>
            <label className="yp-visually-hidden" htmlFor="story-share-note">
              Add a message
            </label>
            <input
              id="story-share-note"
              className="yp-input"
              value={note}
              maxLength={1000}
              placeholder="Add a message (optional)"
              onChange={(e) => setNote(e.currentTarget.value)}
            />
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.moments.send(story.id, { userIds: to.map((p) => p.id), body: note.trim() });
                  toast(r.failed.length ? `Sent. ${r.failed[0]!.message}` : to.length === 1 ? `Sent to ${to[0]!.displayName}` : `Sent to ${to.length} people`);
                  onClose();
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send
            </Button>
          </>
        ) : null}
        <Button
          variant="secondary"
          icon="link"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`${location.origin}/s/${story.id}`);
              toast(story.closeFriends || !story.public ? 'Link copied. Only people who can see this story can open it.' : 'Link copied');
            } catch {
              toast("Couldn't copy. Copy the address from your browser instead.");
            }
          }}
        >
          Copy link
        </Button>
        {!mine && story.canReshare ? (
          <div className="stack-sm">
            <Select label="Add to your story for" value={audience} onChange={(e) => setAudience(e.currentTarget.value)}>
              {RESHARE_AUDIENCES.map((v) => (
                <option key={v} value={v}>
                  {audienceLabel(v)}
                </option>
              ))}
            </Select>
            <Button variant="secondary" icon="plus" onClick={() => void onAddToStory(audience)}>
              Add to your story
            </Button>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Your story shows {authorName}&apos;s story as a card, credited to them.
            </p>
          </div>
        ) : null}
        {mine && !story.reshareOf ? (
          <Checkbox
            label="Let people add this story to theirs"
            description="Only for public stories, and for people you mention."
            checked={!!story.allowReshare}
            onChange={(e) => void onAllowReshare(e.currentTarget.checked)}
          />
        ) : null}
      </div>
    </BottomSheet>
  );
}

/** Poll results, slider averages, question answers and countdown reminders, for the author. */
function StickerResultList({ results }: { results: StickerResults[] }) {
  return (
    <div className="stack story-results">
      {results.map((r) => (
        <section key={r.stickerId} className="story-results__item" aria-label={r.type === 'question' ? r.prompt : r.type}>
          {r.type === 'poll' ? (
            <>
              <h3>Poll · {r.votes === 1 ? '1 vote' : `${r.votes} votes`}</h3>
              {r.options.map((o, k) => (
                <div key={k} className="story-results__bar">
                  <span className="story-results__fill" style={{ width: `${r.percents[k]}%` }} aria-hidden />
                  <bdi>{o}</bdi>
                  <span>
                    {r.percents[k]}% ({r.counts[k]})
                  </span>
                </div>
              ))}
            </>
          ) : r.type === 'slider' ? (
            <>
              <h3>
                {r.emoji} {r.prompt}
              </h3>
              <p className="muted">
                {r.count ? `Average ${Math.round((r.average ?? 0) * 100)}% from ${r.count} ${r.count === 1 ? 'person' : 'people'}` : 'No answers yet'}
              </p>
            </>
          ) : r.type === 'countdown' ? (
            <>
              <h3>{r.title}</h3>
              <p className="muted">{r.reminders === 1 ? '1 person asked to be reminded' : `${r.reminders} people asked to be reminded`}</p>
            </>
          ) : (
            <>
              <h3>{r.prompt}</h3>
              {r.answers.length ? (
                <List>
                  {r.answers.map((a) => (
                    <ListItem
                      key={a.id}
                      start={<Avatar name={a.user.displayName} src={a.user.avatarUrl} size="sm" />}
                      primary={a.text}
                      secondary={`@${a.user.username}`}
                    />
                  ))}
                </List>
              ) : (
                <p className="muted">No answers yet</p>
              )}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
