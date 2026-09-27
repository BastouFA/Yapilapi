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
  type MessageKey,
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

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

function describe(c: RecapCandidate, locale: string, t: T): string {
  const date = new Date(c.takenAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const length = c.kind === 'video' ? clipLength(c.durationMs) : null;
  const item =
    c.kind !== 'video' ? t('m.recap.photoFrom', { date }) : length ? t('recaps.item.videoLength', { length, date }) : t('m.recap.videoFrom', { date });
  return c.mine ? item : t('recaps.item.fromOther', { item });
}

/** The picture of one photo or video: its thumbnail, a video mark with its length, and a mark when it's someone else's. */
function Thumb({ c }: { c: RecapCandidate }) {
  const { t } = useSession();
  return (
    <span className="recap-thumb">
      {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <Icon name={c.kind === 'video' ? 'play' : 'image'} size={24} />}
      {c.kind === 'video' ? (
        <span className="recap-thumb__badge">
          <Icon name="play" filled size={12} />
          {clipLength(c.durationMs) ?? t('m.create.video')}
        </span>
      ) : null}
      {!c.mine ? (
        <span className="recap-thumb__other" title={t('recaps.fromSomeoneElse')}>
          <Icon name="users" size={12} />
        </span>
      ) : null}
    </span>
  );
}

function Maker() {
  const { flags, toast, locale, t, tp } = useSession();
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

  if (flags.MEMORY === false || (loadError instanceof ApiError && loadError.code === 'feature_disabled')) return <FeatureOff name={t('m.recap.title')} />;

  const header = (
    <div className="yp-topbar">
      <h1>{t('m.recap.make')}</h1>
      <Link href="/recaps" className="yp-btn yp-btn--ghost yp-btn--sm">
        {t('m.recap.yours')}
      </Link>
    </div>
  );

  if (!source || (source !== 'on_this_day' && !sourceId))
    return (
      <div className="yp-shell__inner">
        {header}
        <EmptyState
          title={t('recaps.new.pickTitle')}
          body={t('recaps.new.pickBody')}
          action={
            <Link href="/memories" className="yp-btn yp-btn--secondary">
              {t('recaps.new.goToMemories')}
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
          title={t('recaps.new.cantMake')}
          body={loadError instanceof ApiError ? loadError.message : t('error.generic')}
          action={
            <Link href={backHref(source, sourceId)} className="yp-btn yp-btn--secondary">
              {t('recaps.new.goBack')}
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
          title={t('recaps.new.noItemsTitle')}
          body={t(source === 'on_this_day' ? 'recaps.new.noItemsOnThisDay' : source === 'chapter' ? 'recaps.new.noItemsChapter' : 'recaps.new.noItemsMemory')}
          action={
            <Link href={backHref(source, sourceId)} className="yp-btn yp-btn--secondary">
              {t('recaps.new.goBack')}
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
    setAnnounce(t('recaps.new.moved', { position: to + 1, total: picked.length }));
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
      toast(t('recaps.new.making'));
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
        {t('recaps.new.intro')}
      </p>

      <section className="stack-sm" aria-labelledby="recap-chosen">
        <h2 id="recap-chosen" className="section-title">
          {t('recaps.new.inVideo', { count: picked.length, max: RECAP_MAX_ITEMS })}
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          {t('recaps.new.order')}
        </p>
        {chosen.length ? (
          <ol className="recap-picked">
            {chosen.map((c, n) => {
              const label = describe(c, locale, t);
              return (
                <li key={c.mediaId} className="recap-picked__item">
                  <span className="recap-picked__num" aria-hidden>
                    {n + 1}
                  </span>
                  <Thumb c={c} />
                  <span className="recap-picked__text">{label}</span>
                  <span className="recap-picked__tools">
                    <button
                      type="button"
                      className="recap-tool"
                      aria-label={t('recaps.new.moveEarlier', { item: label })}
                      disabled={n === 0}
                      onClick={() => move(n, n - 1)}
                    >
                      <Icon name="chevron-down" size={18} className="recap-tool__up" />
                    </button>
                    <button
                      type="button"
                      className="recap-tool"
                      aria-label={t('recaps.new.moveLater', { item: label })}
                      disabled={n === chosen.length - 1}
                      onClick={() => move(n, n + 1)}
                    >
                      <Icon name="chevron-down" size={18} />
                    </button>
                    <button
                      type="button"
                      className="recap-tool"
                      aria-label={t('recaps.new.removeItem', { item: label })}
                      onClick={() => {
                        setPicked((p) => p.filter((id) => id !== c.mediaId));
                        setAnnounce(t('recaps.new.removed'));
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
            {t('recaps.new.nothingChosen')}
          </p>
        )}
        {hasOthers ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            <Icon name="users" size={14} /> {t('recaps.new.othersNote')}
          </p>
        ) : null}
        <p className="yp-visually-hidden" role="status" aria-live="polite">
          {announce}
        </p>
      </section>

      {others.length ? (
        <section className="stack-sm" aria-labelledby="recap-more">
          <h2 id="recap-more" className="section-title">
            {t('recaps.new.moreToAdd')}
          </h2>
          {full ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('recaps.new.full', { max: RECAP_MAX_ITEMS })}
            </p>
          ) : null}
          <ul className="recap-grid">
            {others.map((c) => {
              const label = describe(c, locale, t);
              return (
                <li key={c.mediaId}>
                  <button
                    type="button"
                    className="recap-add"
                    disabled={full}
                    aria-label={t('recaps.new.addItem', { item: label })}
                    onClick={() => {
                      setPicked((p) => (p.length >= RECAP_MAX_ITEMS || p.includes(c.mediaId) ? p : [...p, c.mediaId]));
                      setAnnounce(t('recaps.new.added', { position: picked.length + 1 }));
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
          {t('recaps.new.howItLooks')}
        </h2>
        <TextField label={t('m.recap.name')} value={title} maxLength={RECAP_TITLE_MAX} required onChange={(e) => setTitle(e.currentTarget.value)} />

        <fieldset className="recap-choices">
          <legend className="yp-field__label">{t('m.recap.style')}</legend>
          {RECAP_STYLE_CHOICES.map((o) => (
            <label key={o.id} className="recap-choice">
              <input type="radio" name="recap-style" value={o.id} checked={style === o.id} onChange={() => setStyle(o.id)} />
              <span>
                <strong>{t(o.label)}</strong>
                <span className="muted">{t(o.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="recap-choices">
          <legend className="yp-field__label">{t('m.recap.shape')}</legend>
          {RECAP_ASPECT_CHOICES.map((o) => (
            <label key={o.id} className="recap-choice">
              <input type="radio" name="recap-aspect" value={o.id} checked={aspect === o.id} onChange={() => setAspect(o.id)} />
              <span className={`recap-shape recap-shape--${o.id === '1:1' ? 'square' : 'tall'}`} aria-hidden />
              <span>
                <strong>{t(o.label)}</strong>
                <span className="muted">{o.hint ? t(o.hint) : o.id}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Select label={t('m.recap.length')} hint={t('recaps.new.lengthHint')} value={length} onChange={(e) => setLength(e.currentTarget.value)}>
          <option value="auto">{t('m.recap.length.auto')}</option>
          {RECAP_LENGTHS.map((s) => (
            <option key={s} value={String(s)}>
              {t('recaps.new.upToSeconds', { seconds: s })}
            </option>
          ))}
        </Select>

        <div className="stack-sm">
          <span className="yp-field__label">{t('recaps.new.soundOptional')}</span>
          {sound ? (
            <div className="sound-row sound-row--picked">
              <SoundPlayButton sound={sound} />
              <span className="sound-row__text">
                <bdi className="sound-row__title">{sound.title}</bdi>
                <span className="sound-row__meta">
                  {t('recaps.new.playsOver')} · <bdi>@{sound.owner.username}</bdi>
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSound(null)}>
                {t('m.common.remove')}
              </Button>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {t('recaps.new.silent')}
            </p>
          )}
          <div className="row">
            <Button size="sm" variant="secondary" icon="music" onClick={() => setPickingSound(true)}>
              {t(sound ? 'recaps.new.chooseAnotherSound' : 'recaps.new.chooseSound')}
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
          {remaining > 0 ? tp('m.recap.remaining', remaining) : t('m.recap.noneLeft')}
        </p>
        <div className="row">
          <Button loading={busy} disabled={!picked.length || !title.trim() || remaining <= 0} onClick={() => void create()}>
            {t('recaps.new.submit')}
          </Button>
          <Link href={backHref(source, sourceId)} className="yp-btn yp-btn--ghost">
            {t('common.cancel')}
          </Link>
        </div>
        {!picked.length ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {t('m.recap.chooseSome')}
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
