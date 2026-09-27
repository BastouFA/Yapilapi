'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Avatar, Icon, TaggedText } from '@yapilapi/design-system';
import type { Story } from '@yapilapi/api-client';
import { t as translate, type MessageKey, type StoryCard, type StorySticker } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '@/app/providers';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => translate(key, 'en', vars);

/** Where a sticker sits on the frame: relative to its size, from the start edge and the top. */
export function stickerStyle(s: { x: number; y: number; scale?: number; rotation?: number }): CSSProperties {
  return {
    insetInlineStart: `${s.x * 100}%`,
    top: `${s.y * 100}%`,
    transform: `translate(-50%, -50%) scale(${s.scale ?? 1}) rotate(${s.rotation ?? 0}deg)`,
  };
}

/** Time left on a countdown, in plain words. Pass the session's `t` to get it in the viewer's language. */
export function timeLeft(endsAt: string, now = Date.now(), t: Translate = english): string {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return t('m.sticker.ended');
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return t('m.sticker.leftDays', { days: d, hours: h });
  if (h) return t('m.sticker.leftHours', { hours: h, minutes: m % 60 });
  return m ? t('m.sticker.leftMinutes', { minutes: m }) : t('stickers.view.lessThanMinute');
}

/** Story text with @mentions and #tags as links. */
export function StoryText({ text }: { text: string }) {
  return <TaggedText text={text} linkAs={NextLink} />;
}

/**
 * The stickers on a story, for viewers: mentions and tags link to their pages,
 * polls take one vote and then show percentages, question boxes send an
 * answer only the author sees, sliders take one answer, countdowns offer
 * "Remind me", links show their domain and places link to the place page.
 * `onBusy` pauses the story while someone is answering.
 */
export function StickerLayer({
  story,
  mine,
  onChange,
  onBusy,
  toast,
}: {
  story: Story;
  mine: boolean;
  onChange: (stickers: StorySticker[]) => void;
  onBusy: (busy: boolean) => void;
  toast: (message: string) => void;
}) {
  const update = (id: string, patch: Partial<StorySticker>) => onChange(story.stickers.map((s) => (s.id === id ? ({ ...s, ...patch } as StorySticker) : s)));
  return (
    <div className="story-stickers">
      {story.stickers.map((s) => (
        <div
          key={s.id}
          className={`story-sticker story-sticker--${s.type}`}
          style={stickerStyle(s)}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <StickerBody story={story} sticker={s} mine={mine} update={update} onBusy={onBusy} toast={toast} />
        </div>
      ))}
    </div>
  );
}

