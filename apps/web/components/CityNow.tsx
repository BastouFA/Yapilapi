'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '@yapilapi/design-system';
import {
  LAUNCH_CITIES,
  MAP_DEFAULT_ZOOM,
  MAP_LAYERS,
  MAP_LAYER_KEYS,
  byDistance,
  queryBox,
  viewBox,
  type LatLng,
  type MapAnswer,
  type MapLayer,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useApproxHere } from '@/components/Market';
import { LAYER_ICONS, MapItemRow, TileMap, type MapView } from '@/components/CityMap';
import { useSession } from '@/app/providers';

/** "What's on now", in this order, a few of each (the nearest first). */
const SECTIONS: MapLayer[] = ['stashes', 'live', 'today', 'places', 'questions', 'market'];
const PER_SECTION = 4;

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/**
 * The top of Wander (docs/product/your-city-alive.md, "The menu"): the city map around you, with
 * the Stashes layer and the others, and what's on now (stashes near you, lives, events tonight,
 * busy places, open questions and Market nearby). Where you are is asked for only on a tap ("Use
 * my location") and stays on this device; without it, your profile's city, or a launch city. Only
 * the part of the map on screen goes to the server.
 */
export function CityNow() {
  const { t, me, flags } = useSession();
  const place = useApproxHere();
  const [view, setView] = useState<MapView | null>(null);
  const [size, setSize] = useState({ width: 800, height: 420 });
  const [answer, setAnswer] = useState<MapAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const seq = useRef(0);
  const stash = flags.STASH !== false;

  const layers = MAP_LAYERS.filter(
    (l) =>
      l !== 'friends' &&
      (l !== 'live' || flags.LIVE) &&
      (l !== 'chains' || flags.PASS_THE_MIC !== false) &&
      (l !== 'questions' || flags.ASK_CITY !== false) &&
      (l !== 'stashes' || (stash && !!me)),
  );

  // Where to start: your profile's city, else Lagos (the first launch city).
  useEffect(() => {
    if (flags.CITY_MAP === false) return;
    api.map
      .center()
      .then(({ center }) => setView((v) => v ?? { center: center?.center ?? LAUNCH_CITIES[0].center, zoom: MAP_DEFAULT_ZOOM }))
      .catch(() => setView((v) => v ?? { center: LAUNCH_CITIES[0].center, zoom: MAP_DEFAULT_ZOOM }));
  }, [flags.CITY_MAP]);

  useEffect(() => {
    if (!view || flags.CITY_MAP === false) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      api.map
        .items(queryBox(viewBox(view.center, view.zoom, size.width, size.height)), layers, zone())
        .then((a) => {
          if (n !== seq.current) return;
          setAnswer(a);
          setProblem(null);
        })
        .catch((e) => n === seq.current && setProblem(e instanceof ApiError && e.code === 'feature_disabled' ? null : errorMessage(e)));
    }, 350);
    return () => clearTimeout(timer);
  }, [view, size]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flags.CITY_MAP === false) return null;

  const go = (center: LatLng) => setView({ center, zoom: MAP_DEFAULT_ZOOM });
  async function toHere() {
    const p = await place.locate();
    if (p) go(p);
  }

  const items = answer?.items ?? [];
  const from: LatLng | null = place.here ?? view?.center ?? null;
  const sections = SECTIONS.filter((l) => layers.includes(l))
    .map((l) => ({
      layer: l,
      items: (from ? byDistance(items, from) : items).filter((i) => i.layer === l).slice(0, PER_SECTION),
    }))
    .filter((s) => s.items.length);

  return (
    <section className="stack city-now" aria-labelledby="city-now">
      <div className="city-now__head">
        <h2 id="city-now" className="section-title">
          {t('near.whatsOn')}
        </h2>
        {me && stash ? (
          <Link href="/stash/new" className="yp-btn yp-btn--primary yp-btn--sm">
            <Icon name="map-pin" size={16} /> {t('stash.hide')}
          </Link>
        ) : null}
      </div>
      <p className="muted city-now__intro">{t('near.intro')}</p>

      <div className="city-now__picks">
        <Button variant="secondary" size="sm" icon="map-pin" loading={place.busy} onClick={() => void toHere()} aria-describedby="city-now-why">
          {t('map.useLocation')}
        </Button>
        <span className="muted">{t('near.pickCity')}</span>
        {LAUNCH_CITIES.map((c) => (
          <Button key={c.key} size="sm" variant="ghost" onClick={() => go(c.center)}>
            {c.name}
          </Button>
        ))}
      </div>
      <p id="city-now-why" className="muted citymap-page__note">
        {t('map.locationWhy')}
      </p>

      {view ? <TileMap view={view} onView={setView} onSize={setSize} items={items} here={place.here} label={t('map.title')} /> : null}
      {problem ? <p className="citymap-page__note">{problem}</p> : null}

      {answer && !sections.length ? <p className="muted">{t('near.empty')}</p> : null}
      {sections.length ? (
        <div className="city-now__sections">
          {sections.map((s) => (
            <div key={s.layer} className="near-section">
              <h3>
                <Icon name={LAYER_ICONS[s.layer]} size={18} /> {t(MAP_LAYER_KEYS[s.layer])}
              </h3>
              <ul className="citymap__list">
                {s.items.map((i) => (
                  <li key={i.key}>
                    <MapItemRow item={i} from={from ?? i.point} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      {me && stash ? (
        <Link href="/stash" className="yp-btn yp-btn--ghost yp-btn--sm city-now__more">
          {t('stash.near')}
        </Link>
      ) : null}
    </section>
  );
}
