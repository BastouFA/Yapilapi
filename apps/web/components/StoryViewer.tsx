'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, BottomSheet, Button, Icon, List, ListItem, useModalFocus } from '@yapilapi/design-system';
import type { StoryGroup } from '@yapilapi/api-client';
import { formatRelativeTime, type PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const PHOTO_MS = 5000;

/**
 * Full-screen stories. Progress bars show where you are; photos and text stay
 * 5 seconds, videos play to the end. Tap (or ←/→) for previous and next, hold
 * (or Space) to pause, Escape to close. Viewing marks a story as seen; others'
 * stories can be liked and replied to (the reply arrives as a direct message);
 * your own show who saw them and can be deleted.
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
  /** Called after local changes (seen, liked, deleted) so the strip can update. */
  onChange: (groups: StoryGroup[]) => void;
}) {
  const { toast, locale } = useSession();
  const [g, setG] = useState(start);
  const [i, setI] = useState(() => Math.max(0, groups[start]?.moments.findIndex((m) => !m.seen) ?? 0));
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reply, setReply] = useState('');
  const [viewers, setViewers] = useState<{ user: PublicUser; liked: boolean }[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const group = groups[g];
  const story = group?.moments[i];
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

  // Mark as seen (once) and reset progress when the story changes.
  useEffect(() => {
    setProgress(0);
    setReply('');
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
  const typing = reply.length > 0;
  useEffect(() => {
    if (!story || story.mediaKind === 'video' || paused || typing || viewers) return;
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
  }, [story?.id, paused, typing, viewers]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused || typing || viewers) v.pause();
    else void v.play().catch(() => {});
  }, [paused, typing, viewers, story?.id]);

  if (!group || !story) return null;
  const hold = { onPointerDown: () => setPaused(true), onPointerUp: () => setPaused(false), onPointerLeave: () => setPaused(false) };

  return (
    <div
      ref={root}
      className="story"
      role="dialog"
      aria-modal="true"
      aria-label={`${group.author.displayName}'s story, ${i + 1} of ${group.moments.length}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
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
              autoPlay
              playsInline
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration) setProgress(v.currentTime / v.duration);
              }}
              onEnded={next}
            />
          ) : story.mediaKind === 'image' && story.mediaUrl ? (
            <img key={story.id} src={story.mediaUrl} alt={story.body || `Story from ${group.author.displayName}`} />
          ) : (
            <p className="story__text" dir="auto">
              {story.body}
            </p>
          )}
          {story.body && story.mediaUrl ? (
            <p className="story__caption" dir="auto">
              {story.body}
            </p>
          ) : null}
          <button type="button" className="story__tap story__tap--prev" onClick={prev} aria-label="Previous" />
          <button type="button" className="story__tap story__tap--next" onClick={next} aria-label="Next" />
        </div>

        {group.mine ? (
          <div className="story__foot">
            <Button size="sm" variant="secondary" onClick={async () => setViewers((await api.moments.viewers(story.id).catch(() => ({ items: [] }))).items)}>
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
                onChange(groups.map((x, gi) => (gi !== g ? x : { ...x, moments: x.moments.map((m, mi) => (mi === i ? { ...m, liked } : m)) })));
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

      <BottomSheet open={viewers !== null} onClose={() => setViewers(null)} title="Seen by">
        {viewers?.length ? (
          <List>
            {viewers.map((v) => (
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
