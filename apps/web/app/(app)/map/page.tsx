'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Select, Switch, TextField } from '@yapilapi/design-system';
import {
  MAP_DEFAULT_ZOOM,
  MAP_LAYER_KEYS,
  MAP_LAYERS,
  MAP_PRESENCE_DURATIONS,
  MAP_PRESENCE_KEYS,
  byDistance,
  clockTime,
  queryBox,
  viewBox,
  type LatLng,
  type MapAnswer,
  type MapLayer,
  type MapPresence,
  type MapPresenceDuration,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { useApproxHere } from '@/components/Market';
import { MapItemRow, TileMap, type MapView } from '@/components/CityMap';
import { useSession } from '../../providers';

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** Whether this site may already read where the browser is (so the page can start there without asking). */
async function geoAllowed(): Promise<boolean> {
  try {
    return (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Near you (docs/product/city-map.md): what's happening around you right now, on a map and as a
 * list. Starts where the browser is when the site may already read it, else in your profile's
 * city, else asks for a city. Only the part of the map on screen goes to the server; where you
 * are stays in this page (rounded to about a kilometre), except for "Show me on the map to friends".
 */
export default function MapPage() {
  const { t, me, flags, locale, toast } = useSession();
  const place = useApproxHere();
  const [view, setView] = useState<MapView | null>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [layers, setLayers] = useState<MapLayer[]>([...MAP_LAYERS]);
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [answer, setAnswer] = useState<MapAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [city, setCity] = useState('');
  const [cityNote, setCityNote] = useState<string | null>(null);
  const [looking, setLooking] = useState(true);
  const [presence, setPresence] = useState<MapPresence | null>(null);
  const [duration, setDuration] = useState<MapPresenceDuration>('1h');
  const [presenceBusy, setPresenceBusy] = useState(false);
  const seq = useRef(0);

  // Where to start: the browser (when already allowed), the profile's city, or a search.
  useEffect(() => {
    let gone = false;
    (async () => {
      if (await geoAllowed()) {
        const p = await place.locate();
        if (p && !gone) {
          setView({ center: p, zoom: MAP_DEFAULT_ZOOM });
          setLooking(false);
          return;
        }
      }
      try {
        const { center } = await api.map.center();
        if (!gone && center) setView({ center: center.center, zoom: MAP_DEFAULT_ZOOM - 1 });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'feature_disabled') setOff(true);
      } finally {
        if (!gone) setLooking(false);
      }
    })();
    return () => {
      gone = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // "Show me on the map to friends": yours, and moved to where you are when it's on.
  useEffect(() => {
    if (!me) return;
    api.map
      .presence()
      .then(({ presence: p }) => setPresence(p))
      .catch(() => {});
  }, [me]);
  useEffect(() => {
    if (!presence || !place.here) return;
    if (presence.point.lat === place.here.lat && presence.point.lng === place.here.lng) return;
    api.map
      .showMe({ ...place.here })
      .then(({ presence: p }) => setPresence(p))
      .catch(() => {});
  }, [place.here]); // eslint-disable-line react-hooks/exhaustive-deps

  // What's in the box, a moment after the map stops moving.
  useEffect(() => {
    if (!view || !layers.length) {
      setAnswer(layers.length ? null : { items: [], more: [] });
      return;
    }
    const n = ++seq.current;
    const timer = setTimeout(() => {
      api.map
        .items(queryBox(viewBox(view.center, view.zoom, size.width, size.height)), layers, zone())
        .then((a) => {
          if (n !== seq.current) return;
          setAnswer(a);
          setLoadError(null);
        })
        .catch((e) => {
          if (n !== seq.current) return;
          if (e instanceof ApiError && e.code === 'feature_disabled') setOff(true);
          else setLoadError(errorMessage(e));
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [view, size, layers]);

  const toHere = useCallback(async () => {
    const p = await place.locate();
    if (p) setView({ center: p, zoom: Math.max(view?.zoom ?? MAP_DEFAULT_ZOOM, MAP_DEFAULT_ZOOM) });
  }, [place, view]);

  async function findCity(e: FormEvent) {
    e.preventDefault();
    if (!city.trim()) return;
    setCityNote(null);
    try {
      const { center } = await api.map.center(city.trim());
      if (center) setView({ center: center.center, zoom: MAP_DEFAULT_ZOOM - 1 });
      else setCityNote(t('map.cityNotFound'));
    } catch (err) {
      setCityNote(errorMessage(err));
    }
  }

  async function showMe(on: boolean, d = duration) {
    setPresenceBusy(true);
    try {
      if (!on) {
        await api.map.stop();
        setPresence(null);
        return;
      }
      const p = place.here ?? (await place.locate());
      if (!p) return;
      setPresence((await api.map.showMe({ ...p, duration: d, timeZone: zone() })).presence);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setPresenceBusy(false);
    }
  }

  if (off || flags.CITY_MAP === false) return <FeatureOff name={t('map.title')} />;

  // A layer turned off goes at once, before the next answer.
  const items = (answer?.items ?? []).filter((i) => layers.includes(i.layer));
  const from: LatLng | null = place.here ?? view?.center ?? null;
  const listed = from ? byDistance(items, from) : items;
  const toggle = (l: MapLayer, on: boolean) => setLayers((ls) => (on ? MAP_LAYERS.filter((x) => x === l || ls.includes(x)) : ls.filter((x) => x !== l)));

  return (
    <div className="yp-shell__inner yp-shell__inner--wide stack">
      <div className="yp-topbar">
        <h1>{t('map.title')}</h1>
      </div>
      <p className="muted citymap-page__intro">{t('map.hint')}</p>

      <div className="citymap-page__bar">
        <Button variant="secondary" icon="map-pin" loading={place.busy} onClick={() => void toHere()} aria-describedby="citymap-why">
          {t('map.useLocation')}
        </Button>
        <form className="citymap-page__city" onSubmit={findCity} role="search">
          <TextField label={t('map.searchCity')} value={city} onChange={(e) => setCity(e.currentTarget.value)} maxLength={60} />
          <Button type="submit" variant="ghost">
            {t('home.search')}
          </Button>
        </form>
      </div>
      <p id="citymap-why" className="muted citymap-page__note">
        {t('map.locationWhy')}
      </p>
      {cityNote ? (
        <p className="citymap-page__note" role="status">
          {cityNote}
        </p>
      ) : null}

      <fieldset className="citymap-layers">
        <legend>{t('map.layers')}</legend>
        {MAP_LAYERS.filter((l) => (l !== 'friends' || me) && (l !== 'live' || flags.LIVE) && (l !== 'chains' || flags.PASS_THE_MIC !== false)).map((l) => (
          <label key={l} className="citymap-layer">
            <input type="checkbox" checked={layers.includes(l)} onChange={(e) => toggle(l, e.currentTarget.checked)} />
            {t(MAP_LAYER_KEYS[l])}
          </label>
        ))}
      </fieldset>

      <div className="citymap-views" role="group" aria-label={t('map.title')}>
        <Button variant={mode === 'map' ? 'primary' : 'ghost'} size="sm" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>
          {t('map.view.map')}
        </Button>
        <Button variant={mode === 'list' ? 'primary' : 'ghost'} size="sm" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
          {t('map.view.list')}
        </Button>
      </div>

      {view ? (
        <div className="citymap-page__body" data-view={mode}>
          <TileMap view={view} onView={setView} onSize={setSize} items={items} here={place.here} label={t('map.title')} />
          <section className="citymap-page__list" aria-label={t('map.view.list')} aria-live="polite">
            {loadError ? <p className="citymap-page__note">{loadError}</p> : null}
            {answer?.more.length ? <p className="muted citymap-page__note">{t('map.more')}</p> : null}
            {answer && !items.length ? <p className="muted citymap-page__note">{t('map.empty')}</p> : null}
            <ul className="citymap__list">
              {listed.map((i) => (
                <li key={i.key}>
                  <MapItemRow item={i} from={from ?? i.point} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : looking ? (
        <p className="muted" role="status">
          {t('location.locating')}
        </p>
      ) : null}

      {me ? (
        <section className="citymap-presence" aria-label={t('map.presence.title')}>
          <div className="citymap-presence__row">
            <Switch label={t('map.presence.title')} checked={!!presence} disabled={presenceBusy} onChange={(on) => void showMe(on)} />
            <Select
              label={t('location.duration')}
              value={duration}
              onChange={(e) => {
                const d = e.currentTarget.value as MapPresenceDuration;
                setDuration(d);
                if (presence) void showMe(true, d);
              }}
            >
              {MAP_PRESENCE_DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {t(MAP_PRESENCE_KEYS[d])}
                </option>
              ))}
            </Select>
          </div>
          <p className="muted" role="status">
            {presence ? t('map.presence.on', { time: clockTime(presence.endsAt, locale) }) : t('map.presence.hint')}
          </p>
        </section>
      ) : null}
    </div>
  );
}
