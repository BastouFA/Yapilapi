'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, EmptyState, Segments, Select, Skeleton, TextField } from '@yapilapi/design-system';
import { timeZoneLabel, timeZoneList, utcToZonedWall, zonedWallToUtc, type Community, type EventItem } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors, isGone } from '@/lib/api';
import { useSession } from '@/app/providers';

type Where = 'address' | 'place' | 'online';
type Visibility = 'public' | 'followers' | 'friends' | 'private';
type PlaceHit = { id: string; name: string; city?: string | null };

/** The browser's own time zone, or UTC when it can't say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A link someone can open: http or https only. */
export const isWebLink = (s: string) => /^https?:\/\/\S+\.\S+/i.test(s.trim());

const pad = (n: number) => String(n).padStart(2, '0');
/** The value of a datetime-local field showing what a clock in `tz` reads at `iso`. */
function toLocalInput(iso: string, tz: string): string {
  const w = utcToZonedWall(iso, tz);
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}T${pad(w.getHours())}:${pad(w.getMinutes())}`;
}
/** The instant a datetime-local value means in `tz`, or null when it's empty or not a time. */
function fromLocalInput(v: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return zonedWallToUtc(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])), tz);
}

/**
 * Make an event, or change one you host: title, when (in the event's own time zone), where (an
 * address, a place on YAPILAPI, or online with a link), how many people, who can see it, whether
 * tickets can be given to friends, and for organizers which community it belongs to.
 */
export function EventForm({ eventId, communityId: initialCommunity }: { eventId?: string; communityId?: string | null }) {
  const { t, toast, me } = useSession();
  const router = useRouter();
  const editing = eventId ?? null;
  const [loaded, setLoaded] = useState<EventItem | null | undefined>(editing ? undefined : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tz, setTz] = useState(browserTimeZone);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [where, setWhere] = useState<Where>('address');
  const [address, setAddress] = useState('');
  const [link, setLink] = useState('');
  const [place, setPlace] = useState<PlaceHit | null>(null);
  const [capacity, setCapacity] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [transfers, setTransfers] = useState(true);
  const [communityId, setCommunityId] = useState(initialCommunity ?? '');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const zones = useMemo(() => timeZoneList([browserTimeZone(), tz]), [tz]);

  const loadEvent = () => {
    if (!editing) return;
    setLoadError(null);
    api.events.get(editing).then(
      ({ event }) => {
        // Only the host changes an event.
        if (event.host.id !== me?.id) return setLoaded(null);
        const zone = event.timezone || browserTimeZone();
        setTitle(event.title);
        setDescription(event.description);
        setTz(zone);
        setStart(toLocalInput(event.startsAt, zone));
        setEnd(event.endsAt ? toLocalInput(event.endsAt, zone) : '');
        if (event.online) {
          setWhere('online');
          setLink(event.locationText ?? '');
        } else if (event.place) {
          setWhere('place');
          setPlace(event.place);
        } else setAddress(event.locationText ?? '');
        setCapacity(event.capacity ? String(event.capacity) : '');
        setVisibility((['public', 'followers', 'friends', 'private'] as const).find((v) => v === event.visibility) ?? 'public');
        setTransfers(event.ticketTransfers);
        setLoaded(event);
      },
      (e) => (isGone(e) ? setLoaded(null) : setLoadError(errorMessage(e))),
    );
  };
  useEffect(() => {
    loadEvent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Communities where you can make events (organizers and up), for a new event.
  useEffect(() => {
    if (editing) return;
    api.communities.list('mine').then(
      (r) => setCommunities(r.items.filter((x) => ['owner', 'admin', 'moderator', 'organizer'].includes(x.myRole ?? ''))),
      () => {},
    );
  }, [editing]);

  if (editing && loaded === undefined)
    return loadError ? (
      <EmptyState level={1} title={loadError} action={<Button onClick={loadEvent}>{t('m.common.retry')}</Button>} />
    ) : (
      <Skeleton height={320} />
    );
  if (editing && loaded === null) return <EmptyState level={1} title={t('m.event.notFound')} body={t('eventPage.notFoundBody')} />;

  const startAt = fromLocalInput(start, tz);
  const endAt = end ? fromLocalInput(end, tz) : null;
  const endOk = !endAt || !startAt || endAt > startAt;
  const cap = capacity.trim() ? Number(capacity.trim()) : null;
  const capOk = cap === null || (Number.isInteger(cap) && cap > 0 && cap <= 1_000_000);
  const linkOk = where !== 'online' || !link.trim() || isWebLink(link);
  const ready = !!title.trim() && !!startAt && endOk && capOk && linkOk && (where !== 'place' || !!place);

  async function save() {
    if (!startAt) return;
    setBusy(true);
    setError(null);
    setFields({});
    const body = {
      title: title.trim(),
      description: description.trim(),
      startsAt: startAt.toISOString(),
      endsAt: endAt ? endAt.toISOString() : null,
      timezone: tz,
      online: where === 'online',
      locationText: where === 'online' ? link.trim() || null : where === 'address' ? address.trim() || null : null,
      placeId: where === 'place' ? (place?.id ?? null) : null,
      capacity: cap,
      visibility,
      ticketTransfers: transfers,
    };
    try {
      if (editing) {
        await api.events.update(editing, body);
        toast(t('m.manage.saved'));
        router.push(`/events/${editing}`);
      } else {
        // A new event leaves out what's empty rather than clearing it.
        const created = Object.fromEntries(Object.entries({ ...body, communityId: communityId || undefined }).filter(([, v]) => v !== null && v !== undefined));
        const { event } = await api.events.create(created);
        toast(t('eventForm.created'));
        router.push(`/events/${event.id}`);
      }
    } catch (e) {
      setError(errorMessage(e));
      setFields(fieldErrors(e));
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="yp-shell__inner"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <div className="yp-topbar">
        <h1>{editing ? t('m.eventForm.editTitle') : t('events.create')}</h1>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="stack">
        <TextField
          label={t('m.eventForm.name')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          required
          maxLength={120}
          error={fields.title}
        />
        <TextField
          label={t('m.eventForm.details')}
          multiline
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          maxLength={5000}
          error={fields.description}
        />
        <TextField
          label={t('m.eventForm.starts')}
          type="datetime-local"
          value={start}
          onChange={(e) => {
            const next = e.currentTarget.value;
            // Keep the end after the start, the same length as before when there was one.
            const was = fromLocalInput(start, tz);
            const nextAt = fromLocalInput(next, tz);
            if (endAt && was && nextAt && endAt > was) setEnd(toLocalInput(new Date(nextAt.getTime() + (endAt.getTime() - was.getTime())).toISOString(), tz));
            setStart(next);
          }}
          required
          error={fields.startsAt}
        />
        <TextField
          label={t('m.eventForm.ends')}
          type="datetime-local"
          value={end}
          min={start || undefined}
          onChange={(e) => setEnd(e.currentTarget.value)}
          error={fields.endsAt ?? (endOk ? undefined : t('m.eventForm.endAfterStart'))}
        />
        <Select
          label={t('m.eventForm.timeZone')}
          value={tz}
          onChange={(e) => setTz(e.currentTarget.value)}
          hint={tz === browserTimeZone() ? undefined : t('eventForm.yourTimeZone', { zone: timeZoneLabel(browserTimeZone()) })}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {timeZoneLabel(z)}
            </option>
          ))}
        </Select>
        <div className="yp-field">
          <span className="yp-field__label" aria-hidden>
            {t('m.eventForm.where')}
          </span>
          <Segments<Where>
            label={t('m.eventForm.where')}
            value={where}
            onChange={setWhere}
            options={[
              { id: 'address', label: t('m.eventForm.address') },
              { id: 'place', label: t('m.eventForm.place') },
              { id: 'online', label: t('m.event.online') },
            ]}
          />
        </div>
        {where === 'address' ? (
          <TextField
            label={t('m.eventForm.addressLabel')}
            placeholder={t('m.eventForm.addressPlaceholder')}
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            maxLength={300}
            error={fields.locationText}
          />
        ) : where === 'online' ? (
          <TextField
            label={t('m.eventForm.link')}
            type="url"
            placeholder="https://"
            value={link}
            onChange={(e) => setLink(e.currentTarget.value)}
            maxLength={300}
            hint={t('m.eventForm.linkHint')}
            error={fields.locationText ?? (linkOk ? undefined : t('m.eventForm.linkInvalid'))}
          />
        ) : (
          <PlacePicker value={place} onChange={setPlace} error={fields.placeId} />
        )}
        <TextField
          label={t('m.eventForm.capacity')}
          type="number"
          inputMode="numeric"
          min={1}
          max={1_000_000}
          step={1}
          placeholder={t('m.eventForm.noLimit')}
          value={capacity}
          onChange={(e) => setCapacity(e.currentTarget.value)}
          hint={t('m.eventForm.capacityHint')}
          error={fields.capacity ?? (capOk ? undefined : t('m.eventForm.capacityInvalid'))}
        />
        <Select label={t('m.eventForm.whoSees')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as Visibility)}>
          <option value="public">{t('m.eventForm.everyone')}</option>
          <option value="followers">{t('m.eventForm.followers')}</option>
          <option value="friends">{t('m.eventForm.friends')}</option>
          <option value="private">{t('m.eventForm.invited')}</option>
        </Select>
        <Checkbox
          label={t('checkin.transfers')}
          description={t('checkin.transfersHelp')}
          checked={transfers}
          onChange={(e) => setTransfers(e.currentTarget.checked)}
        />
        {editing ? (
          loaded?.community ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('m.eventForm.inCommunity', { name: loaded.community.name })}
            </p>
          ) : null
        ) : communities.length || communityId ? (
          <Select
            label={t('m.eventForm.community')}
            hint={t('m.eventForm.communityHint')}
            value={communityId}
            onChange={(e) => setCommunityId(e.currentTarget.value)}
          >
            <option value="">{t('m.eventForm.noCommunity')}</option>
            {communities.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            {communityId && !communities.some((x) => x.id === communityId) ? <option value={communityId}>{t('m.eventForm.thisCommunity')}</option> : null}
          </Select>
        ) : null}
      </div>
      <Button type="submit" size="lg" block loading={busy} disabled={!ready}>
        {editing ? t('common.save') : t('events.create')}
      </Button>
      {editing ? (
        <Button variant="ghost" block onClick={() => router.push(`/events/${editing}`)}>
          {t('common.cancel')}
        </Button>
      ) : null}
    </form>
  );
}

/** Find a place on YAPILAPI by name as you type (search, places only). */
function PlacePicker({ value, onChange, error }: { value: PlaceHit | null; onChange: (p: PlaceHit | null) => void; error?: string }) {
  const { t } = useSession();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const term = q.trim();
  useEffect(() => {
    if (term.length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.search(term, 'places').then(
        (r) => live && setHits(((r.results.places ?? []) as PlaceHit[]).slice(0, 8)),
        () => live && setHits([]),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term]);

  if (value)
    return (
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <strong>{value.name}</strong>
          {value.city ? <span className="muted"> · {value.city}</span> : null}
        </span>
        <Button size="sm" variant="secondary" onClick={() => onChange(null)}>
          {t('m.eventForm.changePlace')}
        </Button>
      </div>
    );
  return (
    <div className="stack-sm">
      <TextField
        label={t('m.eventForm.findPlace')}
        placeholder={t('m.eventForm.findPlaceHint')}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        autoComplete="off"
        error={error}
      />
      <div aria-live="polite">
        {hits === null ? null : hits.length ? (
          <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {hits.map((p) => (
              <li key={p.id}>
                <Button
                  variant="secondary"
                  block
                  onClick={() => {
                    onChange(p);
                    setQ('');
                  }}
                >
                  {p.name}
                  {p.city ? ` · ${p.city}` : ''}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('m.eventForm.noPlaces', { query: term })}
          </p>
        )}
      </div>
    </div>
  );
}
