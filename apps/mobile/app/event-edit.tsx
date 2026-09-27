import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import { utcToZonedWall, zonedWallToUtc } from '../../../packages/shared/src/scheduling';
import type { Community, EventItem } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { canOrganize } from '../lib/community-roles';
import { DateField } from '../lib/date-time';
import { ChoiceField, FieldError, isWebLink } from '../lib/forms';
import { useT } from '../lib/i18n';
import { space } from '../lib/theme';
import { deviceTimeZone, TimeZoneField } from '../lib/time-zone';
import { Button, Card, Field, Icon, KeyboardAvoid, Loading, Notice, Row, useColors, userText } from '../lib/ui';

type Where = 'address' | 'place' | 'online';
type Visibility = 'public' | 'followers' | 'friends' | 'private';
type PlaceHit = { id: string; name: string; city?: string | null };

const YEAR_MS = 365 * 86_400_000;

/**
 * Make an event, or change one you host (`?id=`): title, when (on the pure-JS date picker, in the
 * event's time zone), where (an address, a place on YAPILAPI, or online with a link), how many
 * people, who can see it, and for organizers, which community it belongs to (`?community=`).
 */
export default function EventEdit() {
  const params = useLocalSearchParams<{ id?: string; community?: string }>();
  const editing = params.id ?? null;
  const c = useColors();
  const { t } = useT();
  const navigation = useNavigation();
  const [loaded, setLoaded] = useState<EventItem | null | undefined>(editing ? undefined : null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tz, setTz] = useState(deviceTimeZone());
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [where, setWhere] = useState<Where>('address');
  const [address, setAddress] = useState('');
  const [link, setLink] = useState('');
  const [place, setPlace] = useState<PlaceHit | null>(null);
  const [capacity, setCapacity] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [communityId, setCommunityId] = useState<string>(params.community ?? '');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useLayoutEffect(() => {
    navigation.setOptions({ title: editing ? t('m.eventForm.editTitle') : t('events.create') });
  }, [navigation, editing, t]);

  // Changing an event: start from what it says now, in its own time zone.
  useEffect(() => {
    if (!editing) return;
    void client()
      .then((api) => api.events.get(editing))
      .then(
        ({ event }) => {
          const zone = event.timezone || deviceTimeZone();
          setTitle(event.title);
          setDescription(event.description);
          setTz(zone);
          setStart(utcToZonedWall(event.startsAt, zone));
          setEnd(event.endsAt ? utcToZonedWall(event.endsAt, zone) : null);
          if (event.online) {
            setWhere('online');
            setLink(event.locationText ?? '');
          } else if (event.place) {
            setWhere('place');
            setPlace(event.place);
          } else setAddress(event.locationText ?? '');
          setCapacity(event.capacity ? String(event.capacity) : '');
          setVisibility((['public', 'followers', 'friends', 'private'] as const).find((v) => v === event.visibility) ?? 'public');
          setLoaded(event);
        },
        () => setLoaded(null),
      );
  }, [editing]);

  // Communities where you can make events (organizers and up), for a new event.
  useEffect(() => {
    if (editing) return;
    void client()
      .then((api) => api.communities.list('mine'))
      .then(
        (r) => setCommunities(r.items.filter((x) => canOrganize(x.myRole))),
        () => {},
      );
  }, [editing]);

  if (editing && loaded === undefined) return <Loading />;
  if (editing && loaded === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice tone="danger">{t('m.event.notFound')}</Notice>
      </View>
    );

  const cap = capacity.trim() ? Number(capacity.trim()) : null;
  const capOk = cap === null || (Number.isInteger(cap) && cap > 0 && cap <= 1_000_000);
  const linkOk = where !== 'online' || !link.trim() || isWebLink(link);
  const endOk = !end || !start || end > start;
  const ready = !!title.trim() && !!start && capOk && linkOk && endOk && (where !== 'place' || !!place) && !busy;

  async function save() {
    if (!start) return;
    setBusy(true);
    setError(null);
    setFields({});
    const body = {
      title: title.trim(),
      description: description.trim(),
      startsAt: zonedWallToUtc(start, tz).toISOString(),
      endsAt: end ? zonedWallToUtc(end, tz).toISOString() : null,
      timezone: tz,
      online: where === 'online',
      locationText: where === 'online' ? link.trim() || null : where === 'address' ? address.trim() || null : null,
      placeId: where === 'place' ? (place?.id ?? null) : null,
      capacity: cap,
      visibility,
    };
    try {
      const api = await client();
      if (editing) {
        await api.events.update(editing, body);
        router.back();
      } else {
        // A new event leaves out what's empty rather than clearing it.
        const created = Object.fromEntries(Object.entries({ ...body, communityId: communityId || undefined }).filter(([, v]) => v !== null && v !== undefined));
        const { event } = await api.events.create(created);
        router.replace(`/event/${event.id}`);
      }
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.fields) setFields(e.fields);
    } finally {
      setBusy(false);
    }
  }

  const now = new Date();
  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Card style={{ gap: space[3] }}>
          <Field label={t('m.eventForm.name')} value={title} onChangeText={setTitle} maxLength={120} />
          <FieldError text={fields.title} />
          <Field
            label={t('m.eventForm.details')}
            value={description}
            onChangeText={setDescription}
            multiline
            maxLength={5000}
            style={{ minHeight: 110, textAlignVertical: 'top', paddingTop: 12 }}
          />
        </Card>

        <Card style={{ gap: space[3] }}>
          <DateField
            label={t('m.eventForm.starts')}
            value={start}
            onChange={(at) => {
              setStart(at);
              // Keep the end after the start, the same length as before when there was one.
              if (end && start && end > start) setEnd(new Date(at.getTime() + (end.getTime() - start.getTime())));
              else if (end && end <= at) setEnd(null);
            }}
            min={editing ? null : now}
            max={new Date(now.getTime() + 2 * YEAR_MS)}
            quick={!editing}
          />
          <FieldError text={fields.startsAt} />
          <DateField
            label={t('m.eventForm.ends')}
            placeholder={t('m.eventForm.noEnd')}
            value={end}
            onChange={setEnd}
            min={start ? new Date(start.getTime() + 5 * 60_000) : now}
            max={new Date((start ?? now).getTime() + YEAR_MS)}
            disabled={!start}
          />
          {end ? (
            <Button label={t('m.eventForm.removeEnd')} variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onPress={() => setEnd(null)} />
          ) : null}
          <FieldError text={fields.endsAt ?? (endOk ? null : t('m.eventForm.endAfterStart'))} />
          <TimeZoneField label={t('m.eventForm.timeZone')} value={tz} onChange={setTz} />
        </Card>

        <Card style={{ gap: space[3] }}>
          <ChoiceField<Where>
            label={t('m.eventForm.where')}
            value={where}
            onChange={setWhere}
            options={[
              { id: 'address', label: t('m.eventForm.address'), icon: 'location-outline' },
              { id: 'place', label: t('m.eventForm.place'), icon: 'storefront-outline' },
              { id: 'online', label: t('m.event.online'), icon: 'videocam-outline' },
            ]}
          />
          {where === 'address' ? (
            <Field
              label={t('m.eventForm.addressLabel')}
              placeholder={t('m.eventForm.addressPlaceholder')}
              value={address}
              onChangeText={setAddress}
              maxLength={300}
            />
          ) : where === 'online' ? (
            <View style={{ gap: space[1] }}>
              <Field
                label={t('m.eventForm.link')}
                placeholder="https://"
                value={link}
                onChangeText={setLink}
                maxLength={300}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.eventForm.linkHint')}</Text>
              <FieldError text={linkOk ? null : t('m.eventForm.linkInvalid')} />
            </View>
          ) : (
            <PlacePicker value={place} onChange={setPlace} />
          )}
          <FieldError text={fields.locationText ?? fields.placeId} />
        </Card>

        <Card style={{ gap: space[3] }}>
          <Field
            label={t('m.eventForm.capacity')}
            placeholder={t('m.eventForm.noLimit')}
            value={capacity}
            onChangeText={(v) => setCapacity(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            maxLength={7}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.eventForm.capacityHint')}</Text>
          <FieldError text={fields.capacity ?? (capOk ? null : t('m.eventForm.capacityInvalid'))} />
          <ChoiceField<Visibility>
            label={t('m.eventForm.whoSees')}
            value={visibility}
            onChange={setVisibility}
            options={[
              { id: 'public', label: t('m.eventForm.everyone') },
              { id: 'followers', label: t('m.eventForm.followers') },
              { id: 'friends', label: t('m.eventForm.friends') },
              { id: 'private', label: t('m.eventForm.invited') },
            ]}
          />
        </Card>

        {editing ? (
          loaded?.community ? (
            <Notice>{t('m.eventForm.inCommunity', { name: loaded.community.name })}</Notice>
          ) : null
        ) : communities.length || communityId ? (
          <Card style={{ gap: space[3] }}>
            <ChoiceField<string>
              label={t('m.eventForm.community')}
              hint={t('m.eventForm.communityHint')}
              value={communityId}
              onChange={setCommunityId}
              options={[
                { id: '', label: t('m.eventForm.noCommunity') },
                ...communities.map((x) => ({ id: x.id, label: x.name })),
                ...(communityId && !communities.some((x) => x.id === communityId) ? [{ id: communityId, label: t('m.eventForm.thisCommunity') }] : []),
              ]}
            />
          </Card>
        ) : null}

        <Button
          label={busy ? t('m.common.saving') : editing ? t('common.save') : t('events.create')}
          icon={editing ? undefined : 'calendar-outline'}
          disabled={!ready}
          onPress={() => save()}
        />
      </ScrollView>
    </KeyboardAvoid>
  );
}

