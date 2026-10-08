'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar, BottomSheet, Button, EmptyState, Icon, Select, Switch, VoiceTranscript } from '@yapilapi/design-system';
import {
  formatBytes,
  resamplePeaks,
  RADIO_SLEEP_MINUTES,
  seekMs,
  sleepClock,
  stationId,
  voiceClock,
  VOICE_PEAKS,
  type RadioStation,
  type RadioStationInfo,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { Comments } from '@/components/Comments';
import { FeatureOff } from '@/components/FeatureOff';
import { useRadio } from '@/components/Radio';
import { api } from '@/lib/api';
import { NextLink } from '@/lib/link';

const MAIN: RadioStationInfo[] = (['for_you', 'friends', 'near', 'topics'] as const).map((kind) => ({ kind, key: null, title: null }));
const KEY_STEP_MS = 5000;

/**
 * Yap Radio's own page: the stations, and the Yap playing now, big: who's speaking, the waveform,
 * the words following along (in your language when you don't understand the speaker's), play,
 * back and next, like, reply by voice, follow, speed, a sleep timer and "Listen in my language".
 */
export default function RadioPage() {
  const { t, flags, locale, me, voice } = useSession();
  const radio = useRadio();
  const [stations, setStations] = useState<RadioStationInfo[]>(MAIN);
  const [replying, setReplying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!radio) return;
    let live = true;
    api.radio.stations().then(
      (r) => live && setStations(r.stations),
      () => {},
    );
    return () => {
      live = false;
    };
    // Once, when the radio is there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!radio]);

  // The sleep timer's clock.
  const sleepAt = radio?.sleepAt ?? null;
  useEffect(() => {
    if (!sleepAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sleepAt]);

  // The words being spoken stay in view.
  const words = useRef<HTMLDivElement>(null);
  const position = radio?.positionMs ?? 0;
  useEffect(() => {
    const box = words.current;
    const line = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !line) return;
    const top = line.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - line.offsetHeight)
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: 'smooth' });
  }, [position]);

  if (flags.YAPS === false || flags.YAP_RADIO === false || !radio) return <FeatureOff name={t('radio.title')} />;

  const p = radio.current;
  const clip = p?.voice ?? null;
  const playingId = radio.station ? stationId(radio.station) : null;
  const pick = (s: RadioStation) => radio.play(s);
  const duration = radio.durationMs || clip?.durationMs || 1;
  const played = Math.min(1, radio.positionMs / duration);
  const bars = clip ? resamplePeaks(clip.peaks, VOICE_PEAKS) : [];
  const followingAuthor = p ? radio.following.has(p.author.id) : false;
  const sleepValue = radio.sleepAt ? 'on' : 'off';

  return (
    <div className="yp-shell__inner radio" data-radio-keys>
      <div className="yp-topbar">
        <h1>{t('radio.title')}</h1>
      </div>

      <nav aria-label={t('radio.stations')} className="radio__stations">
        {stations.map((s) => {
          const id = stationId(s);
          return (
            <button
              key={id}
              type="button"
              className="radio__station"
              aria-pressed={playingId === id}
              onClick={() => pick({ kind: s.kind, key: s.key })}
              data-testid={`radio-station-${s.kind}`}
            >
              {radio.stationName(s)}
            </button>
          );
        })}
      </nav>

      {!radio.station ? (
        <div className="radio__start">
          <button type="button" className="radio__big" onClick={() => radio.play()} aria-label={t('voice.play')} data-testid="radio-start">
            <Icon name="play" size={40} filled />
          </button>
          <p className="radio__muted">{t('radio.shortcuts')}</p>
        </div>
      ) : radio.error && !p ? (
        <EmptyState title={radio.error} action={<Button onClick={() => radio.play(radio.station ?? undefined)}>{t('m.common.retry')}</Button>} />
      ) : radio.ended && !p ? (
        <EmptyState title={t(radio.needsPlace ? 'radio.nearNone' : 'radio.empty')} />
      ) : !p || !clip ? (
        <div className="radio__now" aria-busy>
          <div className="radio__speaker radio__speaker--loading" />
        </div>
      ) : (
        <article className="radio__now" aria-labelledby="radio-speaker" data-testid="radio-now" data-post={p.id}>
          <p className="radio__on">{t('radio.nowPlaying', { station: radio.stationName(radio.station) })}</p>
          <NextLink href={`/u/${p.author.username}`} className="radio__speaker">
            <Avatar name={p.author.displayName} src={p.author.avatarUrl} size="xl" />
            <span id="radio-speaker" className="radio__name" data-testid="radio-speaker">
              {p.author.displayName}
            </span>
          </NextLink>
          {p.body.trim() ? (
            <p className="radio__line" dir="auto">
              {p.body}
            </p>
          ) : null}

          <div
            className="yp-voice__wave radio__wave"
            role="slider"
            tabIndex={0}
            aria-label={t('voice.seek')}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration / 1000)}
            aria-valuenow={Math.round(radio.positionMs / 1000)}
            aria-valuetext={`${voiceClock(radio.positionMs)} / ${voiceClock(duration)}`}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              if (box.width > 0) radio.seek(seekMs((e.clientX - box.left) / box.width, duration));
            }}
            onKeyDown={(e) => {
              const to = e.key === 'ArrowLeft' ? radio.positionMs - KEY_STEP_MS : e.key === 'ArrowRight' ? radio.positionMs + KEY_STEP_MS : null;
              if (to === null) return;
              e.preventDefault();
              radio.seek(Math.min(duration, Math.max(0, to)));
            }}
          >
            <svg viewBox={`0 0 ${bars.length * 4} 40`} preserveAspectRatio="none" aria-hidden focusable="false">
              {bars.map((v, i) => {
                const h = Math.max(3, (v / 100) * 40);
                return (
                  <rect
                    key={i}
                    x={i * 4 + 0.6}
                    y={(40 - h) / 2}
                    width={2.8}
                    height={h}
                    rx={1.4}
                    className={(i + 0.5) / bars.length <= played ? 'is-played' : undefined}
                  />
                );
              })}
            </svg>
          </div>
          <p className="radio__clock" aria-hidden>
            {voiceClock(radio.positionMs)} / {voiceClock(duration)}
          </p>

          <div className="radio__controls">
            <button type="button" className="radio__ctl" onClick={radio.previous} aria-label={t('radio.previous')} data-testid="radio-previous">
              <Icon name="skip-previous" size={26} filled />
            </button>
            <button
              type="button"
              className="radio__ctl radio__ctl--main"
              onClick={radio.toggle}
              aria-label={radio.playing ? t('voice.pause') : t('voice.play')}
              data-testid="radio-toggle"
            >
              <Icon name={radio.playing ? 'pause' : 'play'} size={32} filled />
            </button>
            <button type="button" className="radio__ctl" onClick={radio.next} aria-label={t('radio.next')} data-testid="radio-next">
              <Icon name="skip-next" size={26} filled />
            </button>
          </div>

          <div className="radio__actions">
            <Button size="sm" variant={p.viewer.liked ? 'primary' : 'secondary'} icon="heart" aria-pressed={p.viewer.liked} onClick={radio.like}>
              {t(p.viewer.liked ? 'post.unlike' : 'post.like')}
            </Button>
            {p.viewer.canComment !== false ? (
              <Button
                size="sm"
                variant="secondary"
                icon="mic"
                onClick={() => {
                  if (radio.playing) radio.toggle();
                  setReplying(true);
                }}
              >
                {t('voice.reply')}
              </Button>
            ) : null}
            {p.author.id !== me?.id ? (
              <Button size="sm" variant="secondary" icon={followingAuthor ? 'check' : 'user-plus'} aria-pressed={followingAuthor} onClick={radio.follow}>
                {t(followingAuthor ? 'profile.unfollow' : 'profile.follow')}
              </Button>
            ) : null}
            <button
              type="button"
              className="yp-voice__rate"
              aria-label={t('voice.speed', { rate: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(radio.rate) })}
              onClick={radio.changeRate}
            >
              {`${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(radio.rate)}×`}
            </button>
          </div>

          <div className="radio__settings">
            <div className="radio__sleep">
              <Select
                label={t('radio.sleep')}
                value={sleepValue}
                onChange={(e) => radio.setSleep(e.target.value === 'off' ? null : Number(e.target.value))}
                data-testid="radio-sleep"
              >
                {radio.sleepAt ? <option value="on">{t('radio.sleepLeft', { time: sleepClock(radio.sleepAt - now) })}</option> : null}
                <option value="off">{t('dataSaver.off')}</option>
                {RADIO_SLEEP_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {t('mixes.minutes', { n: m })}
                  </option>
                ))}
              </Select>
            </div>
            {voice.listen ? <Switch label={t('radio.myLanguage')} checked={radio.myLanguage} onChange={radio.setMyLanguage} /> : null}
          </div>

          {clip.transcript.status === 'ready' && clip.transcript.text ? (
            <div className="radio__words yp-voice__words" ref={words} role="region" aria-label={t('voice.transcript')}>
              <VoiceTranscript
                key={clip.id}
                clip={clip}
                own={p.author.id === me?.id}
                locale={locale}
                at={radio.spoken ? -1 : radio.positionMs / 1000}
                playing={!radio.spoken && (radio.playing || radio.positionMs > 0)}
                onSeek={(s) => radio.seek(s * 1000)}
              />
            </div>
          ) : null}
        </article>
      )}

      {radio.station ? (
        <>
          {radio.queue.length > radio.index + 1 ? (
            <section className="radio__next" aria-labelledby="radio-next-title">
              <h2 id="radio-next-title" className="radio__h2">
                {t('watch.queue')}
              </h2>
              <ol>
                {radio.queue.slice(radio.index + 1, radio.index + 4).map((x) => (
                  <li key={x.id}>
                    <Avatar name={x.author.displayName} src={x.author.avatarUrl} size="sm" />
                    <span>{x.author.displayName}</span>
                    <span className="radio__muted">{voiceClock(x.voice?.durationMs ?? 0)}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          <p className="radio__muted" data-testid="radio-data">
            {t('radio.data', { size: formatBytes(radio.bytes) })}
          </p>
          <p className="radio__muted radio__keys">{t('radio.shortcuts')}</p>
        </>
      ) : null}

      {replying && p ? (
        <BottomSheet open onClose={() => setReplying(false)} title={t('voice.reply')} locale={locale}>
          <Comments post={p} onCountChange={() => {}} startVoice />
        </BottomSheet>
      ) : null}
    </div>
  );
}
