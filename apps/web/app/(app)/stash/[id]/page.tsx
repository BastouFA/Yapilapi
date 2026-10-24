'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Skeleton, TextField } from '@yapilapi/design-system';
import {
  MAP_DEFAULT_ZOOM,
  STASH_AUDIENCE_KEYS,
  STASH_KIND_KEYS,
  STASH_REACTIONS,
  STASH_REACTION_KEYS,
  STASH_THANKS_MAX,
  distanceMetres,
  mapDistance,
  type MapItem,
  type StashCard,
  type StashFind,
  type StashReaction,
} from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { TileMap, type MapView } from '@/components/CityMap';
import { ReportSheet } from '@/components/ReportSheet';
import { Person, StashInside, TakeBackButton, hiddenBy, usePrecisePosition } from '@/components/Stash';
import { useApproxHere } from '@/components/Market';
import { useSession } from '../../../providers';

const REACTION_ICONS = { thanks: 'heart', love: 'heart', laugh: 'sparkle', wow: 'star' } as const;

/**
 * A stash's page (docs/product/stash.md): roughly where it is (its area on a small map, never the
 * spot), its title, hint and who hid it, and "Open it here", which sends where the device is now.
 * Opened: what's inside and a thank-you. Yours: your spot, who it's for, who found it, take it back.
 */
