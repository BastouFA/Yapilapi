import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Linking, Platform, Pressable, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { formatEventWhen, safeTimeZone } from '../../../../packages/shared/src/i18n';
import { timeZoneLabel } from '../../../../packages/shared/src/scheduling';
import type { EventItem, PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage, webUrl } from '../../lib/api';
import { isWebLink } from '../../lib/forms';
import { useT } from '../../lib/i18n';
import { useReport } from '../../lib/report';
import { RichText } from '../../lib/post';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { deviceTimeZone } from '../../lib/time-zone';
import { Avatar, Button, Card, EmptyState, Icon, Loading, Notice, Segmented, useActionSheet, useColors, userText } from '../../lib/ui';

type Rsvp = 'going' | 'interested' | 'not_going';

/**
 * An event: when and where, who hosts it, your answer (going, interested, can't go), who is
 * going, and sharing it. Opened from Wander, Events, a community and notifications.
 */
export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, locale } = useT();
  const { me } = useSession();
  const [event, setEvent] = useState<EventItem | null | undefined>(undefined);
  const [going, setGoing] = useState<PublicUser[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // More in the header: report someone else's event.
  const menu = useActionSheet();
  const report = useReport();

  const load = useCallback(async () => {
    try {
      const api = await client();
      setEvent((await api.events.get(id)).event);
      api.events.attendees(id).then(
        (r) => setGoing(r.items.filter((a) => a.status === 'going').map((a) => a.user)),
        () => {},
      );
    } catch {
      setEvent(null);
    }
  }, [id]);

  // Again on coming back, so changes made on the edit screen show.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (event === undefined) return <Loading />;
  if (event === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.event.notFound')} body={t('m.event.notFoundBody')} />
      </View>
    );

  let when = '';
  let until = '';
  try {
    const tz = safeTimeZone(event.timezone);
    when = formatEventWhen(event.startsAt, locale, tz);
    until = event.endsAt ? new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(event.endsAt)) : '';
  } catch {
    when = new Date(event.startsAt).toLocaleString();
  }
  const hosting = event.host.id === me?.id;
  const full = !!event.capacity && event.counts.going >= event.capacity;
  const where = event.online ? t('m.event.online') : (event.place?.name ?? event.locationText ?? t('m.event.tba'));
  const joinLink = event.online && event.locationText && isWebLink(event.locationText) ? event.locationText.trim() : null;
  const otherZone = event.timezone && event.timezone !== deviceTimeZone() ? event.timezone : null;

  function cancelEvent() {
    Alert.alert(t('m.event.cancelTitle'), t('m.event.cancelBody'), [
      { text: t('m.common.notNow'), style: 'cancel' },
      {
        text: t('m.event.cancel'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError(null);
          try {
            await (await client()).events.cancel(id);
            router.back();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  async function rsvp(status: Rsvp) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await (await client()).events.rsvp(id, status);
      setEvent(r.event);
      setNote(r.status === 'waitlist' ? t('m.event.waitlist') : t('m.event.saved'));
      void load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!event) return;
    const url = `${webUrl}/events/${encodeURIComponent(event.id)}`;
    try {
      await Share.share(Platform.OS === 'ios' ? { url, message: event.title } : { message: `${event.title}\n${url}`, title: event.title });
    } catch {
      // The person closed the share sheet.
    }
  }

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen
        options={{
          headerRight:
            me && !hosting
              ? () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('m.post.more')}
                    hitSlop={10}
                    onPress={() =>
                      menu.show({
                        title: event.title,
                        actions: [
                          {
                            label: t('post.report'),
                            icon: 'flag-outline',
                            destructive: true,
                            onPress: () => report.open({ type: 'event', id: event.id, authorId: event.host.id, authorName: event.host.displayName }),
                          },
                        ],
                      })
                    }
                  >
                    <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      {menu.sheet}
      {report.sheet}
      <Card style={{ gap: space[3] }}>
        {event.community ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => router.push(`/c/${event.community!.slug}`)}
            hitSlop={8}
            style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}
          >
            <Text style={[{ color: c.yapi, fontWeight: '700' }, userText]}>{event.community.name}</Text>
          </Pressable>
        ) : null}
        <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }, userText]}>
          {event.title}
        </Text>
        <Line icon="calendar-outline" text={until ? t('m.event.range', { start: when, end: until }) : when} />
        {otherZone ? (
          <Text style={{ color: c.inkMuted, fontSize: 13, marginTop: -space[2], marginStart: 36 }}>
            {t('m.event.inZone', { zone: timeZoneLabel(otherZone) })}
          </Text>
        ) : null}
        {event.place && !event.online ? (
          <Pressable accessibilityRole="link" onPress={() => router.push(`/place/${event.place!.id}`)} style={{ minHeight: 32, justifyContent: 'center' }}>
            <Line icon="location-outline" text={where} link />
          </Pressable>
        ) : joinLink ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t('m.event.joinOnline')}
            accessibilityHint={joinLink}
            onPress={() => void Linking.openURL(joinLink)}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Line icon="videocam-outline" text={t('m.event.joinOnline')} link />
          </Pressable>
        ) : (
          <Line icon={event.online ? 'videocam-outline' : 'location-outline'} text={where} />
        )}
        <Line
          icon="people-outline"
          text={[
            event.capacity ? t('m.event.spots', { going: event.counts.going, capacity: event.capacity }) : tp('m.event.going', event.counts.going),
            tp('m.event.interested', event.counts.interested),
          ].join(' · ')}
        />
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('m.event.hostedBy', { name: event.host.displayName })}
          onPress={() => router.push(`/u/${encodeURIComponent(event.host.username)}`)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
        >
          <Avatar name={event.host.displayName} url={event.host.avatarUrl} size={32} />
          <Text style={[{ color: c.ink, fontSize: 14 }, userText]}>{t('m.event.hostedBy', { name: event.host.displayName })}</Text>
        </Pressable>
      </Card>

      {hosting ? (
        <View style={{ gap: space[2] }}>
          <Notice>{t('m.event.hosting')}</Notice>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              label={t('m.event.edit')}
              icon="create-outline"
              variant="secondary"
              size="sm"
              onPress={() => router.push(`/event-edit?id=${encodeURIComponent(event.id)}`)}
            />
            <Button label={t('m.event.cancel')} variant="ghost" size="sm" disabled={busy} onPress={cancelEvent} />
          </View>
        </View>
      ) : (
        <View style={{ gap: space[2] }}>
          <Segmented<Rsvp | 'none'>
            label={t('m.event.yourAnswer')}
            value={event.myRsvp ?? 'none'}
            onChange={(v) => v !== 'none' && !busy && void rsvp(v)}
            options={[
              { id: 'going', label: t('events.going') },
              { id: 'interested', label: t('events.interested') },
              { id: 'not_going', label: t('events.notGoing') },
            ]}
          />
          {full && event.myRsvp !== 'going' ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.event.full')}</Text> : null}
        </View>
      )}
      {event.canCheckIn || (event.myRsvp === 'going' && !hosting) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {event.canCheckIn ? (
            <Button label={t('checkin.open')} icon="scan-outline" onPress={() => router.push(`/check-in/${encodeURIComponent(event.id)}`)} />
          ) : null}
          {event.myRsvp === 'going' && !hosting ? (
            <Button label={t('tickets.yourTicket')} icon="ticket-outline" variant="secondary" onPress={() => router.push('/tickets')} />
          ) : null}
        </View>
      ) : null}
      {note ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
          {note}
        </Text>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {event.description ? (
        <Card>
          <RichText text={event.description} style={{ color: c.ink, fontSize: 15, lineHeight: 22 }} />
        </Card>
      ) : null}

      {going.length ? (
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('events.going')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {going.slice(0, 12).map((u) => (
              <Pressable
                key={u.id}
                accessibilityRole="link"
                accessibilityLabel={u.displayName}
                onPress={() => router.push(`/u/${encodeURIComponent(u.username)}`)}
                style={{ alignItems: 'center', width: 64, gap: 4 }}
              >
                <Avatar name={u.displayName} url={u.avatarUrl} size={44} />
                <Text style={[{ color: c.ink, fontSize: 12 }, userText]} numberOfLines={1}>
                  {u.displayName.split(' ')[0]}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <Button label={t('m.common.share')} variant="secondary" icon="share-outline" onPress={() => share()} />
    </ScrollView>
  );
}

function Line({ icon, text, link }: { icon: 'calendar-outline' | 'location-outline' | 'people-outline' | 'videocam-outline'; text: string; link?: boolean }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
      <View style={{ width: 28, height: 28, borderRadius: radius.sm, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={16} color={c.yapi} />
      </View>
      <Text style={[{ color: link ? c.yapi : c.ink, fontSize: 15, flex: 1, fontWeight: link ? '600' : '400' }, userText]}>{text}</Text>
    </View>
  );
}
