'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AIPanel, Button } from '@yapilapi/design-system';
import type { TodayBriefing, TodaySegment } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Yapilapi Today on Pulse (docs/product/yapilapi-today.md): this morning's short briefing of what
 * your people and your city are talking about. Play reads it segment by segment (a plain
 * synthetic voice, when listening is set up); each segment links to the posts it is about, can
 * play the original Yap ("Hear @ada"), and can be put away with "Not interested in this".
 * Nothing plays by itself.
 */
export function TodayCard() {
  const { t, flags, toast } = useSession();
  const [today, setToday] = useState<TodayBriefing | null>(null);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<'segment' | string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // Whether the briefing is playing on its own (moving to the next segment when one ends).
  const flowing = useRef(false);

  useEffect(() => {
    if (!flags.TODAY) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api.today.get(tz).then(
      (r) => setToday(r.today),
      () => {},
    );
  }, [flags.TODAY]);

  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [],
  );

  if (!today || !today.segments.length) return null;
  const segments = today.segments;
  const index = Math.min(at, segments.length - 1);
  const seg = segments[index]!;

  function stop() {
    flowing.current = false;
    audio.current?.pause();
    setPlaying(null);
  }

  /** Play `url`; when it ends, `then`. */
  function play(url: string, what: 'segment' | string, then?: () => void) {
    audio.current?.pause();
    const a = new Audio(url);
    audio.current = a;
    a.onended = () => {
      if (audio.current !== a) return;
      setPlaying(null);
      then?.();
    };
    a.onerror = () => {
      if (audio.current === a) setPlaying(null);
    };
    setPlaying(what);
    a.play().catch(() => setPlaying(null));
  }

  /** Read segment `i` (or play its first Yap when it has no voice of its own), then go on to the next. */
  function playSegment(i: number) {
    const s = segments[i];
    setAt(i);
    if (!s) return stop();
    const url = s.audioUrl ?? s.sources.find((x) => x.voice)?.voice?.url;
    if (!url) {
      // Text only: it waits on this segment for Next.
      flowing.current = false;
      return setPlaying(null);
    }
    play(url, 'segment', () => {
      if (flowing.current && i + 1 < segments.length) playSegment(i + 1);
      else flowing.current = false;
    });
  }

  function start() {
    setOpen(true);
    flowing.current = true;
    playSegment(index);
  }

  function go(i: number) {
    if (flowing.current || playing) {
      flowing.current = true;
      playSegment(i);
    } else setAt(i);
  }

  async function notInterested(s: TodaySegment) {
    stop();
    try {
      const r = await api.today.notInterested(today!.id, s.index);
      setToday(r.today);
      setAt((n) => Math.min(n, Math.max(0, (r.today?.segments.length ?? 1) - 1)));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  function hide() {
    stop();
    const id = today!.id;
    setToday(null);
    void api.today.dismiss(id).catch(() => {});
  }

  const segmentPlaying = playing === 'segment';
  return (
    <AIPanel
      title={t('today.title')}
      label={t('ai.label')}
      notice={t('today.note')}
      actions={
        <>
          <Button size="sm" icon={segmentPlaying ? 'pause' : 'play'} onClick={() => (segmentPlaying ? stop() : start())}>
            {segmentPlaying ? t('voice.pause') : open ? t('voice.play') : t('today.play')}
          </Button>
          <Button size="sm" variant="ghost" onClick={hide}>
            {t('catchUp.hide')}
          </Button>
        </>
      }
    >
      {!open ? (
        <p className="today__intro">{t('today.intro')}</p>
      ) : (
        <div className="today" data-testid="today-player">
          <p className="today__part" aria-live="polite">
            {t('today.segment', { n: index + 1, count: segments.length })}
          </p>
          <p className="today__text" dir="auto" aria-current={segmentPlaying ? 'true' : undefined}>
            {seg.text}
          </p>
          <div className="today__sources">
            {seg.sources.map((s) => (
              <span key={s.postId} className="today__source">
                {s.voice ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={playing === s.postId ? 'pause' : 'volume'}
                    aria-pressed={playing === s.postId}
                    onClick={() => {
                      if (playing === s.postId) return stop();
                      flowing.current = false;
                      play(s.voice!.url, s.postId);
                    }}
                  >
                    <bdi>{t('today.hear', { username: s.username })}</bdi>
                  </Button>
                ) : null}
                <Link href={`/p/${s.postId}`} className="catchup__link">
                  <bdi>{t('catchUp.openPost', { name: s.displayName })}</bdi>
                </Link>
              </span>
            ))}
          </div>
          <div className="today__controls">
            <Button size="sm" variant="ghost" icon="skip-previous" disabled={index === 0} onClick={() => go(index - 1)}>
              {t('story.previous')}
            </Button>
            <Button size="sm" variant="ghost" icon="skip-next" disabled={index >= segments.length - 1} onClick={() => go(index + 1)}>
              {t('story.next')}
            </Button>
            <Button size="sm" variant="ghost" icon="x" onClick={() => void notInterested(seg)}>
              {t('today.notInterested')}
            </Button>
          </div>
        </div>
      )}
    </AIPanel>
  );
}
