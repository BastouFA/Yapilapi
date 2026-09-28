'use client';

import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import { formatRelativeTime, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** A booking's status, in words. */
const bookingStatus = (status: string): MessageKey =>
  status === 'confirmed' || status === 'declined' || status === 'cancelled' ? `m.booking.status.${status}` : 'm.booking.status.requested';

const stars = (n: number) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

export function PlaceReviews({ placeId }: { placeId: string }) {
  const { toast, locale, t, tp } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.reviews.list>> | null>(null);
  const [rating, setRating] = useState('5');
  const [body, setBody] = useState('');
  const load = () => api.reviews.list(placeId).then(setData, () => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId]);
  if (!data) return null;
  return (
    <Card
      title={t('m.place.reviews')}
      subtitle={data.count ? `${t('m.place.stars', { rating: data.average ?? 0 })} · ${tp('m.place.reviewCount', data.count)}` : t('m.place.noReviews')}
    >
      <div className="stack-sm">
        {data.items.length ? (
          <List>
            {data.items.map((r) => (
              <ListItem
                key={r.id}
                start={<Avatar name={r.author.displayName} src={r.author.avatarUrl} size="sm" />}
                primary={
                  <span aria-label={t('m.place.stars', { rating: r.rating })}>
                    {stars(r.rating)} <span className="muted">{r.author.displayName}</span>
                  </span>
                }
                secondary={r.body || formatRelativeTime(r.createdAt, locale)}
              />
            ))}
          </List>
        ) : null}
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.reviews.save(placeId, Number(rating), body);
              setBody('');
              toast(t('m.place.reviewSaved'));
              await load();
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <Select label={t('m.place.yourRating')} value={rating} onChange={(e) => setRating(e.currentTarget.value)}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {stars(n)} ({n})
              </option>
            ))}
          </Select>
          <TextField label={t('m.place.reviewBody')} multiline value={body} onChange={(e) => setBody(e.currentTarget.value)} maxLength={2000} />
          <Button type="submit" size="sm">
            {t('m.place.saveReview')}
          </Button>
        </form>
      </div>
    </Card>
  );
}

export function BookTable({ placeId }: { placeId: string }) {
  const { toast, t } = useSession();
  const [party, setParty] = useState('2');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  return (
    <Card title={t('m.booking.title')} subtitle={t('m.booking.intro')}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.bookings.create(placeId, { partySize: Number(party), startsAt: new Date(when).toISOString(), note });
            toast(t('place.book.requested'));
            setNote('');
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <Select label={t('m.booking.people')} value={party} onChange={(e) => setParty(e.currentTarget.value)}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <TextField label={t('shop.when')} type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} required />
        <TextField label={t('m.booking.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
        <Button type="submit" disabled={!when}>
          {t('m.booking.request')}
        </Button>
      </form>
    </Card>
  );
}

/** For the business owner: incoming booking requests. */
export function ManageBookings({ placeId }: { placeId: string }) {
  const { toast, locale, t, tp } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.bookings.forPlace>>['items'] | null>(null);
  const load = () =>
    api.bookings.forPlace(placeId).then(
      (r) => setItems(r.items),
      () => setItems(null),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId]);
  if (!items) return null;
  return (
    <Card title={t('m.booking.requests')}>
      {items.length ? (
        <List>
          {items.map((b) => (
            <ListItem
              key={b.id}
              primary={`${b.guest} · ${tp('m.booking.partyOf', b.party_size)}`}
              secondary={`${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.starts_at))}${b.note ? ` · ${b.note}` : ''}`}
              end={
                b.status === 'requested' ? (
                  <>
                    <Button size="sm" onClick={async () => (await api.bookings.decide(b.id, true).catch((e) => toast(errorMessage(e))), await load())}>
                      {t('m.booking.confirm')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={async () => (await api.bookings.decide(b.id, false), await load())}>
                      {t('m.common.decline')}
                    </Button>
                  </>
                ) : (
                  <Badge tone={b.status === 'confirmed' ? 'success' : 'neutral'}>{t(bookingStatus(b.status))}</Badge>
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
