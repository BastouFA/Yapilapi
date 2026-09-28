'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BottomSheet, Button, Icon } from '@yapilapi/design-system';
import {
  bearingDegrees,
  clockTime,
  distanceMetres,
  isLive,
  LOCATION_DURATIONS,
  LOCATION_UPDATE_SECONDS,
  locationAlt,
  locationFromYou,
  locationStatus,
  mapPattern,
  mapsUrl,
  pointFor,
  type LatLng,
  type LocationDuration,
  type LocationPrecision,
  type LocationShare,
  type LocationWords,
  type Message,
  type MessageKey,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Sharing where you are in a chat (web): the sheet to start (live for a while, or once), the banner
 * while you share, and the card in the chat.
 *
 * The browser asks for permission only when you tap a share button, never on page load. While you
 * share, this page follows where you are (watchPosition) and sends a point at most every
 * LOCATION_UPDATE_SECONDS; closing the page (or leaving the chat) stops the share. Approximate points
 * are snapped on this device before they're sent.
 *
 * The card draws its own small map (no map tiles, no outside services). Distance and direction from
 * you are worked out here only, from where this device is (while you share, or once when you ask);
 * that position is never sent. "Open in maps" asks first, then opens OpenStreetMap in a new tab.
 */

/** Sends are spaced a little more than the server's minimum, so none arrive too soon. */
const SEND_EVERY_MS = (LOCATION_UPDATE_SECONDS + 1) * 1000;

type Fix = LatLng & { accuracy?: number };
type GeoProblem = 'denied' | 'unavailable' | 'unsupported';

/** Where this device is, once. Asking is what shows the browser's permission prompt. */
function readPosition(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject('unsupported' satisfies GeoProblem);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject((e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable') satisfies GeoProblem),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 10_000 },
    );
  });
}

function problemText(t: (k: MessageKey) => string, e: unknown): string {
  if (e === 'denied') return t('location.denied');
  if (e === 'unsupported') return t('location.noSupport');
  if (e === 'unavailable') return t('location.unavailable');
  return errorMessage(e);
}

function useWords(): LocationWords {
  const { t, tp, locale } = useSession();
  return { t, tp, locale };
}

/** The time now, moving on every few seconds while `active`, for "Updated 20 s ago". */
function useNow(active: boolean, every = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(i);
  }, [active, every]);
  return now;
}

// ─── Your share ─────────────────────────────────────────────────────────

/**
 * Your live share in this chat (from this page or another tab or device), following where you are
 * while it runs from this page, and where this device is (for distances on other people's cards).
 */
