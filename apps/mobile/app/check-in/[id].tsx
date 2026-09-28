import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, FlatList, Text, View } from 'react-native';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import { formatEventWhen, safeTimeZone } from '../../../../packages/shared/src/i18n';
import {
  readTicketInput,
  type CheckInCounts,
  type CheckInResult,
  type CheckInResultKind,
  type DoorSummary,
  type TicketGuest,
} from '../../../../packages/shared/src/tickets';
import { client, errorMessage } from '../../lib/api';
import { FriendPicker, useFriends } from '../../lib/friend-picker';
import { useT } from '../../lib/i18n';
import { useRealtime, useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, BottomSheet, Button, Card, EmptyState, Field, Icon, Loading, Notice, Segmented, SwitchRow, useColors, userText } from '../../lib/ui';

type Filter = 'all' | 'in' | 'waiting';

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

const newRef = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Check-in at the door, for an event's host and co-hosts: live counts, scanning QR codes with the
 * camera, typing a backup code, and a searchable guest list with Check in and Undo. Results are
 * read out by screen readers; everything works without the camera.
 */
export default function CheckInScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const [door, setDoor] = useState<DoorSummary | null | undefined>(undefined);
  const [counts, setCounts] = useState<CheckInCounts | null>(null);
  const [last, setLast] = useState<CheckInResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [guests, setGuests] = useState<TicketGuest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState(false);
  const seen = useRef<{ value: string; at: number } | null>(null);
  const sending = useRef(false);

  const tz = door ? safeTimeZone(door.event.timezone) : 'UTC';
  const time = useCallback((iso: string) => new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(iso)), [locale, tz]);

  useEffect(() => {
    client()
      .then((api) => api.events.door(id))
      .then(
        (d) => {
          setDoor(d);
          setCounts(d.counts);
        },
        () => setDoor(null),
      );
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(
      () =>
        client()
          .then((api) => api.events.guests(id, { q: q.trim() || undefined, filter }))
          .then(
            (r) => {
              setGuests(r.items);
              setTotal(r.total);
              setNext(r.nextOffset);
            },
            () => setGuests((cur) => cur ?? []),
          ),
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [id, q, filter, version]);

  useRealtime((e) => {
    if (e.type !== 'checkin.updated' || e.data?.eventId !== id) return;
    setCounts(e.data.counts);
    setVersion((v) => v + 1);
  });

  const say = useCallback((text: string) => AccessibilityInfo.announceForAccessibility(text), []);

  const describe = useCallback(
    (r: CheckInResult) => {
      const g = r.guest;
      const parts = [t(TITLE[r.result])];
      if (g && r.result !== 'wrong_event' && r.result !== 'invalid') parts.push(`${g.name}, ${g.type ?? t('tickets.type.rsvp')}`);
      if (r.result === 'already' && g?.checkedInAt) parts.push(t('checkin.detail.already', { time: time(g.checkedInAt), name: g.checkedInBy?.name ?? '' }));
      else if (DETAIL[r.result]) parts.push(t(DETAIL[r.result]!));
      return parts.join('. ');
    },
    [t, time],
  );

  const submit = useCallback(
    async (input: { token?: string; code?: string; ticketId?: string }) => {
      if (sending.current) return;
      sending.current = true;
      try {
        const r = await (await client()).events.checkIn(id, { ...input, clientRef: newRef() });
        setCounts(r.counts);
        setLast(r);
        setNote(null);
        setVersion((v) => v + 1);
        say(describe(r));
      } catch (e) {
        setLast(null);
        setNote(errorMessage(e));
        say(errorMessage(e));
      } finally {
        sending.current = false;
      }
    },
    [id, describe, say],
  );

  const undo = useCallback(
    async (g: TicketGuest) => {
      try {
        const r = await (await client()).events.undoCheckIn(id, g.ticketId);
        setCounts(r.counts);
        setLast(null);
        setNote(t('checkin.undone', { name: g.name }));
        say(t('checkin.undone', { name: g.name }));
        setVersion((v) => v + 1);
      } catch (e) {
        setNote(errorMessage(e));
      }
    },
    [id, t, say],
  );

  if (door === undefined || (door && !counts)) return <Loading />;
  if (door === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('checkin.title')} body={t('checkin.detail.invalid')} />
      </View>
    );

  const tone = last ? (last.result === 'valid' ? c.success : last.result === 'already' ? c.saffron : c.danger) : c.line;
  const header = (
    <View style={{ gap: space[4], marginBottom: space[3] }}>
      <Card style={{ gap: space[2] }}>
        <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{door.role === 'host' ? t('checkin.role.host') : t('checkin.role.cohost')}</Text>
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 22, fontWeight: '800' }, userText]}>
          {door.event.title}
        </Text>
        <Text style={{ color: c.inkMuted }}>{formatEventWhen(door.event.startsAt, locale, tz)}</Text>
        <Text style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>
          {t('checkin.counts', { checkedIn: counts!.checkedIn, expected: counts!.expected })}
        </Text>
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: counts!.expected, now: counts!.checkedIn }}
          style={{ height: 10, borderRadius: 5, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
        >
          <View
            style={{ height: 10, width: `${counts!.expected ? Math.round((counts!.checkedIn / counts!.expected) * 100) : 0}%`, backgroundColor: c.success }}
          />
        </View>
      </Card>

      {last || note ? (
        <View
          accessibilityLiveRegion="assertive"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[3],
            padding: space[4],
            borderRadius: radius.lg,
            borderWidth: 2,
            borderColor: tone,
            backgroundColor: c.surface,
          }}
        >
          {last ? (
            <Icon name={last.result === 'valid' ? 'checkmark-circle' : last.result === 'already' ? 'alert-circle' : 'close-circle'} size={30} color={tone} />
          ) : null}
          <View style={{ flex: 1, gap: 2 }}>
            {last ? (
              <>
                <Text style={{ color: c.ink, fontSize: 20, fontWeight: '800' }}>{t(TITLE[last.result])}</Text>
                {last.guest && last.result !== 'wrong_event' && last.result !== 'invalid' ? (
                  <Text style={[{ color: c.ink, fontSize: 15, fontWeight: '600' }, userText]}>
                    {last.guest.name} · {last.guest.type ?? t('tickets.type.rsvp')}
                    {last.guest.limited ? ` · ${t('checkin.limited')}` : ''}
                  </Text>
                ) : null}
                {last.result === 'already' && last.guest?.checkedInAt ? (
                  <Text style={{ color: c.ink }}>
                    {t('checkin.detail.already', { time: time(last.guest.checkedInAt), name: last.guest.checkedInBy?.name ?? '' })}
                  </Text>
                ) : DETAIL[last.result] ? (
                  <Text style={{ color: c.ink }}>{t(DETAIL[last.result]!)}</Text>
                ) : null}
              </>
            ) : (
              <Text style={{ color: c.ink }}>{note}</Text>
            )}
          </View>
          {last?.result === 'valid' && last.guest ? <Button label={t('checkin.undo')} size="sm" variant="secondary" onPress={() => undo(last.guest!)} /> : null}
        </View>
      ) : null}

      <View style={{ gap: space[2] }}>
        {!permission ? null : !permission.granted && !permission.canAskAgain ? (
          <Notice>{t('checkin.cameraDenied')}</Notice>
        ) : (
          <Button
            label={scanning ? t('checkin.scanStop') : t('checkin.scan')}
            icon="scan-outline"
            variant={scanning ? 'secondary' : 'primary'}
            onPress={async () => {
              if (!scanning && !permission.granted) {
                const p = await requestPermission();
                if (!p.granted) return;
              }
              setScanning((v) => !v);
            }}
          />
        )}
        {scanning ? (
          <View style={{ gap: space[2] }}>
            <CameraView
              style={{ height: 300, borderRadius: radius.md, overflow: 'hidden' }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                const read = readTicketInput(data);
                if (read?.kind !== 'token') return;
                // The same code in front of the camera counts once every few seconds.
                const now = Date.now();
                if (seen.current && seen.current.value === read.token && now - seen.current.at < 4000) return;
                seen.current = { value: read.token, at: now };
                void submit({ token: read.token });
              }}
              accessibilityLabel={t('checkin.scanHint')}
            />
            <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('checkin.scanHint')}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ gap: space[2] }}>
        <Field
          label={t('checkin.code')}
          hint={t('checkin.codeHint')}
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={10}
          returnKeyType="go"
          onSubmitEditing={() => code.trim() && void submit({ code: code.trim() }).then(() => setCode(''))}
        />
        <Button label={t('checkin.submit')} disabled={!code.trim()} onPress={() => submit({ code: code.trim() }).then(() => setCode(''))} />
      </View>

      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
        {t('checkin.guests')} ({total})
      </Text>
      <Field label={t('checkin.search')} value={q} onChangeText={setQ} autoCorrect={false} autoCapitalize="none" />
      <Segmented<Filter>
        label={t('checkin.filter')}
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: t('checkin.filter.all') },
          { id: 'waiting', label: t('checkin.filter.waiting') },
          { id: 'in', label: t('checkin.filter.in') },
        ]}
      />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <FlatList
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space[4], paddingBottom: space[8] }}
        data={guests ?? []}
        keyExtractor={(g) => g.ticketId}
        ListHeaderComponent={header}
        renderItem={({ item: g }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 60, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <Avatar name={g.name} url={g.avatarUrl} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
                {g.name}
              </Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                {[
                  g.type ?? t('tickets.type.rsvp'),
                  g.username ? `@${g.username}` : null,
                  g.limited ? t('checkin.limited') : null,
                  g.checkedInAt ? t('checkin.inAt', { time: time(g.checkedInAt) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            {g.checkedInAt ? (
              <Button label={t('checkin.undo')} size="sm" variant="ghost" onPress={() => undo(g)} />
            ) : (
              <Button label={t('checkin.checkIn')} size="sm" onPress={() => submit({ ticketId: g.ticketId })} />
            )}
          </View>
        )}
        ListEmptyComponent={
          guests === null ? <Loading /> : <Text style={{ color: c.inkMuted }}>{q || filter !== 'all' ? t('checkin.noMatch') : t('checkin.noGuests')}</Text>
        }
        ListFooterComponent={
          <View style={{ gap: space[3], marginTop: space[4] }}>
            {next !== null ? (
              <Button
                label={t('checkin.more')}
                variant="secondary"
                onPress={async () => {
                  const r = await (await client()).events.guests(id, { q: q.trim() || undefined, filter, offset: next });
                  setGuests((cur) => [...(cur ?? []), ...r.items]);
                  setNext(r.nextOffset);
                }}
              />
            ) : null}
            {door.role === 'host' ? (
              <Button label={t('checkin.cohosts')} icon="people-outline" variant="secondary" onPress={() => setSettings(true)} />
            ) : (
              <Button
                label={t('checkin.leave')}
                variant="ghost"
                onPress={async () => {
                  try {
                    await (await client()).events.removeCohost(id, me?.id ?? '');
                    router.back();
                  } catch (e) {
                    setNote(errorMessage(e));
                  }
                }}
              />
            )}
          </View>
        }
      />
      {door.role === 'host' ? <HostSettings door={door} visible={settings} onClose={() => setSettings(false)} onChange={setDoor} /> : null}
    </View>
  );
}

/** The host's settings: co-hosts (from friends) and whether guests may give tickets to friends. */
function HostSettings({ door, visible, onClose, onChange }: { door: DoorSummary; visible: boolean; onClose: () => void; onChange: (d: DoorSummary) => void }) {
  const c = useColors();
  const { t } = useT();
  const friends = useFriends();
  const [error, setError] = useState<string | null>(null);
  const id = door.event.id;
  const picked = new Set(door.cohosts.map((x) => x.id));
  return (
    <BottomSheet visible={visible} title={t('checkin.cohosts')} subtitle={t('checkin.cohostsHelp')} onClose={onClose}>
      <FriendPicker
        friends={friends}
        picked={picked}
        empty={t('tickets.give.noFriends')}
        onChange={async (next) => {
          setError(null);
          try {
            const api = await client();
            const added = [...next].find((x) => !picked.has(x));
            const removed = [...picked].find((x) => !next.has(x));
            if (added) {
              await api.events.addCohost(id, added);
              const person = friends?.find((f) => f.id === added);
              if (person) onChange({ ...door, cohosts: [...door.cohosts, person] });
            } else if (removed) {
              await api.events.removeCohost(id, removed);
              onChange({ ...door, cohosts: door.cohosts.filter((x) => x.id !== removed) });
            }
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <SwitchRow
        label={t('checkin.transfers')}
        hint={t('checkin.transfersHelp')}
        value={door.ticketTransfers}
        onValueChange={async (v) => {
          setError(null);
          try {
            await (await client()).events.update(id, { ticketTransfers: v });
            onChange({ ...door, ticketTransfers: v });
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('checkin.transfersHelp')}</Text>
    </BottomSheet>
  );
}
