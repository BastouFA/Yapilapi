'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Icon, TextField } from '@yapilapi/design-system';
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
import { useSession } from '../../providers';

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
 * Near, the home of "Your city, alive" (docs/product/your-city-alive.md): the city map around you
 * and what's on now (stashes near you, lives, events tonight, busy places, open questions and
 * Market nearby), with search and Explore (Wander) at the top. Where you are is asked for only on a
 * tap ("Use my location") and stays on this device; without it, your profile's city, or a launch
 * city. Only the part of the map on screen goes to the server.
 */
export default function NearPage() {
  const { t, me, flags } = useSession();
  const router = useRouter();
  const place = useApproxHere();
  const [view, setView] = useState<MapView | null>(null);
  const [size, setSize] = useState({ width: 800, height: 420 });
  const [answer, setAnswer] = useState<MapAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const seq = useRef(0);

  const layers = MAP_LAYERS.filter(
    (l) =>
      l !== 'friends' &&
      (l !== 'live' || flags.LIVE) &&
      (l !== 'chains' || flags.PASS_THE_MIC !== false) &&
      (l !== 'questions' || flags.ASK_CITY !== false) &&
      (l !== 'stashes' || flags.STASH !== false),
  );

  // Where to start: your profile's city, else Lagos (the first launch city).
  useEffect(() => {
    api.map
      .center()
      .then(({ center }) => setView((v) => v ?? { center: center?.center ?? LAUNCH_CITIES[0].center, zoom: MAP_DEFAULT_ZOOM }))
      .catch(() => setView((v) => v ?? { center: LAUNCH_CITIES[0].center, zoom: MAP_DEFAULT_ZOOM }));
  }, []);

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

  const go = (center: LatLng) => setView({ center, zoom: MAP_DEFAULT_ZOOM });
  async function toHere() {
    const p = await place.locate();
    if (p) go(p);
  }
  function search(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  const items = answer?.items ?? [];
  const from: LatLng | null = place.here ?? view?.center ?? null;
  const sections = SECTIONS.filter((l) => layers.includes(l)).map((l) => ({
    layer: l,
    items: (from ? byDistance(items, from) : items).filter((i) => i.layer === l).slice(0, PER_SECTION),
  }));
  const nothing = answer && !items.length;

  return (
    <div className="yp-shell__inner yp-shell__inner--wide stack near-page">
      <div className="near-page__head">
        <h1>{t('nav.near')}</h1>
        <Link href="/discover" className="yp-btn yp-btn--ghost yp-btn--sm">
          <Icon name="compass" size={16} /> {t('near.explore')}
        </Link>
      </div>
      <form className="near-page__search" role="search" onSubmit={search}>
        <TextField label={t('m.discover.search')} value={q} maxLength={100} onChange={(e) => setQ(e.currentTarget.value)} />
        <Button type="submit" variant="ghost">
          {t('m.discover.search')}
        </Button>
      </form>
      <p className="muted citymap-page__intro">{t('near.intro')}</p>

      <div className="near-page__picks">
        <Button variant="secondary" size="sm" icon="map-pin" loading={place.busy} onClick={() => void toHere()} aria-describedby="near-why">
          {t('map.useLocation')}
        </Button>
        <span className="muted">{t('near.pickCity')}</span>
        {LAUNCH_CITIES.map((c) => (
          <Button key={c.key} size="sm" variant="ghost" onClick={() => go(c.center)}>
            {c.name}
          </Button>
        ))}
      </div>
      <p id="near-why" className="muted citymap-page__note">
        {t('map.locationWhy')}
      </p>

      {view && flags.CITY_MAP !== false ? (
        <TileMap view={view} onView={setView} onSize={setSize} items={items} here={place.here} label={t('nav.near')} />
      ) : null}
      {problem ? <p className="citymap-page__note">{problem}</p> : null}

      <section className="stack" aria-labelledby="near-on">
        <div className="near-page__head">
          <h2 id="near-on">{t('near.whatsOn')}</h2>
          {me && flags.STASH !== false ? (
            <Link href="/stash/new" className="yp-btn yp-btn--primary yp-btn--sm">
              <Icon name="map-pin" size={16} /> {t('stash.hide')}
            </Link>
          ) : null}
        </div>
        {nothing ? <p className="muted">{t('near.empty')}</p> : null}
        {sections
          .filter((s) => s.items.length)
          .map((s) => (
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
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {flags.STASH !== false ? (
            <Link href="/stash" className="yp-btn yp-btn--ghost yp-btn--sm">
              {t('stash.near')}
            </Link>
          ) : null}
          <Link href="/map" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('map.title')}
          </Link>
        </div>
      </section>
    </div>
  );
}