export default function StashPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t, tp, locale, toast, flags } = useSession();
  const [stash, setStash] = useState<StashCard | null>(null);
  const [finds, setFinds] = useState<StashFind[]>([]);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<MapView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [thanks, setThanks] = useState('');
  const [reaction, setReaction] = useState<StashReaction | null>(null);
  const [thanked, setThanked] = useState(false);
  const precise = usePrecisePosition();
  const approx = useApproxHere();

  const load = useCallback(() => {
    api.stash.get(id).then(
      (r) => {
        setStash(r.stash);
        setFinds(r.finds);
        setView((v) => v ?? { center: r.stash.area.center, zoom: MAP_DEFAULT_ZOOM + 3 });
      },
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(load, [load]);

  if (flags.STASH === false) return <FeatureOff name={t('stash.title')} />;
  if (missing) return <EmptyState level={1} title={t('stash.ended')} />;
  if (loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!stash || !view)
    return (
      <div className="yp-shell__inner stack" aria-busy>
        <Skeleton height={40} />
        <Skeleton height={240} />
      </div>
    );

  async function open() {
    setOpening(true);
    setNote(null);
    try {
      const pos = await precise.locate();
      if (!pos) return;
      const r = await api.stash.open(id, pos);
      setStash(r.stash);
      if (!r.opened)
        setNote(
          r.toGoMetres
            ? t('stash.toGo', { distance: mapDistance(t, r.toGoMetres, locale) ?? t('location.distance.m', { n: r.toGoMetres }) })
            : t('stash.keepLooking'),
        );
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }

  async function sendThanks() {
    try {
      await api.stash.thank(id, { reaction: reaction ?? undefined, text: thanks.trim() || undefined });
      setThanked(true);
      toast(t('stash.thanked'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const from = precise.pos ?? approx.here;
  const away = from ? mapDistance(t, distanceMetres(from, stash.area.center), locale) : null;
  const area: MapItem = {
    key: `stashes:${stash.id}`,
    layer: 'stashes',
    title: stash.title ?? '',
    subtitle: stash.hint,
    point: stash.area.center,
    approximate: true,
    at: stash.createdAt,
    endsAt: stash.expiresAt,
    thumbUrl: null,
    count: stash.finds,
    user: stash.owner,
    target: { kind: 'stash', id: stash.id },
  };
  const unavailable = stash.ended || (stash.taken && !stash.found);

  return (
    <div className="yp-shell__inner stack stash-page">
      <div className="yp-topbar">
        <h1>{stash.title || t('stash.untitled')}</h1>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <Badge>{t(STASH_KIND_KEYS[stash.kind])}</Badge>
        {stash.firstOnly ? <Badge tone="warning">{t('stash.firstOnly')}</Badge> : null}
        {stash.mine ? <Badge>{t(STASH_AUDIENCE_KEYS[stash.audience])}</Badge> : null}
        {stash.expiresAt ? (
          <Badge>{t('stash.until', { date: new Date(stash.expiresAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}</Badge>
        ) : null}
      </div>
      <p className="muted">{[hiddenBy(t, stash), stash.city, stash.finds ? tp('stash.finds', stash.finds) : null].filter(Boolean).join(' · ')}</p>
      {stash.hint ? <p className="stash-page__hint">{stash.hint}</p> : null}

      <TileMap view={view} onView={setView} onSize={() => {}} items={[area]} here={from} label={t('stash.areaNote')} />
      <p className="muted">
        {away ? `${t('stash.away', { distance: away })} · ` : ''}
        {t('stash.areaNote')}
      </p>

      {stash.mine ? (
        <section className="stack" aria-label={t('stash.mine')}>
          {stash.moderation && stash.moderation !== 'normal' ? <p className="stash-page__held">{t('stash.held')}</p> : null}
          {stash.point ? <p className="muted">{t('stash.yourSpot', { point: `${stash.point.lat.toFixed(5)}, ${stash.point.lng.toFixed(5)}` })}</p> : null}
          {stash.recipient ? <p>{t('stash.for', { name: stash.recipient.displayName })}</p> : null}
          {stash.squad ? <p>{t('stash.for', { name: stash.squad.name })}</p> : null}
          {stash.content ? <StashInside content={stash.content} /> : null}
          <h2>{t('stash.whoFound')}</h2>
          {finds.length ? (
            <ul className="stack stash-finds">
              {finds.map((f) => (
                <li key={f.finder.id} className="stack" style={{ gap: 4 }}>
                  <Person name={f.finder.displayName} src={f.finder.avatarUrl} />
                  {f.reaction || f.thanks ? (
                    <span className="muted">{[f.reaction ? t(STASH_REACTION_KEYS[f.reaction]) : null, f.thanks].filter(Boolean).join(' · ')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{tp('stash.finds', 0)}</p>
          )}
          {!stash.ended ? <TakeBackButton id={stash.id} onDone={() => router.push('/stash')} /> : null}
        </section>
      ) : stash.found && stash.content ? (
        <section className="stack" aria-label={t('stash.opened')}>
          <h2>{t('stash.opened')}</h2>
          <StashInside content={stash.content} />
          {stash.owner && !thanked ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void sendThanks();
              }}
            >
              <fieldset className="stash-reactions">
                <legend>{t('stash.thank')}</legend>
                {STASH_REACTIONS.map((r) => (
                  <Button
                    key={r}
                    type="button"
                    variant={reaction === r ? 'primary' : 'ghost'}
                    size="sm"
                    aria-pressed={reaction === r}
                    icon={REACTION_ICONS[r]}
                    onClick={() => setReaction(reaction === r ? null : r)}
                  >
                    {t(STASH_REACTION_KEYS[r])}
                  </Button>
                ))}
              </fieldset>
              <TextField label={t('stash.thanksPlaceholder')} value={thanks} maxLength={STASH_THANKS_MAX} onChange={(e) => setThanks(e.currentTarget.value)} />
              <div className="row">
                <Button type="submit" disabled={!reaction && !thanks.trim()}>
                  {t('stash.thank')}
                </Button>
              </div>
            </form>
          ) : thanked ? (
            <p role="status">{t('stash.thanked')}</p>
          ) : null}
        </section>
      ) : unavailable ? (
        <p role="status">{stash.ended ? t('stash.ended') : t('stash.taken')}</p>
      ) : (
        <section className="stack">
          <div className="row">
            <Button icon="map-pin" loading={opening || precise.busy} onClick={() => void open()}>
              {t('stash.open')}
            </Button>
          </div>
          {precise.pos ? <p className="muted">{t('stash.form.accuracy', { n: precise.pos.accuracy })}</p> : null}
          {note || precise.problem ? (
            <p className="stash-page__note" role="status">
              {note ?? precise.problem}
            </p>
          ) : null}
        </section>
      )}

      {!stash.mine ? (
        <div className="row">
          <Button variant="ghost" size="sm" icon="flag" onClick={() => setReporting(true)}>
            {t('post.report')}
          </Button>
        </div>
      ) : null}
      <ReportSheet target={reporting ? { type: 'stash', id: stash.id } : null} onClose={() => setReporting(false)} />
    </div>
  );
}
