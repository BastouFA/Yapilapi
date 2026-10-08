import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Platform, Pressable, Text, View } from 'react-native';
import { formatEventWhen, safeTimeZone } from '../../../packages/shared/src/i18n-core';
import {
  directionsUrl,
  eventEndsAt,
  spacedTicketCode,
  ticketIcs,
  ticketIcsName,
  ticketPlaceLine,
  type EventTicket,
} from '../../../packages/shared/src/tickets';
import { client, errorMessage, webUrl } from '../lib/api';
import { FriendPicker, useFriends } from '../lib/friend-picker';
import { useT } from '../lib/i18n';
import { QrView } from '../lib/qr';
import { useRealtime } from '../lib/session';
import { radius, space } from '../lib/theme';
import { BottomSheet, Button, Card, EmptyState, ErrorState, Loading, Notice, Pill, Segmented, useColors, useRefresh, userText } from '../lib/ui';

type When = 'upcoming' | 'past';

/**
 * Your Tickets (from the You tab): tickets for events you said you're going to and ones you bought,
 * each with its QR code and backup code, the time in the event's own time zone, the place, and
 * Add to calendar, Get directions and Give to a friend. Past tickets are on their own tab.
 */
export default function TicketsScreen() {
  const c = useColors();
  const { t } = useT();
  const [when, setWhen] = useState<When>('upcoming');
  const [items, setItems] = useState<EventTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [giving, setGiving] = useState<EventTicket | null>(null);

  const load = useCallback(async (w: When) => {
    setError(null);
    try {
      setItems((await (await client()).tickets.list(w)).items);
    } catch (e) {
      setItems((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    setItems(null);
    void load(when);
  }, [when, load]);
  useRealtime((e) => {
    if (e.type === 'ticket.updated') void load(when);
  });
  const refresh = useRefresh(() => load(when));

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <FlatList
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        data={items ?? []}
        keyExtractor={(x) => x.id}
        refreshControl={refresh}
        ListHeaderComponent={
          <View style={{ gap: space[3] }}>
            <Segmented<When>
              label={t('tickets.which')}
              value={when}
              onChange={setWhen}
              options={[
                { id: 'upcoming', label: t('tickets.upcoming') },
                { id: 'past', label: t('tickets.past') },
              ]}
            />
            {error ? <ErrorState message={error} onRetry={() => load(when)} /> : null}
          </View>
        }
        renderItem={({ item }) => <TicketCard ticket={item} onGive={() => setGiving(item)} />}
        ListEmptyComponent={
          items === null ? (
            <Loading />
          ) : error ? null : when === 'upcoming' ? (
            <EmptyState
              title={t('tickets.empty.title')}
              body={t('tickets.empty.body')}
              action={{ label: t('tickets.findEvents'), icon: 'calendar-outline', onPress: () => router.push('/events') }}
            />
          ) : (
            <EmptyState title={t('tickets.empty.title')} body={t('tickets.empty.past')} />
          )
        }
      />
      <GiveSheet
        ticket={giving}
        onClose={() => setGiving(null)}
        onGiven={() => {
          setGiving(null);
          void load(when);
        }}
      />
    </View>
  );
}

function TicketCard({ ticket, onGive }: { ticket: EventTicket; onGive: () => void }) {
  const c = useColors();
  const { t, locale } = useT();
  const [error, setError] = useState<string | null>(null);
  const e = ticket.event;
  const tz = safeTimeZone(e.timezone);
  let when = '';
  let checkedAt: string | null = null;
  try {
    when = formatEventWhen(e.startsAt, locale, tz);
    if (e.endsAt)
      when = t('m.event.range', { start: when, end: new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(e.endsAt)) });
    if (ticket.checkedInAt)
      checkedAt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(ticket.checkedInAt));
  } catch {
    when = new Date(e.startsAt).toLocaleString();
  }
  const place = e.online ? t('tickets.online') : (ticketPlaceLine(e) ?? t('tickets.tba'));
  const directions = directionsUrl(e, Platform.OS === 'ios' ? 'ios' : 'android');
  const over = eventEndsAt(e).getTime() < Date.now();
  const usable = ticket.status === 'valid' && !e.cancelled;

  async function addToCalendar() {
    setError(null);
    try {
      const file = new File(Paths.cache, ticketIcsName(e.title));
      if (file.exists) file.delete();
      file.create();
      file.write(ticketIcs(ticket, { url: `${webUrl}/events/${encodeURIComponent(e.id)}` }));
      if (!(await Sharing.isAvailableAsync())) throw new Error(t('tickets.addToCalendar'));
      await Sharing.shareAsync(file.uri, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics', dialogTitle: t('tickets.addToCalendar') });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card style={{ gap: space[3], opacity: usable || over ? 1 : 0.92 }}>
      <Pressable accessibilityRole="link" onPress={() => router.push(`/event/${encodeURIComponent(e.id)}`)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 20, fontWeight: '800' }, userText]}>
          {e.title}
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {ticket.status === 'refunded' ? <Pill text={t('tickets.status.refunded')} tone="live" /> : null}
        {ticket.status === 'cancelled' || e.cancelled ? <Pill text={t('tickets.status.cancelled')} tone="live" /> : null}
        {checkedAt ? <Pill text={t('tickets.checkedIn', { time: checkedAt })} /> : null}
      </View>
      {ticket.from ? <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>{t('tickets.from', { name: ticket.from.displayName })}</Text> : null}
      <Fact label={t('tickets.label.when')} value={when} />
      <Fact label={t('tickets.label.where')} value={place} />
      <Fact label={t('tickets.label.type')} value={ticket.type ?? t('tickets.type.rsvp')} />
      <Fact label={t('tickets.label.holder')} value={ticket.holder.displayName} />

      {usable && ticket.token && ticket.code ? (
        <View style={{ alignItems: 'center', gap: space[3], padding: space[4], borderRadius: radius.md, backgroundColor: '#FFFFFF' }}>
          <QrView value={ticket.token} size={232} label={t('tickets.qrLabel', { title: e.title, code: spacedTicketCode(ticket.code) })} />
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Text style={{ color: '#0E1020', fontSize: 12, fontWeight: '700', letterSpacing: 0.5 }}>{t('tickets.code')}</Text>
            <Text
              accessibilityLabel={ticket.code.split('').join(' ')}
              selectable
              style={{ color: '#0E1020', fontSize: 30, fontWeight: '800', letterSpacing: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}
            >
              {spacedTicketCode(ticket.code)}
            </Text>
            <Text style={{ color: '#3D4260', fontSize: 13, textAlign: 'center' }}>{t('tickets.codeHelp')}</Text>
            <Text style={{ color: '#3D4260', fontSize: 13, textAlign: 'center' }}>{t('tickets.brightness')}</Text>
          </View>
        </View>
      ) : e.cancelled ? (
        <Notice>{t('tickets.status.eventCancelled')}</Notice>
      ) : over ? (
        <Text style={{ color: c.inkMuted }}>{t('tickets.status.over')}</Text>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {!e.cancelled && !over ? (
          <Button label={t('tickets.addToCalendar')} icon="calendar-outline" variant="secondary" size="sm" onPress={addToCalendar} />
        ) : null}
        {usable && directions ? (
          <Button label={t('tickets.directions')} icon="navigate-outline" variant="secondary" size="sm" onPress={() => Linking.openURL(directions)} />
        ) : null}
        {ticket.transferable ? <Button label={t('tickets.give')} icon="gift-outline" variant="ghost" size="sm" onPress={onGive} /> : null}
      </View>
      {usable && !ticket.transferable && !ticket.checkedInAt && !over ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('tickets.give.off')}</Text> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const c = useColors();
  return (
    <View accessible style={{ gap: 2 }}>
      <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }}>{label}</Text>
      <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText]}>{value}</Text>
    </View>
  );
}

/** Give a ticket to one friend. */
function GiveSheet({ ticket, onClose, onGiven }: { ticket: EventTicket | null; onClose: () => void; onGiven: () => void }) {
  const { t } = useT();
  const friends = useFriends();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPicked(new Set());
    setError(null);
  }, [ticket?.id]);
  const friend = friends?.find((f) => picked.has(f.id));
  return (
    <BottomSheet visible={!!ticket} title={t('tickets.give.title')} subtitle={t('tickets.give.body')} onClose={onClose}>
      {ticket?.source === 'rsvp' ? <Notice>{t('tickets.give.rsvp')}</Notice> : null}
      <FriendPicker
        friends={friends}
        picked={picked}
        // One friend: picking another replaces the first.
        onChange={(next) => setPicked(new Set([...next].filter((id) => !picked.has(id)).slice(-1)))}
        empty={t('tickets.give.noFriends')}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        label={friend ? t('tickets.give.confirm', { name: friend.displayName }) : t('tickets.give')}
        disabled={!friend}
        onPress={async () => {
          if (!ticket || !friend) return;
          setError(null);
          try {
            await (await client()).tickets.transfer(ticket.id, friend.id);
            onGiven();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}