export function useLocationSharing(conversationId: string, meId: string | undefined) {
  const { t, toast } = useSession();
  const [mine, setMine] = useState<LocationShare | null>(null);
  // Started from this page: this page sends the points, and closing it stops the share.
  const [here, setHere] = useState(false);
  const [viewer, setViewer] = useState<LatLng | null>(null);
  const mineRef = useRef<LocationShare | null>(null);
  const hereRef = useRef(false);
  mineRef.current = mine;
  hereRef.current = here;

  useEffect(() => {
    setMine(null);
    setHere(false);
    if (!meId) return;
    api.conversations.locationShares(conversationId).then(
      (r) => setMine(r.items.find((s) => s.sharer.id === meId) ?? null),
      () => {},
    );
  }, [conversationId, meId]);

  /** A newer copy of any share (live updates, answers): keeps yours current, and clears it when it ends. */
  const apply = useCallback(
    (share: LocationShare) => {
      if (share.sharer.id !== meId || share.mode !== 'live' || share.conversationId !== conversationId) return;
      if (isLive(share)) setMine(share);
      else if (mineRef.current?.id === share.id) {
        setMine(null);
        setHere(false);
      }
    },
    [meId, conversationId],
  );

  // It runs out at its time even if no update says so.
  useEffect(() => {
    if (!mine?.endsAt) return;
    const left = new Date(mine.endsAt).getTime() - Date.now();
    const timer = setTimeout(
      () => {
        setMine((cur) => (cur?.id === mine.id ? null : cur));
        setHere(false);
      },
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [mine?.id, mine?.endsAt]);

  // While sharing from this page: follow where you are, and send a point every LOCATION_UPDATE_SECONDS at most.
  const shareId = here ? mine?.id : undefined;
  useEffect(() => {
    if (!shareId || typeof navigator === 'undefined' || !navigator.geolocation) return;
    let latest: Fix | null = null;
    let fresh = false;
    let lastSent = Date.now();
    let sending = false;
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        latest = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        fresh = true;
        setViewer({ lat: latest.lat, lng: latest.lng });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5_000 },
    );
    const tick = setInterval(async () => {
      const share = mineRef.current;
      if (!latest || !fresh || sending || !share || Date.now() - lastSent < SEND_EVERY_MS) return;
      sending = true;
      fresh = false;
      const p = pointFor(latest, share.precision);
      try {
        const r = await api.location.update(share.id, { lat: p.lat, lng: p.lng, accuracy: latest.accuracy });
        lastSent = Date.now();
        setMine((cur) => (cur?.id === r.location.id ? r.location : cur));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'share_ended') {
          setMine(null);
          setHere(false);
        } else {
          // Too soon, or the network: the next tick tries again with the newest point.
          lastSent = Date.now();
          fresh = true;
        }
      } finally {
        sending = false;
      }
    }, 1_000);
    return () => {
      navigator.geolocation.clearWatch(watch);
      clearInterval(tick);
    };
  }, [shareId]);

  // Closing the page, or leaving this chat, stops a share started here.
  useEffect(() => {
    const stopHere = () => {
      if (hereRef.current && mineRef.current) api.location.stopOnPageClose(mineRef.current.id);
    };
    window.addEventListener('pagehide', stopHere);
    return () => {
      window.removeEventListener('pagehide', stopHere);
      stopHere();
    };
  }, [conversationId]);

  async function stop() {
    const share = mineRef.current;
    if (!share) return;
    try {
      const r = await api.location.stop(share.id);
      setMine(null);
      setHere(false);
      toast(t('location.stoppedToast'));
      return r.location;
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  /** You started sharing from this page. */
  function started(share: LocationShare) {
    setMine(share);
    setHere(share.mode === 'live');
    if (share.point) setViewer({ lat: share.point.lat, lng: share.point.lng });
  }

  // Your own live share (from anywhere) says where you are too, for distances.
  const you = viewer ?? (mine?.point ? { lat: mine.point.lat, lng: mine.point.lng } : null);
  return { mine, here, viewer: you, setViewer, apply, started, stop };
}

// ─── Starting ───────────────────────────────────────────────────────────

/** "Share where I am": for how long and how exactly, or a pin sent once. Permission is asked on tap. */
export function ShareLocationSheet({
  open,
  onClose,
  conversationId,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
}) {
  const { t, toast, locale } = useSession();
  const [minutes, setMinutes] = useState<LocationDuration>(60);
  const [precision, setPrecision] = useState<LocationPrecision>('precise');
  const [busy, setBusy] = useState<'live' | 'once' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  const supported = typeof navigator !== 'undefined' && !!navigator.geolocation;
  const durationName = (m: LocationDuration) => t(`location.duration.${m}` as MessageKey);

  useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  async function go(mode: 'live' | 'once') {
    setBusy(mode);
    setProblem(null);
    try {
      const here = await readPosition();
      // Approximate: snapped here, before it leaves this device.
      const p = pointFor(here, precision);
      const { message } = await api.conversations.shareLocation(conversationId, {
        mode,
        ...(mode === 'live' ? { minutes } : {}),
        precision,
        lat: p.lat,
        lng: p.lng,
        accuracy: here.accuracy,
        clientId: crypto.randomUUID(),
      });
      onSent(message);
      if (mode === 'live' && message.location?.endsAt) toast(t('location.startedToast', { time: clockTime(message.location.endsAt, locale) }));
      onClose();
    } catch (e) {
      const text = problemText(t, e);
      setProblem(text);
      toast(text);
    } finally {
      setBusy(null);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('location.sheet.title')}>
      <div className="stack" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('location.sheet.intro')}
        </p>
        <fieldset className="chat-radio">
          <legend className="yp-field__label">{t('location.duration')}</legend>
          <div className="location-choices">
            {LOCATION_DURATIONS.map((m) => (
              <label key={m} className={`chat-game-option location-choice${minutes === m ? ' chat-game-option--on' : ''}`}>
                <input type="radio" name="location-minutes" value={m} checked={minutes === m} onChange={() => setMinutes(m)} />
                <span>{durationName(m)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="chat-radio">
          <legend className="yp-field__label">{t('location.precision')}</legend>
          <div className="stack" style={{ gap: 8 }}>
            {(['precise', 'approximate'] as const).map((p) => (
              <label key={p} className={`chat-game-option${precision === p ? ' chat-game-option--on' : ''}`}>
                <input type="radio" name="location-precision" value={p} checked={precision === p} onChange={() => setPrecision(p)} />
                <span className="stack" style={{ gap: 2 }}>
                  <strong>{t(p === 'precise' ? 'location.precision.precise' : 'location.precision.approximate')}</strong>
                  <span className="chat-poll__status">{t(p === 'precise' ? 'location.precision.preciseHint' : 'location.precision.approximateHint')}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="location-note" id={noteId}>
          <Icon name="info" size={16} /> <span>{supported ? t('location.webNote') : t('location.noSupport')}</span>
        </p>
        {problem ? (
          <p className="location-problem" role="alert">
            {problem}
          </p>
        ) : null}
        <Button
          icon="map-pin"
          block
          loading={busy === 'live'}
          disabled={!supported || busy === 'once'}
          aria-describedby={noteId}
          onClick={() => void go('live')}
        >
          {t('location.start', { time: durationName(minutes) })}
        </Button>
        <div className="stack" style={{ gap: 4 }}>
          <Button variant="secondary" icon="map-pin" block loading={busy === 'once'} disabled={!supported || busy === 'live'} onClick={() => void go('once')}>
            {t('location.once')}
          </Button>
          <span className="chat-poll__status" style={{ textAlign: 'center' }}>
            {t('location.onceHint')}
          </span>
        </div>
        {busy ? (
          <span className="muted" role="status" style={{ fontSize: 13 }}>
            {t('location.locating')}
          </span>
        ) : null}
      </div>
    </BottomSheet>
  );
}

// ─── While you share ────────────────────────────────────────────────────

/** "You're sharing where you are until 14:30", at the top of the chat, with Stop. */
export function SharingBanner({ share, here, onStop }: { share: LocationShare | null; here: boolean; onStop: () => Promise<unknown> }) {
  const { t, locale } = useSession();
  const [busy, setBusy] = useState(false);
  if (!share?.endsAt) return null;
  return (
    <div className="location-banner" role="region" aria-label={t('location.live')}>
      <span className="location-banner__icon" aria-hidden>
        <Icon name="map-pin" size={16} />
      </span>
      <div className="location-banner__text">
        <strong>{t('location.banner', { time: clockTime(share.endsAt, locale) })}</strong>
        <span className="muted">{here ? t('location.webNote') : t('location.bannerElsewhere')}</span>
      </div>
      <Button
        size="sm"
        variant="danger"
        loading={busy}
        aria-label={t('location.stopSharing')}
        onClick={async () => {
          setBusy(true);
          await onStop();
          setBusy(false);
        }}
      >
        {t('location.stop')}
      </Button>
    </div>
  );
}

// ─── The card ───────────────────────────────────────────────────────────

/**
 * A shared location in the chat: a small drawn map with the pin (and you, when this device knows
 * where you are), how long ago it moved, how far and which way from you, and "Open in maps".
 */
export function LocationCard({
  message,
  meId,
  mine,
  viewer,
  onViewer,
  onStop,
}: {
  message: Message;
  meId?: string;
  mine: boolean;
  /** Where this device is, if known (never sent anywhere). */
  viewer: LatLng | null;
  onViewer: (p: LatLng) => void;
  onStop: () => Promise<unknown>;
}) {
  const { t, toast } = useSession();
  const w = useWords();
  const share = message.location!;
  const running = share.mode === 'live' && !share.stoppedAt;
  const now = useNow(running);
  const live = isLive(share, now);
  const own = share.sharer.id === meId;
  const point = share.point && (share.mode === 'once' || live) ? share.point : null;
  const from = !own && point && viewer ? viewer : null;
  const [finding, setFinding] = useState(false);
  const [stopping, setStopping] = useState(false);
  const alt = locationAlt(w, share, meId, from, now);

  async function findMe() {
    setFinding(true);
    try {
      const p = await readPosition();
      onViewer({ lat: p.lat, lng: p.lng });
    } catch (e) {
      toast(problemText(t, e));
    } finally {
      setFinding(false);
    }
  }

  function openMaps() {
    if (!point) return;
    if (!confirm(t('location.leaveConfirm'))) return;
    window.open(mapsUrl(point, 'web'), '_blank', 'noopener,noreferrer');
  }

  return (
    <div className={`chat-location${mine ? ' chat-location--mine' : ''}`}>
      <span className="chat-poll__label">
        <Icon name="map-pin" size={14} /> {t(share.mode === 'once' ? 'location.pin' : 'location.live')}
      </span>
      <LocationMap point={point} viewer={from} approximate={share.precision === 'approximate'} seed={share.id} label={alt} ended={!point} />
      <p className="chat-location__status" aria-live={own ? undefined : 'off'}>
        {point || share.mode === 'live' ? locationStatus(w, share, now) : t('location.hidden')}
        {point && share.precision === 'approximate' ? <span className="chat-poll__status"> · {t('location.approximateLabel')}</span> : null}
      </p>
      {from && point ? <p className="chat-location__distance">{locationFromYou(w, from, point)}</p> : null}
      <div className="chat-location__actions">
        {point && !own && !from ? (
          <Button size="sm" variant="ghost" icon="compass" loading={finding} onClick={() => void findMe()} title={t('location.distanceNote')}>
            {t('location.showDistance')}
          </Button>
        ) : null}
        {point ? (
          <Button size="sm" variant="secondary" icon="link" onClick={openMaps}>
            {t('location.openMaps')}
          </Button>
        ) : null}
        {own && live ? (
          <Button
            size="sm"
            variant="danger"
            loading={stopping}
            onClick={async () => {
              setStopping(true);
              await onStop();
              setStopping(false);
            }}
          >
            {t('location.stopSharing')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The drawn map: a made-up street pattern (it says nothing about the real streets there), a soft
 * circle for an approximate place, the pin, and you, placed the right way from it. It's one image
 * with a text alternative that says the same in words.
 */
function LocationMap({
  point,
  viewer,
  approximate,
  seed,
  label,
  ended,
}: {
  point: LatLng | null;
  viewer: LatLng | null;
  approximate: boolean;
  seed: string;
  label: string;
  ended: boolean;
}) {
  const { t } = useSession();
  const W = 240;
  const H = 120;
  const cx = W / 2;
  const cy = H / 2 + 6;
  // A stopped share has no place: the pattern comes from its id instead.
  const base = point ?? { lat: seed.charCodeAt(0) + seed.charCodeAt(1), lng: seed.charCodeAt(2) + seed.charCodeAt(3) };
  const lines = mapPattern(base);
  let you: { x: number; y: number } | null = null;
  if (point && viewer) {
    // You are the opposite way from the pin to the way you'd walk to reach it; nearer shows nearer.
    const b = (bearingDegrees(viewer, point) * Math.PI) / 180;
    const d = distanceMetres(viewer, point);
    const r = Math.max(26, Math.min(52, 18 + Math.log10(Math.max(d, 10)) * 9));
    you = { x: cx - Math.sin(b) * r * 1.6, y: cy + Math.cos(b) * r };
  }
  return (
    <svg
      className={`location-map${ended ? ' location-map--ended' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect className="location-map__ground" x="0" y="0" width={W} height={H} rx="12" />
      <circle
        className="location-map__park"
        cx={Math.min(W - 24, Math.max(24, lines[3]!.x1 * 2.4 + 18))}
        cy={Math.min(H - 20, Math.max(20, lines[2]!.y1 * 1.2 - 14))}
        r="16"
      />
      {lines.map((l, i) => (
        <line
          key={i}
          className={`location-map__road${l.major ? ' location-map__road--major' : ''}`}
          x1={l.x1 * 2.4}
          y1={l.y1 * 1.2}
          x2={l.x2 * 2.4}
          y2={l.y2 * 1.2}
        />
      ))}
      {point && approximate ? <circle className="location-map__area" cx={cx} cy={cy - 4} r="30" /> : null}
      {you ? (
        <g className="location-map__you">
          <line x1={you.x} y1={you.y} x2={cx} y2={cy - 4} />
          <circle cx={you.x} cy={you.y} r="6" />
          <text x={you.x} y={you.y - 10} textAnchor="middle">
            {t('location.youMarker')}
          </text>
        </g>
      ) : null}
      <g className="location-map__pin" transform={`translate(${cx - 12} ${cy - 30})`}>
        <path d="M12 30s-10-9.2-10-17.2A10 10 0 0 1 22 12.8C22 20.8 12 30 12 30z" />
        <circle cx="12" cy="12.5" r="4" />
      </g>
    </svg>
  );
}

/** "Ada asked where everyone is", with a button for the others to share. */
export function LocationRequestLine({ message, meId, onShare }: { message: Message; meId?: string; onShare: () => void }) {
  const { t } = useSession();
  const mine = message.sender.id === meId;
  return (
    <p className="chat-system" role="note">
      <Icon name="map-pin" size={14} /> <bdi>{mine ? t('location.request.lineYou') : t('location.request.line', { name: message.sender.displayName })}</bdi>
      {!mine ? (
        <>
          {' '}
          <button type="button" className="chat-system__join chat-link-button" onClick={onShare}>
            {t('location.menu')}
          </button>
        </>
      ) : null}
    </p>
  );
}
