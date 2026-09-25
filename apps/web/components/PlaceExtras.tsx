'use client';

import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import { formatRelativeTime } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const stars = (n: number) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

export function PlaceReviews({ placeId }: { placeId: string }) {
  const { toast, locale } = useSession();
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
    <Card title="Reviews" subtitle={data.count ? `${data.average} out of 5 · ${data.count} review${data.count > 1 ? 's' : ''}` : 'No reviews yet'}>
      <div className="stack-sm">
        {data.items.length ? (
          <List>
            {data.items.map((r) => (
              <ListItem
                key={r.id}
                start={<Avatar name={r.author.displayName} src={r.author.avatarUrl} size="sm" />}
                primary={
                  <span aria-label={`${r.rating} out of 5`}>
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
              toast('Review saved');
              await load();
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <Select label="Your rating" value={rating} onChange={(e) => setRating(e.currentTarget.value)}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {stars(n)} ({n})
              </option>
            ))}
          </Select>
          <TextField label="Your review (optional)" multiline value={body} onChange={(e) => setBody(e.currentTarget.value)} maxLength={2000} />
          <Button type="submit" size="sm">
            Save review
          </Button>
        </form>
      </div>
    </Card>
  );
}

export function BookTable({ placeId }: { placeId: string }) {
  const { toast } = useSession();
  const [party, setParty] = useState('2');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  return (
    <Card title="Book" subtitle="The place confirms your request. You'll get a notification.">
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.bookings.create(placeId, { partySize: Number(party), startsAt: new Date(when).toISOString(), note });
            toast('Booking requested');
            setNote('');
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <Select label="People" value={party} onChange={(e) => setParty(e.currentTarget.value)}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <TextField label="When" type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} required />
        <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
        <Button type="submit" disabled={!when}>
          Request booking
        </Button>
      </form>
    </Card>
  );
}

/** For the business owner: incoming booking requests. */
export function ManageBookings({ placeId }: { placeId: string }) {
  const { toast, locale } = useSession();
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
    <Card title="Booking requests">
      {items.length ? (
        <List>
          {items.map((b) => (
            <ListItem
              key={b.id}
              primary={`${b.guest} · ${b.party_size} people`}
              secondary={`${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.starts_at))}${b.note ? ` · ${b.note}` : ''}`}
              end={
                b.status === 'requested' ? (
                  <>
                    <Button size="sm" onClick={async () => (await api.bookings.decide(b.id, true).catch((e) => toast(errorMessage(e))), await load())}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="ghost" onClick={async () => (await api.bookings.decide(b.id, false), await load())}>
                      Decline
                    </Button>
                  </>
                ) : (
                  <Badge tone={b.status === 'confirmed' ? 'success' : 'neutral'}>{b.status}</Badge>
                )
              }
            />
          ))}
        </List>
      ) : (
        <p className="muted">No upcoming bookings.</p>
      )}
    </Card>
  );
}
