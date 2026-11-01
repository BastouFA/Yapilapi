'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Icon, TextField, type IconName } from '@yapilapi/design-system';
import {
  MAP_ATTRIBUTION,
  MAP_ATTRIBUTION_URL,
  MAP_LAYER_KEYS,
  MAP_TILE_SIZE,
  MAP_TILE_URL,
  clampZoom,
  clockTime,
  clusterItems,
  distanceMetres,
  herePoint,
  mapDistance,
  mapTargetPath,
  panBy,
  screenPoint,
  tilesFor,
  tileUrl,
  type LatLng,
  type MapCluster,
  type MapItem,
  type MapLayer,
  type PlaceArea,
  type PlacesHere,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';

/**
 * Near you's map on the web (docs/product/city-map.md): web-mercator tiles placed as images, with
 * no map library. Drag or use the arrow keys to move, the buttons, + and - or the mouse wheel to
 * zoom. Pins close together become one with a count; choosing a pin shows its card below the map.
 * The tiles come from MAP_TILE_URL unless the deployment sets NEXT_PUBLIC_MAP_TILE_URL.
 */

const TILES = process.env.NEXT_PUBLIC_MAP_TILE_URL || MAP_TILE_URL;
const STEP = 96;

export const LAYER_ICONS: Record<MapLayer, IconName> = {
  stashes: 'map-pin',
  live: 'video',
  today: 'calendar',
  market: 'bag',
  places: 'star',
  chains: 'mic',
  questions: 'help',
  friends: 'user',
};

export interface MapView {
  center: LatLng;
  zoom: number;
}

export function TileMap({
  view,
  onView,
  onSize,
  items,
  here,
  label,
}: {
  view: MapView;
  onView: (v: MapView) => void;
  onSize: (s: { width: number; height: number }) => void;
  items: MapItem[];
  /** Where the viewer is, on this device only (approximate). */
  here: LatLng | null;
  label: string;
}) {
  const { t, tp } = useSession();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [open, setOpen] = useState<MapCluster | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const live = useRef(view);
  live.current = view;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const s = { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) };
      // Hidden (the list is showing on a phone): keep the size it had.
      if (!s.width || !s.height) return;
      setSize(s);
      onSize(s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A card for a group that's no longer on screen closes.
  useEffect(() => setOpen(null), [view.zoom]);

  const zoomBy = (d: number) => onView({ center: live.current.center, zoom: clampZoom(live.current.zoom + d) });
  const move = (dx: number, dy: number) => onView({ center: panBy(live.current.center, live.current.zoom, dx, dy), zoom: live.current.zoom });

  function onKey(e: KeyboardEvent) {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => move(STEP, 0),
      ArrowRight: () => move(-STEP, 0),
      ArrowUp: () => move(0, STEP),
      ArrowDown: () => move(0, -STEP),
      '+': () => zoomBy(1),
      '=': () => zoomBy(1),
      '-': () => zoomBy(-1),
    };
    const fn = keys[e.key];
    if (!fn || e.target !== e.currentTarget) return;
    e.preventDefault();
    fn();
  }
  function onDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button, a')) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    move(dx, dy);
  }
  const onUp = () => {
    drag.current = null;
  };
  // The wheel zooms one step at a time (a trackpad sends many small events).
  const wheelAt = useRef(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (Date.now() - wheelAt.current < 250 || Math.abs(e.deltaY) < 4) return;
      wheelAt.current = Date.now();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { width, height } = size;
  const tiles = width && height ? tilesFor(view.center, view.zoom, width, height) : [];
  const clusters = width && height ? clusterItems(items, view.center, view.zoom, width, height) : [];
  const you = here && width ? screenPoint(here, view.center, view.zoom, width, height) : null;

  return (
    <div className="citymap">
      <div
        ref={box}
        className="citymap__view"
        tabIndex={0}
        role="region"
        aria-label={label}
        onKeyDown={onKey}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="citymap__tiles" aria-hidden="true">
          {tiles.map((tile) => (
            <img
              key={`${tile.z}/${tile.x}/${tile.y}`}
              src={tileUrl(TILES, tile)}
              alt=""
              draggable={false}
              width={MAP_TILE_SIZE}
              height={MAP_TILE_SIZE}
              style={{ transform: `translate(${tile.left}px, ${tile.top}px)` }}
            />
          ))}
        </div>
        {you ? <span className="citymap__you" style={{ left: you.x, top: you.y }} role="img" aria-label={t('nav.profile')} /> : null}
        {clusters.map((c) => {
          const first = c.items[0]!;
          const many = c.items.length > 1;
          return (
            <button
              key={c.key}
              type="button"
              className={`citymap__pin citymap__pin--${many ? 'group' : first.layer}`}
              style={{ left: c.x, top: c.y }}
              aria-label={many ? tp('map.cluster', c.items.length) : `${first.title || t(MAP_LAYER_KEYS[first.layer])}, ${t(MAP_LAYER_KEYS[first.layer])}`}
              aria-expanded={open?.key === c.key}
              onClick={() => setOpen(open?.key === c.key ? null : c)}
            >
              {many ? <span>{c.items.length}</span> : <Icon name={LAYER_ICONS[first.layer]} size={16} />}
            </button>
          );
        })}
        <div className="citymap__zoom">
          <button type="button" className="citymap__zoombtn" aria-label={t('collage.zoomIn')} onClick={() => zoomBy(1)}>
            +
          </button>
          <button type="button" className="citymap__zoombtn" aria-label={t('collage.zoomOut')} onClick={() => zoomBy(-1)}>
            −
          </button>
        </div>
        <a className="citymap__attribution" href={MAP_ATTRIBUTION_URL} target="_blank" rel="noreferrer">
          {MAP_ATTRIBUTION}
        </a>
      </div>
      {open ? (
        <div className="citymap__card" role="group" aria-label={open.items.length > 1 ? tp('map.cluster', open.items.length) : open.items[0]!.title}>
          <ul className="citymap__list">
            {open.items.slice(0, 8).map((i) => (
              <li key={i.key}>
                <MapItemRow item={i} from={here ?? view.center} />
              </li>
            ))}
          </ul>
          <button type="button" className="citymap__close" aria-label={t('m.common.close')} onClick={() => setOpen(null)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One item: picture, title, where, how far and when. Opens the item. */
export function MapItemRow({ item, from }: { item: MapItem; from: LatLng }) {
  const { t, tp, locale } = useSession();
  const distance = mapDistance(t, distanceMetres(from, item.point), locale);
  const when =
    item.layer === 'friends' && item.endsAt
      ? t('location.until', { time: clockTime(item.endsAt, locale) })
      : item.layer === 'today' && item.at
        ? clockTime(item.at, locale)
        : item.layer === 'places' && item.count
          ? tp('map.recent', item.count)
          : item.layer === 'chains' && item.count
            ? tp('m.sound.reelCount', item.count)
            : item.layer === 'stashes' && item.count
              ? tp('stash.finds', item.count)
              : item.layer === 'questions'
                ? item.count
                  ? tp('askCity.answers', item.count)
                  : t('askCity.needsAnswer')
                : null;
  const meta = [t(MAP_LAYER_KEYS[item.layer]), distance, when, item.approximate ? t('location.precision.approximate') : null].filter(Boolean);
  return (
    <Link href={mapTargetPath(item.target)} className="citymap-row">
      <span className={`citymap-row__thumb citymap-row__thumb--${item.layer}`} aria-hidden="true">
        {item.thumbUrl ? <img src={item.thumbUrl} alt="" /> : <Icon name={LAYER_ICONS[item.layer]} size={20} />}
      </span>
      <span className="citymap-row__text">
        <span className="citymap-row__title">{item.title || t(item.layer === 'stashes' ? 'stash.untitled' : MAP_LAYER_KEYS[item.layer])}</span>
        {item.subtitle ? <span className="citymap-row__sub">{item.subtitle}</span> : null}
        <span className="citymap-row__meta">{meta.join(' · ')}</span>
      </span>
    </Link>
  );
}

export type TaggedPlace = { id: string; name: string; city: string | null };

/**
 * "Add a place" in the composer: a place page the post was made at. It shows on the post, and puts
 * the post on the Near you map there. Found with the search everyone uses (places only).
 */
export function PlacePicker({ value, onChange }: { value: TaggedPlace | null; onChange: (p: TaggedPlace | null) => void }) {
  const { t } = useSession();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<TaggedPlace[]>([]);
  useEffect(() => {
    if (!open || q.trim().length < 2) return setFound([]);
    let live = true;
    const timer = setTimeout(() => {
      api
        .search(q.trim(), 'places')
        .then((r) => live && setFound(((r.results.places ?? []) as TaggedPlace[]).slice(0, 6)))
        .catch(() => live && setFound([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, open]);

  if (value)
    return (
      <div className="row" style={{ alignItems: 'center' }}>
        <span className="post-place">
          <Icon name="map-pin" size={16} /> {value.city ? `${value.name}, ${value.city}` : value.name}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          {t('m.common.remove')}
        </Button>
      </div>
    );
  const pick = (p: TaggedPlace) => {
    onChange(p);
    setOpen(false);
    setQ('');
  };
  if (!open)
    return (
      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        <div className="row">
          <Button size="sm" variant="ghost" icon="map-pin" onClick={() => setOpen(true)}>
            {t('map.tagPlace')}
          </Button>
        </div>
        <HereSuggestions onPick={pick} />
      </div>
    );
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <TextField label={t('discover.places')} value={q} autoFocus maxLength={100} onChange={(e) => setQ(e.currentTarget.value)} />
      {found.length ? (
        <ul className="citymap__list">
          {found.map((p) => (
            <li key={p.id}>
              <button type="button" className="citymap-row citymap-row--button" onClick={() => pick({ id: p.id, name: p.name, city: p.city ?? null })}>
                <span className="citymap-row__thumb" aria-hidden="true">
                  <Icon name="map-pin" size={20} />
                </span>
                <span className="citymap-row__text">
                  <span className="citymap-row__title">{p.name}</span>
                  {p.city ? <span className="citymap-row__sub">{p.city}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {q.trim() ? null : <HereSuggestions onPick={pick} />}
      <div className="row">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('m.common.close')}
        </Button>
      </div>
    </div>
  );
}

/** The last "Where you are" answer, kept for a couple of minutes so the picker doesn't ask again each time it shows. */
let lastHere: { at: number; answer: PlacesHere } | null = null;
const HERE_KEEP_MS = 2 * 60 * 1000;

/** Whether this site may already read where the browser is, so suggestions can show without asking. */
async function geoGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted';
  } catch {
    return false;
  }
}

/** Where the browser is, once: a quick, low-power answer is enough for naming the area. */
function readHerePosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject('unavailable');
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(herePoint({ lat: p.coords.latitude, lng: p.coords.longitude })),
      (e) => reject(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 120_000 },
    );
  });
}

/**
 * "Are you here?": the area you're in and the place pages near you, as chips to tap. Shows at once
 * when the site may already read where you are, else after "Use where I am". Nothing is tagged
 * without a tap. The point is rounded to about 100 metres before it's sent (herePoint) and isn't
 * kept anywhere but this page.
 */
function HereSuggestions({ onPick }: { onPick: (p: TaggedPlace) => void }) {
  const { t, locale, toast } = useSession();
  const [state, setState] = useState<'idle' | 'finding' | 'ready' | 'failed' | 'denied'>(() =>
    lastHere && Date.now() - lastHere.at < HERE_KEEP_MS ? 'ready' : 'idle',
  );
  const [answer, setAnswer] = useState<PlacesHere | null>(() => (lastHere && Date.now() - lastHere.at < HERE_KEEP_MS ? lastHere.answer : null));
  const [tagging, setTagging] = useState(false);
  const live = useRef(true);
  const labelId = useId();

  async function find() {
    setState('finding');
    try {
      const at = await readHerePosition();
      const r = await api.places.here(at.lat, at.lng);
      lastHere = { at: Date.now(), answer: r };
      if (!live.current) return;
      setAnswer(r);
      setState(r.area || r.nearby.length ? 'ready' : 'failed');
    } catch (e) {
      if (live.current) setState(e === 'denied' ? 'denied' : 'failed');
    }
  }

  useEffect(() => {
    live.current = true;
    if (state === 'idle' && typeof navigator !== 'undefined' && navigator.geolocation)
      void geoGranted().then((ok) => {
        if (ok && live.current) void find();
      });
    return () => {
      live.current = false;
    };
    // Only when the picker first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tagArea(area: PlaceArea) {
    setTagging(true);
    try {
      const { place } = await api.places.tagHere(area);
      onPick({ id: place.id, name: place.name, city: place.city ?? null });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      if (live.current) setTagging(false);
    }
  }

  if (typeof navigator !== 'undefined' && !navigator.geolocation) return null;
  if (state === 'idle')
    return (
      <div className="row">
        <Button size="sm" variant="ghost" icon="map-pin" onClick={() => void find()}>
          {t('place.here.use')}
        </Button>
      </div>
    );
  if (state === 'finding')
    return (
      <p className="place-here__note" role="status">
        {t('place.here.finding')}
      </p>
    );
  if (state !== 'ready' || !answer)
    return (
      <p className="place-here__note" role="status">
        {t(state === 'denied' ? 'place.here.denied' : 'place.here.failed')}
      </p>
    );
  const area = answer.area;
  return (
    <div className="place-here" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="place-here__title">
        {t('place.here.title')}
      </span>
      <div className="row">
        {area ? (
          <button type="button" className="yp-chip place-here__chip" disabled={tagging} onClick={() => void tagArea(area)}>
            <span aria-hidden="true">📍</span>
            <bdi className="place-here__text">{area.city && area.city !== area.name ? `${area.name}, ${area.city}` : area.name}</bdi>
          </button>
        ) : null}
        {answer.nearby.map((p) => {
          const far = mapDistance(t, p.distanceM, locale);
          return (
            <button key={p.id} type="button" className="yp-chip place-here__chip" onClick={() => onPick({ id: p.id, name: p.name, city: p.city })}>
              <bdi className="place-here__text">{p.name}</bdi>
              {far ? <span className="place-here__far">{far}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