function StickerBody({
  story,
  sticker: s,
  mine,
  update,
  onBusy,
  toast,
}: {
  story: Story;
  sticker: StorySticker;
  mine: boolean;
  update: (id: string, patch: Partial<StorySticker>) => void;
  onBusy: (busy: boolean) => void;
  toast: (message: string) => void;
}) {
  switch (s.type) {
    case 'mention':
      return (
        <Link href={`/u/${s.user.username}`} className="story-sticker__chip">
          <bdi>@{s.user.username}</bdi>
        </Link>
      );
    case 'hashtag':
      return (
        <Link href={`/t/${encodeURIComponent(s.tag)}`} className="story-sticker__chip">
          <bdi>#{s.tag}</bdi>
        </Link>
      );
    case 'link':
      return (
        <a href={s.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="story-sticker__chip">
          <Icon name="link" size={16} />
          <bdi>{s.label || s.domain}</bdi>
          {s.label ? <span className="story-sticker__domain">{s.domain}</span> : null}
        </a>
      );
    case 'place':
      return (
        <Link href={`/places/${s.placeId}`} className="story-sticker__chip">
          <Icon name="map-pin" size={16} />
          <bdi>{s.name}</bdi>
        </Link>
      );
    case 'poll':
      return <Poll story={story} s={s} mine={mine} update={update} toast={toast} />;
    case 'question':
      return <Question story={story} s={s} mine={mine} update={update} onBusy={onBusy} toast={toast} />;
    case 'slider':
      return <Slider story={story} s={s} mine={mine} update={update} toast={toast} />;
    case 'countdown':
      return <Countdown story={story} s={s} update={update} toast={toast} />;
  }
}

type Of<T extends StorySticker['type']> = Extract<StorySticker, { type: T }>;

function Poll({
  story,
  s,
  mine,
  update,
  toast,
}: {
  story: Story;
  s: Of<'poll'>;
  mine: boolean;
  update: (id: string, patch: Partial<StorySticker>) => void;
  toast: (m: string) => void;
}) {
  const { t, tp } = useSession();
  const shown = s.results !== undefined;
  return (
    <div className="story-card-sticker" role="group" aria-label={s.question || t('m.sticker.kind.poll')}>
      {s.question ? <p className="story-card-sticker__title">{s.question}</p> : null}
      <div className="story-poll">
        {s.options.map((o, i) => (
          <button
            key={i}
            type="button"
            className={`story-poll__option${s.voted === i ? ' story-poll__option--picked' : ''}`}
            disabled={mine || s.voted !== null}
            aria-pressed={s.voted === i}
            onClick={async () => {
              try {
                const r = await api.moments.vote(story.id, s.id, i as 0 | 1);
                update(s.id, { voted: r.voted, results: r.results, votes: r.votes });
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {shown ? <span className="story-poll__fill" style={{ width: `${s.results![i]}%` }} aria-hidden /> : null}
            <span className="story-poll__label">
              <bdi>{o}</bdi>
            </span>
            {shown ? <span className="story-poll__pct">{s.results![i]}%</span> : null}
          </button>
        ))}
      </div>
      {shown ? <p className="story-card-sticker__meta">{tp('m.sticker.votes', s.votes ?? 0)}</p> : null}
    </div>
  );
}

function Question({
  story,
  s,
  mine,
  update,
  onBusy,
  toast,
}: {
  story: Story;
  s: Of<'question'>;
  mine: boolean;
  update: (id: string, patch: Partial<StorySticker>) => void;
  onBusy: (b: boolean) => void;
  toast: (m: string) => void;
}) {
  const { t, tp } = useSession();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  return (
    <form
      className="story-card-sticker"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setSending(true);
        try {
          const r = await api.moments.answer(story.id, s.id, text.trim());
          update(s.id, { answered: r.answered });
          setText('');
          onBusy(false);
          toast(t('m.sticker.answerSent'));
        } catch (err) {
          toast(errorMessage(err));
        } finally {
          setSending(false);
        }
      }}
    >
      <p className="story-card-sticker__title">{s.prompt}</p>
      {mine ? (
        <p className="story-card-sticker__meta">{t('m.sticker.answersInSeenBy')}</p>
      ) : (
        <>
          <label className="yp-visually-hidden" htmlFor={`q-${story.id}-${s.id}`}>
            {t('stickers.view.yourAnswer')}
          </label>
          <input
            id={`q-${story.id}-${s.id}`}
            className="story-question__input"
            value={text}
            maxLength={300}
            placeholder={t('m.sticker.answerPlaceholder')}
            onFocus={() => onBusy(true)}
            onBlur={() => !text && onBusy(false)}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          {text.trim() ? (
            <button type="submit" className="story-question__send" disabled={sending}>
              {t('m.stories.send')}
            </button>
          ) : s.answered ? (
            <p className="story-card-sticker__meta">{tp('stickers.view.sent', s.answered)}</p>
          ) : null}
        </>
      )}
    </form>
  );
}

function Slider({
  story,
  s,
  mine,
  update,
  toast,
}: {
  story: Story;
  s: Of<'slider'>;
  mine: boolean;
  update: (id: string, patch: Partial<StorySticker>) => void;
  toast: (m: string) => void;
}) {
  const { t, tp } = useSession();
  const [value, setValue] = useState(s.mine ?? 0.5);
  const done = s.mine !== null;
  const send = async () => {
    if (mine || done) return;
    try {
      const r = await api.moments.slide(story.id, s.id, value);
      update(s.id, { mine: r.mine });
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="story-card-sticker">
      <p className="story-card-sticker__title">{s.prompt}</p>
      <div className="story-slider" style={{ '--pos': `${(mine ? (s.average ?? 0) : value) * 100}%` } as CSSProperties}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={mine ? (s.average ?? 0) : value}
          disabled={mine || done}
          aria-label={s.prompt}
          aria-valuetext={`${Math.round((mine ? (s.average ?? 0) : value) * 100)}%`}
          onChange={(e) => setValue(Number(e.currentTarget.value))}
          onPointerUp={() => void send()}
          onKeyUp={(e) => (e.key === 'Enter' ? void send() : undefined)}
        />
        <span className="story-slider__emoji" aria-hidden>
          {s.emoji}
        </span>
      </div>
      <p className="story-card-sticker__meta">
        {mine
          ? s.count
            ? tp('stickers.view.average', s.count, { percent: `${Math.round((s.average ?? 0) * 100)}%` })
            : t('m.sticker.noAnswers')
          : done
            ? t('m.sticker.answerSent')
            : t('m.sticker.slideHint')}
      </p>
    </div>
  );
}

function Countdown({
  story,
  s,
  update,
  toast,
}: {
  story: Story;
  s: Of<'countdown'>;
  update: (id: string, patch: Partial<StorySticker>) => void;
  toast: (m: string) => void;
}) {
  const { t } = useSession();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const ended = new Date(s.endsAt).getTime() <= now;
  return (
    <div className="story-card-sticker">
      <p className="story-card-sticker__title">{s.title}</p>
      <p className="story-countdown__time">{timeLeft(s.endsAt, now, t)}</p>
      {!ended ? (
        <button
          type="button"
          className="story-question__send"
          aria-pressed={s.reminding}
          onClick={async () => {
            try {
              const r = await api.moments.remind(story.id, s.id, !s.reminding);
              update(s.id, { reminding: r.reminding });
              toast(r.reminding ? t('stickers.view.remindOn') : t('stickers.view.remindOff'));
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        >
          <Icon name="bell" size={16} filled={s.reminding} />
          {s.reminding ? t('m.sticker.reminderOn') : t('m.sticker.remindMe')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A story inside something else (a message, a reshare). It opens only for
 * people who can see the story; for others it says it isn't available.
 */
export function StoryCardView({ card, label, action }: { card: StoryCard; label?: string; action?: ReactNode }) {
  const { t } = useSession();
  if (!card.available)
    return (
      <div className="story-card story-card--gone">
        <Icon name="eye" size={18} />
        <span>{t('m.stories.unavailable')}</span>
      </div>
    );
  return (
    <Link href={`/s/${card.id}`} className="story-card" aria-label={t('story.card.viewFrom', { name: card.author.displayName })}>
      <span className="story-card__preview" aria-hidden>
        {card.mediaKind === 'image' && card.mediaUrl ? (
          <img src={card.mediaUrl} alt="" />
        ) : card.mediaKind === 'video' && (card.posterUrl || card.mediaUrl) ? (
          card.posterUrl ? (
            <img src={card.posterUrl} alt="" />
          ) : (
            <video src={card.mediaUrl!} muted preload="metadata" />
          )
        ) : (
          <span className="story-card__text">{card.body.slice(0, 80)}</span>
        )}
      </span>
      <span className="story-card__meta">
        <span className="story-card__who">
          <Avatar name={card.author.displayName} src={card.author.avatarUrl} size="sm" />
          <bdi>{label ?? `@${card.author.username}`}</bdi>
        </span>
        {card.body && card.mediaUrl ? <span className="story-card__body">{card.body.slice(0, 80)}</span> : null}
        <span className="story-card__cta">{action ?? t('m.stories.view')}</span>
      </span>
    </Link>
  );
}
