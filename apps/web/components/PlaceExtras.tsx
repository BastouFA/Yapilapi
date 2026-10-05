'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Avatar, Badge, Button, Card, Dialog, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import { bookingSlots, formatRelativeTime, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** A booking's status, in words. */
const bookingStatus = (status: string): MessageKey =>
  status === 'confirmed' || status === 'declined' || status === 'cancelled' ? `m.booking.status.${status}` : 'm.booking.status.requested';
const statusTone = (status: string) => (status === 'confirmed' ? 'success' : status === 'requested' ? 'warning' : 'neutral');

const stars = (n: number) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

type Reviews = Awaited<ReturnType<typeof api.reviews.list>>;

/** Reviews: what people said, and yours to write or change (one each). The place's owner can't review it. */
export function PlaceReviews({ placeId, isOwner }: { placeId: string; isOwner: boolean }) {
  const { toast, locale, t, tp, me } = useSession();
  const [data, setData] = useState<Reviews | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [rating, setRating] = useState('5');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    setLoadError(false);
    return api.reviews.list(placeId).then(setData, () => setLoadError(true));
  }, [placeId]);
  useEffect(() => {
    void load();
  }, [load]);
  const mine = data?.items.find((r) => r.author.id === me?.id) ?? null;
  // Your own review fills the form, to change it.
  useEffect(() => {
    if (!mine) return;
    setRating(String(mine.rating));
    setBody(mine.body);
  }, [mine]);

  if (loadError)
    return (
      <Alert tone="danger">
        {t('place.reviews.loadError')}{' '}
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          {t('m.common.retry')}
        </Button>
      </Alert>
    );
  if (!data) return null;
  return (
    <Card
      title={t('m.place.reviews')}
      subtitle={data.count ? `${t('m.place.stars', { rating: data.average ?? 0 })} · ${tp('m.place.reviewCount', data.count)}` : t('m.place.noReviews')}
    >
      <div className="stack-sm">
        {data.items.length ? (
          <List label={t('m.place.reviews')}>
            {data.items.map((r) => (
              <ListItem
                key={r.id}
                start={<Avatar name={r.author.displayName} src={r.author.avatarUrl} size="sm" />}
                primary={
                  <>
                    <span role="img" aria-label={t('m.place.stars', { rating: r.rating })}>
                      {stars(r.rating)}
                    </span>{' '}
                    <span className="muted">{r.author.displayName}</span>
                  </>
                }
                secondary={r.body || formatRelativeTime(r.createdAt, locale)}
              />
            ))}
          </List>
        ) : null}
        {me && !isOwner ? (
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              try {
                await api.reviews.save(placeId, Number(rating), body.trim());
                toast(t('m.place.reviewSaved'));
                await load();
              } catch (err) {
                toast(errorMessage(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            <h3 className="section-title" style={{ margin: 0 }}>
              {mine ? t('m.place.yourReview') : t('m.place.writeReview')}
            </h3>
            <Select label={t('m.place.yourRating')} value={rating} onChange={(e) => setRating(e.currentTarget.value)}>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {stars(n)} ({n})
                </option>
              ))}
            </Select>
            <TextField label={t('m.place.reviewBody')} multiline value={body} onChange={(e) => setBody(e.currentTarget.value)} maxLength={2000} />
            <div>
              <Button type="submit" size="sm" loading={saving}>
                {t('m.place.saveReview')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

const DAY_MS = 86_400_000;
const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Ask to book: how many people, the day, a time while the place is open (with the room left at
 * each time when the place sets a limit), and a note. The place confirms or declines.
 */
export function BookTable({ placeId, hours, onBooked }: { placeId: string; hours: Record<string, unknown> | null; onBooked: () => void }) {
  const { toast, t, tp, locale } = useSession();
  const [party, setParty] = useState('2');
  const [day, setDay] = useState(startOfToday);
  const [slot, setSlot] = useState<Date | null>(null);
  const [room, setRoom] = useState<Map<number, number | null> | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slots = useMemo(() => bookingSlots(day, hours, new Date()).slice(0, 48), [day, hours]);
  const slotKey = slots.map((s) => s.getTime()).join(',');
  const size = Number(party);
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }), [locale]);
  const longDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }), [locale]);

  // Room left at each time of the chosen day.
  useEffect(() => {
    setRoom(null);
    if (!slots.length) return;
    let live = true;
    api.places
      .availability(
        placeId,
        slots.map((s) => s.toISOString()),
      )
      .then(
        (r) => live && setRoom(new Map(r.slots.map((s) => [new Date(s.startsAt).getTime(), s.left]))),
        () => live && setRoom(new Map()),
      );
    return () => {
      live = false;
    };
    // slotKey stands for the slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId, slotKey]);
  const leftAt = (s: Date) => room?.get(s.getTime()) ?? null;
  const fits = (s: Date) => {
    const left = leftAt(s);
    return left === null || left >= size;
  };

  return (
    <Card title={t('m.booking.title')} subtitle={t('m.booking.intro')}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!slot || !fits(slot)) return;
          setBusy(true);
          setError(null);
          try {
            await api.bookings.create(placeId, { partySize: size, startsAt: slot.toISOString(), note: note.trim() });
            toast(t('m.booking.requested', { when: longDate.format(slot) }));
            setNote('');
            setSlot(null);
            onBooked();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Select label={t('m.booking.people')} value={party} onChange={(e) => setParty(e.currentTarget.value)}>
            {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <TextField
            label={t('m.booking.day')}
            type="date"
            value={dateValue(day)}
            min={dateValue(startOfToday())}
            max={dateValue(new Date(startOfToday().getTime() + 90 * DAY_MS))}
            onChange={(e) => {
              const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.currentTarget.value);
              if (!m) return;
              setDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
              setSlot(null);
            }}
          />
        </div>
        <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="yp-field__label">{t('m.booking.time')}</legend>
          {slots.length ? (
            <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {slots.map((s) => {
                const left = leftAt(s);
                const full = !fits(s);
                const meta = left === null ? null : full ? t('m.booking.full') : tp('m.booking.left', left);
                return (
                  <Button
                    key={s.getTime()}
                    size="sm"
                    variant={slot?.getTime() === s.getTime() ? 'primary' : 'secondary'}
                    aria-pressed={slot?.getTime() === s.getTime()}
                    disabled={full}
                    onClick={() => setSlot(s)}
                  >
                    {clock.format(s)}
                    {meta ? <span className="muted"> · {meta}</span> : null}
                  </Button>
                );
              })}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {t('m.booking.noTimes')}
            </p>
          )}
          {slot && !fits(slot) ? (
            <p className="yp-field__error" role="alert">
              {t('m.booking.tooMany')}
            </p>
          ) : null}
        </fieldset>
        <TextField label={t('m.booking.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
        <div>
          <Button type="submit" loading={busy} disabled={!slot || !fits(slot)}>
            {t('m.booking.request')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

type MyBooking = Awaited<ReturnType<typeof api.bookings.mine>>['items'][number];

/** Your bookings at this place that haven't happened yet, with a way to cancel. */
export function MyBookings({ placeId, version }: { placeId: string; version: number }) {
  const { t, tp, locale, toast } = useSession();
  const [items, setItems] = useState<MyBooking[]>([]);
  const [cancelling, setCancelling] = useState<MyBooking | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }), [locale]);
  const load = useCallback(() => {
    api.bookings.mine().then(
      (r) => {
        const now = Date.now();
        setItems(r.items.filter((b) => b.place_id === placeId && new Date(b.starts_at).getTime() > now - 3_600_000).reverse());
      },
      () => setItems([]),
    );
  }, [placeId]);
  useEffect(() => {
    load();
  }, [load, version]);
  if (!items.length) return null;
  return (
    <Card title={t('m.booking.yours')}>
      <List label={t('m.booking.yours')}>
        {items.map((b) => (
          <ListItem
            key={b.id}
            primary={fmt.format(new Date(b.starts_at))}
            secondary={tp('m.booking.partyOf', b.party_size)}
            end={
              <>
                <Badge tone={statusTone(b.status)}>{t(bookingStatus(b.status))}</Badge>
                {b.status === 'requested' || b.status === 'confirmed' ? (
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(b)}>
                    {t('m.booking.cancel')}
                  </Button>
                ) : null}
              </>
            }
          />
        ))}
      </List>
      <Dialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        title={t('m.booking.cancelTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelling(null)}>
              {t('m.common.notNow')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!cancelling) return;
                setBusy(true);
                try {
                  await api.bookings.cancel(cancelling.id);
                  load();
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                  setCancelling(null);
                }
              }}
            >
              {t('m.booking.cancel')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{cancelling ? fmt.format(new Date(cancelling.starts_at)) : ''}</p>
      </Dialog>
    </Card>
  );
}

/** For the place's owner: requests to book, to confirm or decline, and what's already decided. */
export function ManageBookings({ placeId }: { placeId: string }) {
  const { toast, locale, t, tp } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.bookings.forPlace>>['items'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale]);
  const load = useCallback(
    () =>
      api.bookings.forPlace(placeId).then(
        (r) => setItems(r.items),
        () => setItems(null),
      ),
    [placeId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (id: string, confirm: boolean) => {
    setBusy(id);
    try {
      await api.bookings.decide(id, confirm);
      await load();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  if (!items) return null;
  const waiting = items.filter((b) => b.status === 'requested').length;
  return (
    <Card title={t('m.booking.requests')} subtitle={waiting ? tp('m.booking.waiting', waiting) : t('m.booking.noneWaiting')}>
      {items.length ? (
        <List label={t('m.booking.requests')}>
          {items.map((b) => (
            <ListItem
              key={b.id}
              primary={`${b.guest} · ${tp('m.booking.partyOf', b.party_size)}`}
              secondary={`${fmt.format(new Date(b.starts_at))}${b.note ? ` · ${b.note}` : ''}`}
              end={
                b.status === 'requested' ? (
                  <>
                    <Button size="sm" loading={busy === b.id} onClick={() => void decide(b.id, true)}>
                      {t('m.booking.confirm')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === b.id} onClick={() => void decide(b.id, false)}>
                      {t('m.common.decline')}
                    </Button>
                  </>
                ) : (
                  <Badge tone={statusTone(b.status)}>{t(bookingStatus(b.status))}</Badge>
                )
              }
            />
          ))}
        </List>
      ) : (
        <p className="muted">{t('place.bookings.none')}</p>
      )}
    </Card>
  );
}
