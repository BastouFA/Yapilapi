'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Alert, Button, EmptyState, Icon, Select, Skeleton, TextField } from '@yapilapi/design-system';
import {
  RECAP_LENGTHS,
  RECAP_MAX_ITEMS,
  RECAP_SOURCES,
  RECAP_TITLE_MAX,
  type RecapAspect,
  type RecapCandidate,
  type RecapCandidates,
  type RecapSource,
  type RecapStyle,
  type Sound,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { SoundPicker, SoundPlayButton } from '@/components/SoundPicker';
import { RECAP_ASPECT_CHOICES, RECAP_STYLE_CHOICES, clipLength } from '@/components/Recaps';
import { useSession } from '../../../providers';

function backHref(source: RecapSource, sourceId: string | null): string {
  if (source === 'memory' && sourceId) return `/memories/${sourceId}`;
  if (source === 'chapter' && sourceId) return `/chapters/${sourceId}`;
  return '/memories';
}

function describe(c: RecapCandidate, locale: string): string {
  const day = new Date(c.takenAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const what = c.kind === 'video' ? `Video${clipLength(c.durationMs) ? `, ${clipLength(c.durationMs)}` : ''}` : 'Photo';
  return `${what} from ${day}${c.mine ? '' : ', from someone else'}`;
}

/** The picture of one photo or video: its thumbnail, a video mark with its length, and a mark when it's someone else's. */
function Thumb({ c }: { c: RecapCandidate }) {
  return (
    <span className="recap-thumb">
      {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <Icon name={c.kind === 'video' ? 'play' : 'image'} size={24} />}
      {c.kind === 'video' ? (
        <span className="recap-thumb__badge">
          <Icon name="play" filled size={12} />
          {clipLength(c.durationMs) ?? 'Video'}
        </span>
      ) : null}
      {!c.mine ? (
        <span className="recap-thumb__other" title="From someone else">
          <Icon name="users" size={12} />
        </span>
      ) : null}
    </span>
  );
}

function Maker() {
  const { flags, toast, locale } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const rawSource = params.get('source');
  const source = (RECAP_SOURCES as readonly string[]).includes(rawSource ?? '') ? (rawSource as RecapSource) : null;
  const sourceId = source === 'on_this_day' ? null : params.get('sourceId');

  const [cand, setCand] = useState<RecapCandidates | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<RecapStyle>('calm');
  const [aspect, setAspect] = useState<RecapAspect>('9:16');
  const [length, setLength] = useState<string>('auto');
  const [sound, setSound] = useState<Sound | null>(null);
  const [pickingSound, setPickingSound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    if (!source || flags.MEMORY === false) return;
    if (source !== 'on_this_day' && !sourceId) return;
    let live = true;
    api.recaps.candidates(source, sourceId ?? undefined).then(
      (c) => {
        if (!live) return;
        setCand(c);
        setPicked(c.preselected.slice(0, RECAP_MAX_ITEMS));
        setTitle(c.title.slice(0, RECAP_TITLE_MAX));
      },
      (e) => live && setLoadError(e instanceof Error ? e : new Error(errorMessage(e))),
    );
    return () => {
      live = false;
    };
  }, [source, sourceId, flags.MEMORY]);

  const byId = useMemo(() => new Map((cand?.items ?? []).map((c) => [c.mediaId, c])), [cand]);
  const chosen = picked.map((id) => byId.get(id)).filter((c): c is RecapCandidate => !!c);
  const others = (cand?.items ?? []).filter((c) => !picked.includes(c.mediaId));
  const full = picked.length >= RECAP_MAX_ITEMS;
  const remaining = cand?.remainingToday ?? 0;
  const hasOthers = chosen.some((c) => !c.mine);

  if (flags.MEMORY === false || (loadError instanceof ApiError && loadError.code === 'feature_disabled')) return <FeatureOff name="Recap videos" />;

  const header = (
    <div className="yp-topbar">
      <h1>Make a recap video</h1>
      <Link href="/recaps" className="yp-btn yp-btn--ghost yp-btn--sm">
        Your recaps
      </Link>
    </div>
  );

  if (!source || (source !== 'on_this_day' && !sourceId))
    return (
      <div className="yp-shell__inner">
        {header}
        <EmptyState
          title="Choose what to make it from"
          body="Open a memory or one of your chapters and choose Make a recap video, or make one from On this day in Memories."
          action={
            <Link href="/memories" className="yp-btn yp-btn--secondary">
              Go to Memories
            </Link>
          }
        />
      </div>
    );

  if (loadError)
    return (
      <div className="yp-shell__inner">
        {header}
        <EmptyState
          title="Can't make a recap from this"
          body={loadError instanceof ApiError ? loadError.message : 'Something went wrong. Try again.'}
          action={
            <Link href={backHref(source, sourceId)} className="yp-btn yp-btn--secondary">
              Go back
            </Link>
          }
        />
      </div>
    );

  if (!cand)
    return (
      <div className="yp-shell__inner">
        {header}
        <Skeleton height={160} />
        <Skeleton height={240} />
      </div>
    );

  if (!cand.items.length)
    return (
      <div className="yp-shell__inner">
        {header}
        <EmptyState
          title="No photos or videos to use"
          body={
            source === 'on_this_day'
              ? 'A recap is made from photos and videos you shared on this day in earlier years. There are none yet.'
              : source === 'chapter'
                ? 'A recap is made from the photos and videos in this chapter. Add some stories to it first.'
                : 'A recap is made from the photos and videos in this memory that you can see. Add some posts with photos or videos to it first.'
          }
          action={
            <Link href={backHref(source, sourceId)} className="yp-btn yp-btn--secondary">
              Go back
            </Link>
          }
        />
      </div>
    );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= picked.length) return;
    setPicked((p) => {
      const next = [...p];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
    setAnnounce(`Moved to position ${to + 1} of ${picked.length}.`);
  };

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { recap } = await api.recaps.create({
        source: source!,
        ...(sourceId ? { sourceId } : {}),
        title: title.trim(),
        mediaIds: picked,
        style,
        aspect,
        ...(sound ? { soundId: sound.id } : {}),
        ...(length !== 'auto' ? { lengthSeconds: Number(length) } : {}),
      });
      toast("We're making your recap video. We'll let you know when it's ready.");
      router.push(`/recaps?open=${recap.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'recap_limit') setCand((c) => (c ? { ...c, remainingToday: 0 } : c));
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="yp-shell__inner">
      {header}
      <p className="muted" style={{ margin: 0 }}>
        A short video made from photos and videos you choose. Only you see it until you decide to share it.
      </p>

      <section className="stack-sm" aria-labelledby="recap-chosen">
        <h2 id="recap-chosen" className="section-title">
          In your video ({picked.length} of {RECAP_MAX_ITEMS})
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          They play in this order.
        </p>
        {chosen.length ? (
          <ol className="recap-picked">
            {chosen.map((c, n) => {
              const label = describe(c, locale);
              return (
                <li key={c.mediaId} className="recap-picked__item">
                  <span className="recap-picked__num" aria-hidden>
                    {n + 1}
                  </span>
                  <Thumb c={c} />
                  <span className="recap-picked__text">{label}</span>
                  <span className="recap-picked__tools">
                    <button type="button" className="recap-tool" aria-label={`Move ${label} earlier`} disabled={n === 0} onClick={() => move(n, n - 1)}>
                      <Icon name="chevron-down" size={18} className="recap-tool__up" />
                    </button>
                    <button
                      type="button"
                      className="recap-tool"
                      aria-label={`Move ${label} later`}
                      disabled={n === chosen.length - 1}
                      onClick={() => move(n, n + 1)}
                    >
                      <Icon name="chevron-down" size={18} />
                    </button>
                    <button
                      type="button"
                      className="recap-tool"
                      aria-label={`Remove ${label}`}
                      onClick={() => {
                        setPicked((p) => p.filter((id) => id !== c.mediaId));
                        setAnnounce('Removed from your video.');
                      }}
                    >
                      <Icon name="x" size={18} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Nothing chosen yet. Add photos or videos from below.
          </p>
        )}
        {hasOthers ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            <Icon name="users" size={14} /> Some of these are from other people. You can watch and save the video, but you won&apos;t be able to post it as a
            reel.
          </p>
        ) : null}
        <p className="yp-visually-hidden" role="status" aria-live="polite">
          {announce}
        </p>
      </section>

      {others.length ? (
        <section className="stack-sm" aria-labelledby="recap-more">
          <h2 id="recap-more" className="section-title">
            More to add
          </h2>
          {full ? (
            <p className="muted" style={{ margin: 0 }}>
              You&apos;ve chosen {RECAP_MAX_ITEMS}, the most a recap can have. Remove one to add another.
            </p>
          ) : null}
          <ul className="recap-grid">
            {others.map((c) => {
              const label = describe(c, locale);
              return (
                <li key={c.mediaId}>
                  <button
                    type="button"
                    className="recap-add"
                    disabled={full}
                    aria-label={`Add ${label}`}
                    onClick={() => {
                      setPicked((p) => (p.length >= RECAP_MAX_ITEMS || p.includes(c.mediaId) ? p : [...p, c.mediaId]));
                      setAnnounce(`Added as number ${picked.length + 1}.`);
                    }}
                  >
                    <Thumb c={c} />
                    <span className="recap-add__plus" aria-hidden>
                      <Icon name="plus" size={16} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="stack" aria-labelledby="recap-settings">
        <h2 id="recap-settings" className="section-title">
          How it looks
        </h2>
        <TextField label="Title" value={title} maxLength={RECAP_TITLE_MAX} required onChange={(e) => setTitle(e.currentTarget.value)} />

        <fieldset className="recap-choices">
          <legend className="yp-field__label">Style</legend>
          {RECAP_STYLE_CHOICES.map((o) => (
            <label key={o.id} className="recap-choice">
              <input type="radio" name="recap-style" value={o.id} checked={style === o.id} onChange={() => setStyle(o.id)} />
              <span>
                <strong>{o.label}</strong>
                <span className="muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="recap-choices">
          <legend className="yp-field__label">Shape</legend>
          {RECAP_ASPECT_CHOICES.map((o) => (
            <label key={o.id} className="recap-choice">
              <input type="radio" name="recap-aspect" value={o.id} checked={aspect === o.id} onChange={() => setAspect(o.id)} />
              <span className={`recap-shape recap-shape--${o.id === '1:1' ? 'square' : 'tall'}`} aria-hidden />
              <span>
                <strong>{o.label}</strong>
                <span className="muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Select
          label="Length"
          hint="Auto gives each photo and clip the time it needs, up to 60 seconds."
          value={length}
          onChange={(e) => setLength(e.currentTarget.value)}
        >
          <option value="auto">Auto</option>
          {RECAP_LENGTHS.map((s) => (
            <option key={s} value={String(s)}>
              Up to {s} seconds
            </option>
          ))}
        </Select>

        <div className="stack-sm">
          <span className="yp-field__label">Sound (optional)</span>
          {sound ? (
            <div className="sound-row sound-row--picked">
              <SoundPlayButton sound={sound} />
              <span className="sound-row__text">
                <bdi className="sound-row__title">{sound.title}</bdi>
                <span className="sound-row__meta">
                  Plays over your video · <bdi>@{sound.owner.username}</bdi>
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSound(null)}>
                Remove
              </Button>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Without a sound, the video is silent.
            </p>
          )}
          <div className="row">
            <Button size="sm" variant="secondary" icon="music" onClick={() => setPickingSound(true)}>
              {sound ? 'Choose another sound' : 'Choose a sound'}
            </Button>
          </div>
          <SoundPicker
            open={pickingSound}
            onClose={() => setPickingSound(false)}
            onPick={(s) => {
              setSound(s);
              setPickingSound(false);
            }}
          />
        </div>
      </section>

      <div className="stack-sm">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p className="muted" style={{ margin: 0 }}>
          {remaining > 0
            ? `You can make ${remaining} more ${remaining === 1 ? 'recap' : 'recaps'} today.`
            : "You've made as many recaps as you can today. You can make more tomorrow."}
        </p>
        <div className="row">
          <Button loading={busy} disabled={!picked.length || !title.trim() || remaining <= 0} onClick={() => void create()}>
            Make the video
          </Button>
          <Link href={backHref(source, sourceId)} className="yp-btn yp-btn--ghost">
            Cancel
          </Link>
        </div>
        {!picked.length ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Choose at least one photo or video.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function NewRecapPage() {
  return (
    <Suspense>
      <Maker />
    </Suspense>
  );
}
