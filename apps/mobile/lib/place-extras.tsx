import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { formatClock, uses12Hour } from '../../../packages/shared/src/date-picker';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { bookingSlots } from '../../../packages/shared/src/scheduling';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { Chip, ChipRow, SectionHeader } from './chips';
import { DateField, useWhenText } from './date-time';
import { Pill, StarPicker, Stars, Stepper } from './forms';
import { useT } from './i18n';
import { useSession } from './session';
import { space } from './theme';
import { Avatar, Button, Card, Field, Notice, useColors, userText } from './ui';

type Review = { id: string; rating: number; body: string; createdAt: string; author: PublicUser };
export type ReviewData = { average: number | null; count: number; items: Review[] };
type OwnerBooking = { id: string; status: string; party_size: number; starts_at: string; note: string; guest: string };
type MyBooking = { id: string; status: string; party_size: number; starts_at: string; place_id: string | null };

const STATUS: Record<string, { key: MessageKey; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  requested: { key: 'm.booking.status.requested', tone: 'warn' },
  confirmed: { key: 'm.booking.status.confirmed', tone: 'good' },
  declined: { key: 'm.booking.status.declined', tone: 'bad' },
  cancelled: { key: 'm.booking.status.cancelled', tone: 'neutral' },
};

function StatusPill({ status }: { status: string }) {
  const { t } = useT();
  const s = STATUS[status];
  return <Pill text={s ? t(s.key) : status} tone={s?.tone ?? 'neutral'} />;
}

/**
 * The place's bookings when you own it (only the owner can read them), false when you don't, and
 * null while finding out, so neither the owner's list nor the booking form flashes up first.
 */
export function usePlaceOwner(placeId: string, hasBusiness: boolean) {
  const { me } = useSession();
  const [owner, setOwner] = useState<OwnerBooking[] | false | null>(null);
  const asks = hasBusiness && !!me;
  const reload = useCallback(async () => {
    if (!asks) return;
    try {
      setOwner((await (await client()).bookings.forPlace(placeId)).items);
    } catch {
      setOwner(false);
    }
  }, [placeId, asks]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { bookings: asks ? owner : false, reload };
}

/** A place's rating as stars, the average and how many reviews. */
export function RatingLine({ data }: { data: ReviewData | null }) {
  const c = useColors();
  const { t, tp } = useT();
  if (!data || !data.count || data.average === null) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
      <Stars rating={data.average} />
      <Text style={{ color: c.ink, fontWeight: '700' }}>{t('m.place.stars', { rating: String(data.average) })}</Text>
      <Text style={{ color: c.inkMuted }}>{tp('m.place.reviewCount', data.count)}</Text>
    </View>
  );
}

/**
 * Reviews: what people said, and yours to write or change (one per person, as on the web). The
 * owner of the place can't review it.
 */
export function PlaceReviews({ placeId, data, reload, isOwner }: { placeId: string; data: ReviewData | null; reload: () => Promise<void>; isOwner: boolean }) {
  const c = useColors();
  const { t, timeAgo } = useT();
  const { me } = useSession();
  const mine = data?.items.find((r) => r.author.id === me?.id) ?? null;
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mine) {
      setRating(mine.rating);
      setBody(mine.body);
    }
  }, [mine]);

  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={t('m.place.reviews')} />
      {data?.items.length ? (
        data.items.map((r) => (
          <Card key={r.id} style={{ gap: space[2], padding: space[3] }}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={r.author.displayName}
              onPress={() => router.push(`/u/${encodeURIComponent(r.author.username)}`)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
            >
              <Avatar name={r.author.displayName} url={r.author.avatarUrl} size={32} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                  {r.author.displayName}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{timeAgo(r.createdAt)}</Text>
              </View>
              <Stars rating={r.rating} size={14} />
            </Pressable>
            {r.body ? <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{r.body}</Text> : null}
          </Card>
        ))
      ) : data ? (
        <Text style={{ color: c.inkMuted }}>{t('m.place.noReviews')}</Text>
      ) : null}
      {me && !isOwner ? (
        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 16, fontWeight: '800' }}>
            {mine ? t('m.place.yourReview') : t('m.place.writeReview')}
          </Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <StarPicker label={t('m.place.yourRating')} value={rating} onChange={setRating} />
          <Field
            label={t('m.place.reviewBody')}
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={2000}
            style={{ minHeight: 90, textAlignVertical: 'top', paddingTop: 12 }}
          />
          {note ? (
            <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
              {note}
            </Text>
          ) : null}
          <Button
            label={saving ? t('m.common.saving') : t('m.place.saveReview')}
            disabled={!rating || saving}
            onPress={async () => {
              setSaving(true);
              setError(null);
              setNote(null);
              try {
                await (await client()).reviews.save(placeId, rating, body.trim());
                setNote(t('m.place.reviewSaved'));
                await reload();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setSaving(false);
              }
            }}
          />
        </Card>
      ) : null}
    </View>
  );
}