/** Find a place on YAPILAPI by name as you type (Wander's search, places only). */
function PlacePicker({ value, onChange }: { value: PlaceHit | null; onChange: (p: PlaceHit | null) => void }) {
  const c = useColors();
  const { t } = useT();
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
      void client()
        .then((api) => api.search(term, 'places'))
        .then(
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
      <View style={{ gap: space[2] }}>
        <Row
          title={value.name}
          subtitle={value.city ?? undefined}
          start={<Icon name="storefront-outline" size={22} color={c.yapi} />}
          end={<Button label={t('m.eventForm.changePlace')} size="sm" variant="secondary" onPress={() => onChange(null)} />}
        />
      </View>
    );
  return (
    <View style={{ gap: space[2] }}>
      <Field label={t('m.eventForm.findPlace')} placeholder={t('m.eventForm.findPlaceHint')} value={q} onChangeText={setQ} autoCorrect={false} />
      {hits === null ? null : hits.length ? (
        <View accessibilityLiveRegion="polite" style={{ gap: space[2] }}>
          {hits.map((p) => (
            <Row
              key={p.id}
              title={p.name}
              subtitle={p.city ?? undefined}
              start={<Icon name="storefront-outline" size={22} color={c.yapi} />}
              onPress={() => {
                onChange(p);
                setQ('');
              }}
            />
          ))}
        </View>
      ) : (
        <Text accessibilityLiveRegion="polite" style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
          {t('m.eventForm.noPlaces', { query: term })}
        </Text>
      )}
    </View>
  );
}
