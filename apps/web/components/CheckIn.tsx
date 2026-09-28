'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Avatar, Badge, Button, EmptyState, Icon, Segments, Skeleton, Switch, TextField } from '@yapilapi/design-system';
import {
  formatEventWhen,
  readTicketInput,
  safeTimeZone,
  TICKET_OFFLINE_QUEUE_MAX,
  type CheckInCounts,
  type CheckInMethod,
  type CheckInResult,
  type CheckInResultKind,
  type DoorSummary,
  type MessageKey,
  type PublicUser,
  type QueuedCheckIn,
  type TicketGuest,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';
import { PeoplePicker } from './PeoplePicker';

type Filter = 'all' | 'in' | 'waiting';
type Input = QueuedCheckIn['input'];
/** A check-in kept offline that came back as something to look at. */
type Conflict = { id: string; text: string };

const TITLE: Record<CheckInResultKind, MessageKey> = {
  valid: 'checkin.result.valid',
  already: 'checkin.result.already',
  wrong_event: 'checkin.result.wrong_event',
  cancelled: 'checkin.result.cancelled',
  refunded: 'checkin.result.refunded',
  invalid: 'checkin.result.invalid',
};
const DETAIL: Partial<Record<CheckInResultKind, MessageKey>> = {
  wrong_event: 'checkin.detail.wrong_event',
  cancelled: 'checkin.detail.cancelled',
  refunded: 'checkin.detail.refunded',
  invalid: 'checkin.detail.invalid',
};
const TONE: Record<CheckInResultKind, 'ok' | 'warn' | 'bad'> = {
  valid: 'ok',
  already: 'warn',
  wrong_event: 'bad',
  cancelled: 'bad',
  refunded: 'bad',
  invalid: 'bad',
};
const ICON = { ok: 'check-circle', warn: 'alert', bad: 'x-circle' } as const;

// Check-ins made while offline wait in this browser, per event, until they can be sent.
const queueKey = (eventId: string) => `ypl.checkin.queue.${eventId}`;
function readQueue(eventId: string): QueuedCheckIn[] {
  try {
    const raw = localStorage.getItem(queueKey(eventId));
    return raw ? (JSON.parse(raw) as QueuedCheckIn[]) : [];
  } catch {
    return [];
  }
}
function writeQueue(eventId: string, q: QueuedCheckIn[]) {
  try {
    if (q.length) localStorage.setItem(queueKey(eventId), JSON.stringify(q));
    else localStorage.removeItem(queueKey(eventId));
  } catch {
    // Private browsing or full storage: the queue lives only in memory then.
  }
}
const newRef = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const unreachable = (e: unknown) => e instanceof ApiError && (e.code === 'network' || e.code === 'unavailable');

/**
 * The check-in screen for an event's host and co-hosts: live counts, a scanner (the browser's
 * camera, when it can read QR codes), backup-code entry and a searchable guest list with Check in
 * and Undo. Everything works without a camera. When the connection drops, check-ins are kept in
 * this browser and sent when it's back; any that another device got to first are listed to check.
 */
export function CheckInDesk({ eventId }: { eventId: string }) {
  const { t, tp, locale, toast, me } = useSession();
  const [door, setDoor] = useState<DoorSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [counts, setCounts] = useState<CheckInCounts | null>(null);
  const [last, setLast] = useState<{ result: CheckInResult; n: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedCheckIn[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [listVersion, setListVersion] = useState(0);
  const flushing = useRef(false);
  const shown = useRef(0);

  const tz = door ? safeTimeZone(door.event.timezone) : 'UTC';
  const time = useCallback((iso: string) => new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(iso)), [locale, tz]);

  useEffect(() => {
    api.events.door(eventId).then(
      (d) => {
        setDoor(d);
        setCounts(d.counts);
      },
      () => setMissing(true),
    );
    setQueue(readQueue(eventId));
    setOnline(navigator.onLine);
  }, [eventId]);

  const enqueue = useCallback(
    (entry: QueuedCheckIn) => {
      setQueue((cur) => {
        const next = [...cur, entry].slice(-TICKET_OFFLINE_QUEUE_MAX);
        writeQueue(eventId, next);
        return next;
      });
      setLast(null);
      setNote(t('checkin.savedOffline'));
    },
    [eventId, t],
  );

  const show = useCallback((r: CheckInResult) => {
    setCounts(r.counts);
    setNote(null);
    setLast({ result: r, n: ++shown.current });
    setListVersion((v) => v + 1);
  }, []);

  /** Send what waited offline, oldest first; stop at the first sign the connection is still down. */
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      let pending = readQueue(eventId);
      while (pending.length) {
        const item = pending[0]!;
        try {
          const r = await api.events.checkIn(eventId, { ...item.input, clientRef: item.clientRef, scannedAt: item.scannedAt });
          setCounts(r.counts);
          const name = r.guest?.name ?? '';
          if (r.result === 'already' && !r.replayed && r.guest?.checkedInAt)
            setConflicts((c) => [
              ...c,
              {
                id: item.clientRef,
                text: t('checkin.conflict', { name, by: r.guest!.checkedInBy?.name ?? '', time: time(r.guest!.checkedInAt!) }),
              },
            ]);
          else if (r.result !== 'valid' && r.result !== 'already')
            setConflicts((c) => [...c, { id: item.clientRef, text: t('checkin.conflictOther', { result: t(TITLE[r.result]) }) }]);
        } catch (e) {
          if (unreachable(e) || (e instanceof ApiError && e.status === 429)) break;
          // Refused for good (the event was cancelled, you're no longer a host): shown, and dropped.
          setConflicts((c) => [...c, { id: item.clientRef, text: errorMessage(e) }]);
        }
        pending = pending.slice(1);
        writeQueue(eventId, pending);
        setQueue(pending);
      }
      setListVersion((v) => v + 1);
      // Everything kept offline went: the "kept on this device" note no longer applies.
      if (!pending.length) setNote((n) => (n === t('checkin.savedOffline') ? null : n));
    } finally {
      flushing.current = false;
    }
  }, [eventId, t, time]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flush();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    if (navigator.onLine) void flush();
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [flush]);

  // Other hosts' check-ins and undos, and tickets bought or given back, keep the counts and the list current.
  useRealtime((e) => {
    if (e.type !== 'checkin.updated' || e.data?.eventId !== eventId) return;
    setCounts(e.data.counts);
    setListVersion((v) => v + 1);
  });

  const submit = useCallback(
    async (input: Input, method: CheckInMethod) => {
      const entry: QueuedCheckIn = { clientRef: newRef(), input, method, scannedAt: new Date().toISOString() };
      if (!navigator.onLine) {
        setOnline(false);
        enqueue(entry);
        return;
      }
      try {
        show(await api.events.checkIn(eventId, { ...input, clientRef: entry.clientRef }));
      } catch (e) {
        if (unreachable(e)) {
          setOnline(false);
          enqueue(entry);
        } else {
          setLast(null);
          setNote(errorMessage(e));
        }
      }
    },
    [eventId, enqueue, show],
  );

  const undo = useCallback(
    async (guest: TicketGuest) => {
      try {
        const r = await api.events.undoCheckIn(eventId, guest.ticketId);
        setCounts(r.counts);
        setLast((cur) => (cur?.result.guest?.ticketId === guest.ticketId ? null : cur));
        setNote(t('checkin.undone', { name: guest.name }));
        setListVersion((v) => v + 1);
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [eventId, t, toast],
  );

  if (missing) return <EmptyState title={t('checkin.title')} body={t('checkin.detail.invalid')} />;
  if (!door || !counts) return <Skeleton height={320} />;
  const pct = counts.expected ? Math.round((counts.checkedIn / counts.expected) * 100) : 0;

  return (
    <div className="yp-shell__inner door">
      <header className="door__head">
        <p className="door__kicker">
          <Icon name="scan" /> {t('checkin.title')} · {door.role === 'host' ? t('checkin.role.host') : t('checkin.role.cohost')}
        </p>
        <h1 className="door__title">
          <Link href={`/events/${eventId}`}>
            <bdi>{door.event.title}</bdi>
          </Link>
        </h1>
        <p className="door__when">{formatEventWhen(door.event.startsAt, locale, tz)}</p>
        <div className="door__counts">
          <strong>{t('checkin.counts', { checkedIn: counts.checkedIn, expected: counts.expected })}</strong>
          <div
            className="door__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={counts.expected}
            aria-valuenow={counts.checkedIn}
            aria-label={t('checkin.title')}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      {!online ? (
        <p className="door__offline" role="status">
          <Icon name="signal" /> {t('checkin.offline')}
        </p>
      ) : null}
      {queue.length ? <p className="door__queued">{tp('checkin.queued', queue.length)}</p> : null}

      <div className="door__result-slot" role="status" aria-live="assertive" aria-atomic="true">
        {last ? <ResultPanel key={last.n} r={last.result} time={time} onUndo={undo} /> : note ? <p className="door-result door-result--note">{note}</p> : null}
      </div>

      {conflicts.length ? (
        <section className="door__conflicts" aria-labelledby="door-conflicts">
          <h2 id="door-conflicts" className="door__h2">
            {t('checkin.conflicts')}
          </h2>
          <ul>
            {conflicts.map((c) => (
              <li key={c.id}>
                <span>{c.text}</span>
                <Button size="sm" variant="ghost" onClick={() => setConflicts((cur) => cur.filter((x) => x.id !== c.id))}>
                  {t('checkin.dismiss')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="door__tools">
        <Scanner onScan={(token) => void submit({ token }, 'qr')} />
        <CodeEntry onSubmit={(code) => submit({ code }, 'code')} />
      </div>

      <GuestList eventId={eventId} version={listVersion} time={time} onCheckIn={(g) => submit({ ticketId: g.ticketId }, 'list')} onUndo={undo} />

      <DoorSettings door={door} meId={me?.id ?? ''} onChange={setDoor} />
    </div>
  );
}

/** What the last scan or code found, said plainly: the guest when it's their ticket, or why not. */
function ResultPanel({ r, time, onUndo }: { r: CheckInResult; time: (iso: string) => string; onUndo: (g: TicketGuest) => void }) {
  const { t } = useSession();
  const tone = TONE[r.result];
  const g = r.guest;
  const detail =
    r.result === 'already' && g?.checkedInAt
      ? t('checkin.detail.already', { time: time(g.checkedInAt), name: g.checkedInBy?.name ?? '' })
      : DETAIL[r.result]
        ? t(DETAIL[r.result]!)
        : null;
  return (
    <div className={`door-result door-result--${tone}`}>
      <Icon name={ICON[tone]} size={28} />
      <div className="door-result__body">
        <strong className="door-result__title">{t(TITLE[r.result])}</strong>
        {g && (r.result === 'valid' || r.result === 'already' || r.result === 'refunded' || r.result === 'cancelled') ? (
          <span className="door-result__who">
            <bdi>{g.name}</bdi> · <bdi>{g.type ?? t('tickets.type.rsvp')}</bdi>
            {g.limited ? <span className="door__limited"> · {t('checkin.limited')}</span> : null}
          </span>
        ) : null}
        {detail ? <span className="door-result__detail">{detail}</span> : null}
      </div>
      {r.result === 'valid' && g ? (
        <Button size="sm" variant="secondary" onClick={() => onUndo(g)} aria-label={t('checkin.undoName', { name: g.name })}>
          {t('checkin.undo')}
        </Button>
      ) : null}
    </div>
  );
}

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (o: { formats: string[] }) => Detector;

/**
 * Scanning with the browser's camera, where the browser can read QR codes (BarcodeDetector). Where
 * it can't, it says so and the backup code and guest list do the job.
 */
function Scanner({ onScan }: { onScan: (token: string) => void }) {
  const { t } = useSession();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [denied, setDenied] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const seen = useRef<{ value: string; at: number } | null>(null);
  const handler = useRef(onScan);
  handler.current = onScan;

  useEffect(() => {
    const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    setSupported(!!Ctor && !!navigator.mediaDevices?.getUserMedia);
  }, []);

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    (async () => {
      try {
        const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
        const detector = new Ctor({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            for (const c of codes) {
              const read = readTicketInput(c.rawValue);
              if (read?.kind !== 'token') continue;
              // The same code in front of the camera counts once every few seconds.
              const now = Date.now();
              if (seen.current && seen.current.value === read.token && now - seen.current.at < 4000) continue;
              seen.current = { value: read.token, at: now };
              handler.current(read.token);
            }
          } catch {
            // A frame that couldn't be read: try the next one.
          }
          timer = setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch {
        setDenied(true);
        setOn(false);
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [on]);

  if (supported === null) return null;
  if (!supported) return <p className="door__hint">{t('checkin.noCamera')}</p>;
  return (
    <section className="door__scanner" aria-label={t('checkin.scan')}>
      <Button icon="scan" variant={on ? 'secondary' : 'primary'} onClick={() => (setDenied(false), setOn((v) => !v))} aria-pressed={on}>
        {on ? t('checkin.scanStop') : t('checkin.scan')}
      </Button>
      {denied ? <p className="door__hint">{t('checkin.cameraDenied')}</p> : null}
      {on ? (
        <>
          <video ref={video} className="door__video" muted playsInline aria-hidden />
          <p className="door__hint">{t('checkin.scanHint')}</p>
        </>
      ) : null}
    </section>
  );
}

/** Type a guest's 6-character backup code. */
function CodeEntry({ onSubmit }: { onSubmit: (code: string) => Promise<void> }) {
  const { t } = useSession();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    await onSubmit(code.trim());
    setBusy(false);
    setCode('');
  };
  return (
    <form className="door__code" onSubmit={send}>
      <TextField
        label={t('checkin.code')}
        hint={t('checkin.codeHint')}
        value={code}
        onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={10}
        inputMode="text"
      />
      <Button type="submit" loading={busy} disabled={!code.trim()}>
        {t('checkin.submit')}
      </Button>
    </form>
  );
}

/** The guest list: search by name or code, everyone / checked in / not yet, Check in and Undo. */
function GuestList({
  eventId,
  version,
  time,
  onCheckIn,
  onUndo,
}: {
  eventId: string;
  version: number;
  time: (iso: string) => string;
  onCheckIn: (g: TicketGuest) => Promise<void>;
  onUndo: (g: TicketGuest) => Promise<void>;
}) {
  const { t } = useSession();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<TicketGuest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shownCount = useRef(50);

  useEffect(() => {
    const timer = setTimeout(
      () =>
        api.events.guests(eventId, { q: q.trim() || undefined, filter, limit: Math.max(50, shownCount.current) }).then(
          (r) => {
            setItems(r.items);
            setTotal(r.total);
            setNext(r.nextOffset);
          },
          () => setItems((cur) => cur ?? []),
        ),
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [eventId, q, filter, version]);

  const more = async () => {
    if (next === null) return;
    const r = await api.events.guests(eventId, { q: q.trim() || undefined, filter, offset: next });
    setItems((cur) => [...(cur ?? []), ...r.items]);
    shownCount.current = (items?.length ?? 0) + r.items.length;
    setNext(r.nextOffset);
  };

  return (
    <section className="door__guests" aria-labelledby="door-guests">
      <h2 id="door-guests" className="door__h2">
        {t('checkin.guests')} <span className="door__total">({total})</span>
      </h2>
      <TextField label={t('checkin.search')} value={q} onChange={(e) => setQ(e.currentTarget.value)} type="search" autoComplete="off" />
      <Segments
        label={t('checkin.filter')}
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: t('checkin.filter.all') },
          { id: 'waiting', label: t('checkin.filter.waiting') },
          { id: 'in', label: t('checkin.filter.in') },
        ]}
      />
      {items === null ? (
        <Skeleton height={200} />
      ) : items.length ? (
        <ul className="guest-list">
          {items.map((g) => (
            <li key={g.ticketId} className="guest">
              <Avatar name={g.name} src={g.avatarUrl} size="sm" />
              <span className="guest__who">
                <bdi className="guest__name">{g.name}</bdi>
                <span className="guest__meta">
                  <bdi>{g.type ?? t('tickets.type.rsvp')}</bdi>
                  {g.username ? <> · @{g.username}</> : null}
                  {g.limited ? <> · {t('checkin.limited')}</> : null}
                </span>
              </span>
              {g.checkedInAt ? (
                <>
                  <Badge tone="success">{t('checkin.inAt', { time: time(g.checkedInAt) })}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === g.ticketId}
                    aria-label={t('checkin.undoName', { name: g.name })}
                    onClick={async () => {
                      setBusy(g.ticketId);
                      await onUndo(g);
                      setBusy(null);
                    }}
                  >
                    {t('checkin.undo')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  loading={busy === g.ticketId}
                  aria-label={t('checkin.checkInName', { name: g.name })}
                  onClick={async () => {
                    setBusy(g.ticketId);
                    await onCheckIn(g);
                    setBusy(null);
                  }}
                >
                  {t('checkin.checkIn')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="door__hint">{q || filter !== 'all' ? t('checkin.noMatch') : t('checkin.noGuests')}</p>
      )}
      {next !== null ? (
        <Button variant="secondary" onClick={() => void more()}>
          {t('checkin.more')}
        </Button>
      ) : null}
    </section>
  );
}

/** The host's settings for the door: whether guests may give tickets to friends, and co-hosts. A co-host can step down. */
function DoorSettings({ door, meId, onChange }: { door: DoorSummary; meId: string; onChange: (d: DoorSummary) => void }) {
  const { t, toast } = useSession();
  const [adding, setAdding] = useState<PublicUser[]>([]);
  const host = door.role === 'host';
  const id = door.event.id;

  if (!host)
    return (
      <section className="door__settings">
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              await api.events.removeCohost(id, meId);
              location.assign(`/events/${id}`);
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        >
          {t('checkin.leave')}
        </Button>
      </section>
    );

  return (
    <section className="door__settings" aria-labelledby="door-settings">
      <h2 id="door-settings" className="door__h2">
        {t('checkin.cohosts')}
      </h2>
      <p className="door__hint">{t('checkin.cohostsHelp')}</p>
      {door.cohosts.length ? (
        <ul className="guest-list">
          {door.cohosts.map((c) => (
            <li key={c.id} className="guest">
              <Avatar name={c.displayName} src={c.avatarUrl} size="sm" />
              <span className="guest__who">
                <bdi className="guest__name">{c.displayName}</bdi>
                <span className="guest__meta">@{c.username}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('checkin.removeCohost', { name: c.displayName })}
                onClick={async () => {
                  try {
                    await api.events.removeCohost(id, c.id);
                    onChange({ ...door, cohosts: door.cohosts.filter((x) => x.id !== c.id) });
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t('m.common.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="door__hint">{t('checkin.noCohosts')}</p>
      )}
      <PeoplePicker
        picked={adding}
        label={t('checkin.addCohost')}
        max={1}
        exclude={door.cohosts.map((c) => c.id)}
        canPick={(s) => s.relation === 'friend'}
        unavailable={t('tickets.give.friendsOnly')}
        onChange={async (people) => {
          const person = people[0];
          setAdding(people);
          if (!person) return;
          try {
            await api.events.addCohost(id, person.id);
            onChange({ ...door, cohosts: [...door.cohosts, person] });
          } catch (e) {
            toast(errorMessage(e));
          }
          setAdding([]);
        }}
      />
      <div className="door__switch">
        <Switch
          label={t('checkin.transfers')}
          checked={door.ticketTransfers}
          onChange={async (v) => {
            try {
              await api.events.update(id, { ticketTransfers: v });
              onChange({ ...door, ticketTransfers: v });
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        />
        <p className="door__hint">{t('checkin.transfersHelp')}</p>
      </div>
    </section>
  );
}