const DAY_MS = 86_400_000;
const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * Ask to book: how many people, the day, a time slot while the place is open (with the room left
 * at each time when the place sets a limit), and a note. The place confirms or declines.
 */
export function BookPlace({ placeId, hours, onBooked }: { placeId: string; hours: Record<string, unknown> | null; onBooked: () => void }) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const when = useWhenText();
  const [party, setParty] = useState(2);
  const [day, setDay] = useState(startOfToday);
  const [slot, setSlot] = useState<Date | null>(null);
  const [room, setRoom] = useState<Map<number, number | null> | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hour12 = uses12Hour(locale);

  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => new Date(startOfToday().getTime() + i * DAY_MS + 2 * 3_600_000)), []);
  const slots = useMemo(() => bookingSlots(day, hours, new Date()).slice(0, 48), [day, hours]);
  const slotKey = slots.map((s) => s.getTime()).join(',');

  // Room left at each slot of the chosen day.
  useEffect(() => {
    setRoom(null);
    if (!slots.length) return;
    let live = true;
    void client()
      .then((api) =>
        api.places.availability(
          placeId,
          slots.map((s) => s.toISOString()),
        ),
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

  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const pickDay = (d: Date) => {
    setDay(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    setSlot(null);
    setDone(null);
  };
  const leftAt = (s: Date) => room?.get(s.getTime()) ?? null;
  const fits = (s: Date) => {
    const left = leftAt(s);
    return left === null || left >= party;
  };

  return (
    <Card style={{ gap: space[3] }}>
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.booking.intro')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Stepper label={t('m.booking.people')} value={party} min={1} max={50} onChange={setParty} />
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.booking.day')}</Text>
        <ChipRow scroll radios label={t('m.booking.day')}>
          {days.map((d) => (
            <Chip key={d.getTime()} radio label={when(d, 'date')} selected={sameDay(d, day)} onPress={() => pickDay(d)} />
          ))}
        </ChipRow>
        <DateField
          label={t('m.booking.otherDay')}
          mode="date"
          value={days.some((d) => sameDay(d, day)) ? null : day}
          onChange={pickDay}
          min={startOfToday()}
          max={new Date(startOfToday().getTime() + 90 * DAY_MS)}
        />
      </View>
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.booking.time')}</Text>
        {slots.length ? (
          <ChipRow radios label={t('m.booking.time')}>
            {slots.map((s) => {
              const left = leftAt(s);
              const full = !fits(s);
              const label = formatClock(locale, s, hour12);
              const meta = left === null ? undefined : full ? t('m.booking.full') : tp('m.booking.left', left);
              return (
                <Chip
                  key={s.getTime()}
                  radio
                  label={label}
                  meta={meta}
                  disabled={full}
                  selected={slot?.getTime() === s.getTime()}
                  onPress={() => {
                    setSlot(s);
                    setDone(null);
                  }}
                />
              );
            })}
          </ChipRow>
        ) : (
          <Text style={{ color: c.inkMuted }}>{t('m.booking.noTimes')}</Text>
        )}
        {slot && !fits(slot) ? <Text style={{ color: c.danger, fontSize: 13 }}>{t('m.booking.tooMany')}</Text> : null}
      </View>
      <Field label={t('m.booking.note')} value={note} onChangeText={setNote} maxLength={500} />
      {done ? <Notice>{done}</Notice> : null}
      <Button
        label={busy ? t('m.booking.sending') : t('m.booking.request')}
        icon="calendar-outline"
        disabled={!slot || !fits(slot) || busy}
        onPress={async () => {
          if (!slot) return;
          setBusy(true);
          setError(null);
          setDone(null);
          try {
            await (await client()).bookings.create(placeId, { partySize: party, startsAt: slot.toISOString(), note: note.trim() });
            setDone(t('m.booking.requested', { when: when(slot) }));
            setNote('');
            setSlot(null);
            onBooked();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </Card>
  );
}

/** Your bookings at this place that haven't happened yet, with a way to cancel. */
export function MyBookings({ placeId, version }: { placeId: string; version: number }) {
  const c = useColors();
  const { t, tp } = useT();
  const when = useWhenText();
  const [items, setItems] = useState<MyBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await (await client()).bookings.mine();
      const now = Date.now();
      setItems(r.items.filter((b) => b.place_id === placeId && new Date(b.starts_at).getTime() > now - 3_600_000).reverse());
    } catch {
      setItems([]);
    }
  }, [placeId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  if (!items.length) return null;
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={t('m.booking.yours')} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.map((b) => (
        <Card key={b.id} style={{ gap: space[2], padding: space[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Text style={{ flex: 1, color: c.ink, fontWeight: '600' }}>{when(new Date(b.starts_at))}</Text>
            <StatusPill status={b.status} />
          </View>
          <Text style={{ color: c.inkMuted }}>{tp('m.booking.partyOf', b.party_size)}</Text>
          {b.status === 'requested' || b.status === 'confirmed' ? (
            <Button
              label={t('m.booking.cancel')}
              variant="ghost"
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onPress={() =>
                Alert.alert(t('m.booking.cancelTitle'), when(new Date(b.starts_at)), [
                  { text: t('m.common.notNow'), style: 'cancel' },
                  {
                    text: t('m.booking.cancel'),
                    style: 'destructive',
                    onPress: async () => {
                      setError(null);
                      try {
                        await (await client()).bookings.cancel(b.id);
                        await load();
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    },
                  },
                ])
              }
            />
          ) : null}
        </Card>
      ))}
    </View>
  );
}

/** For the place's owner: requests to book, to confirm or decline, and what's already decided. */
export function ManageBookings({ items, reload }: { items: OwnerBooking[]; reload: () => Promise<void> }) {
  const c = useColors();
  const { t, tp } = useT();
  const when = useWhenText();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, confirm: boolean) => {
    setBusy(id);
    setError(null);
    try {
      await (await client()).bookings.decide(id, confirm);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const waiting = items.filter((b) => b.status === 'requested').length;
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={t('m.booking.requests')} />
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{waiting ? tp('m.booking.waiting', waiting) : t('m.booking.noneWaiting')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.map((b) => (
        <Card key={b.id} style={{ gap: space[2], padding: space[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Text style={[{ flex: 1, color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
              {b.guest}
            </Text>
            <StatusPill status={b.status} />
          </View>
          <Text style={{ color: c.ink }}>
            {when(new Date(b.starts_at))} · {tp('m.booking.partyOf', b.party_size)}
          </Text>
          {b.note ? <Text style={[{ color: c.inkMuted }, userText]}>{b.note}</Text> : null}
          {b.status === 'requested' ? (
            <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
              <Button label={t('m.booking.confirm')} size="sm" icon="checkmark" disabled={busy === b.id} onPress={() => decide(b.id, true)} />
              <Button label={t('m.common.decline')} size="sm" variant="secondary" disabled={busy === b.id} onPress={() => decide(b.id, false)} />
            </View>
          ) : null}
        </Card>
      ))}
    </View>
  );
}
