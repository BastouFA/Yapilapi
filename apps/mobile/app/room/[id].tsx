import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { ROOM_REACTIONS } from '../../../../packages/shared/src/constants';
import type { RoomParticipant } from '../../../../packages/shared/src/types';
import { useT } from '../../lib/i18n';
import { useReport } from '../../lib/report';
import { everyone, REACTION_ICON, REACTION_LABEL, roomDuration, roomStatusLabel, useRoom } from '../../lib/rooms';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Icon, Loading, Notice, Title, useActionSheet, useColors, userText } from '../../lib/ui';
import { callsSupported } from '../../lib/webrtc';

/**
 * A live audio room: speakers with speaking indicators, listeners, raise hand, reactions and
 * leave quietly; hosts invite, mute, move back and remove. Audio needs a development build.
 */
export default function RoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, dateTime } = useT();
  const { me } = useSession();
  const navigation = useNavigation();
  const room = useRoom(id);
  const [open, setOpen] = useState<string | null>(null);
  const r = room.env?.room;

  // More in the header: report the room (not one you started).
  const menu = useActionSheet();
  const report = useReport();
  const { show: showMenu } = menu;
  const { open: openReport } = report;
  const canReport = !!me && !!r && r.createdBy.id !== me.id;
  useLayoutEffect(() => {
    if (!r) return;
    navigation.setOptions({
      title: r.title,
      headerRight: canReport
        ? () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.post.more')}
              hitSlop={10}
              onPress={() =>
                showMenu({
                  title: r.title,
                  actions: [
                    {
                      label: t('post.report'),
                      icon: 'flag-outline',
                      destructive: true,
                      onPress: () => openReport({ type: 'room', id: r.id, authorId: r.createdBy.id, authorName: r.createdBy.displayName }),
                    },
                  ],
                })
              }
            >
              <Icon name="ellipsis-horizontal-circle-outline" size={24} color={c.yapi} />
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, r, canReport, showMenu, openReport, t, c.yapi]);

  if (room.error && !room.env)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.rooms.title')} body={room.error} />
      </View>
    );
  if (!r || !me) return <Loading />;

  const canHost = room.env!.canHost;
  const mine = room.joined ? everyone(r).find((p) => p.user.id === me.id) : undefined;
  const full = r.listenerCount - r.speakerCount >= r.limits.listeners;

  const header = (
    <Card style={{ gap: space[2] }}>
      <Pressable accessibilityRole="link" onPress={() => router.push(`/c/${r.community.slug}`)}>
        <Text style={{ color: c.inkMuted, fontWeight: '600' }}>{r.community.name}</Text>
      </Pressable>
      <Title sub={`${roomStatusLabel(r, t)} · ${t('m.rooms.startedBy', { name: r.createdBy.displayName })}`}>{r.title}</Title>
      {r.status === 'live' ? <Text style={{ color: c.inkMuted }}>{tp('m.rooms.listening', r.listenerCount)}</Text> : null}
    </Card>
  );

  const hostActions = (p: RoomParticipant) => {
    if (!canHost || p.host || p.user.id === me.id || !room.joined) return [];
    const list: { label: string; danger?: boolean; run: () => void }[] = [];
    if (p.role === 'speaker') {
      if (!p.muted) list.push({ label: t('m.calls.mute'), run: () => void room.act((api) => api.rooms.muteSpeaker(id, p.user.id)) });
      list.push({ label: t('m.rooms.toListeners'), run: () => void room.act((api) => api.rooms.toListener(id, p.user.id)) });
    } else if (!p.invited) list.push({ label: t('m.rooms.invite'), run: () => void room.act((api) => api.rooms.invite(id, p.user.id)) });
    list.push({ label: t('m.rooms.remove'), danger: true, run: () => void room.act((api) => api.rooms.remove(id, p.user.id)) });
    return list;
  };

  const person = (p: RoomParticipant) => {
    const actions = hostActions(p);
    const talking = room.speaking.has(p.user.id) && !p.muted;
    const name = p.user.id === me.id ? t('m.rooms.you', { name: p.user.displayName }) : p.user.displayName;
    const meta = [
      talking ? t('m.rooms.speaking') : p.host ? t('m.rooms.host') : p.role === 'speaker' ? t('m.rooms.speaker') : '',
      p.muted && p.role === 'speaker' ? t('m.rooms.muted') : '',
      p.handRaised ? t('m.rooms.handRaised') : '',
      p.invited ? t('m.rooms.invitedLabel') : '',
    ].filter(Boolean);
    return (
      <View key={p.user.id} style={{ gap: space[2] }}>
        <Pressable
          accessibilityRole={actions.length ? 'button' : undefined}
          accessibilityLabel={actions.length ? t('m.rooms.manage', { name: p.user.displayName }) : undefined}
          accessibilityState={actions.length ? { expanded: open === p.user.id } : undefined}
          disabled={!actions.length}
          onPress={() => setOpen(open === p.user.id ? null : p.user.id)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48 }}
        >
          <View style={{ borderRadius: 30, padding: 3, borderWidth: 3, borderColor: talking ? c.success : 'transparent' }}>
            <Avatar name={p.user.displayName} url={p.user.avatarUrl} size={p.role === 'speaker' ? 52 : 36} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
              {name}
            </Text>
            {meta.length ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{meta.join(' · ')}</Text> : null}
          </View>
          {p.role === 'speaker' && p.muted ? <Icon name="mic-off" size={18} color={c.inkMuted} /> : null}
          {p.handRaised ? <Icon name="hand-left-outline" size={18} color={c.yapi} /> : null}
          {actions.length ? <Icon name={open === p.user.id ? 'chevron-up' : 'ellipsis-horizontal'} size={18} color={c.inkMuted} /> : null}
        </Pressable>
        {open === p.user.id && actions.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], paddingStart: 60 }}>
            {actions.map((a) => (
              <Button
                key={a.label}
                label={a.label}
                size="sm"
                variant={a.danger ? 'danger' : 'secondary'}
                onPress={() => {
                  setOpen(null);
                  a.run();
                }}
              />
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}>
        {header}
        {room.notice ? <Notice>{room.notice}</Notice> : null}

        {r.status === 'ended' || r.status === 'cancelled' ? (
          <Card style={{ gap: space[2], alignItems: 'center' }}>
            <Icon name="volume-mute-outline" size={28} color={c.inkMuted} />
            <Text style={{ color: c.ink, fontWeight: '700', textAlign: 'center' }}>
              {r.status === 'cancelled'
                ? t('m.rooms.cancelled')
                : t('m.rooms.endedLine', { duration: roomDuration(r.durationSeconds, t), count: r.peakListeners })}
            </Text>
            <Text style={{ color: c.inkMuted }}>{t('m.rooms.notRecorded')}</Text>
          </Card>
        ) : r.status === 'scheduled' ? (
          <Card style={{ gap: space[3] }}>
            {r.scheduledFor ? <Text style={{ color: c.ink, fontWeight: '600' }}>{dateTime(r.scheduledFor)}</Text> : null}
            <Button
              label={r.remindMe ? t('m.rooms.reminding') : t('m.rooms.remind')}
              icon="notifications-outline"
              variant={r.remindMe ? 'secondary' : 'primary'}
              onPress={() => room.act((api) => api.rooms.remind(id, !r.remindMe)).then(() => room.reload())}
            />
            {canHost ? (
              <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
                <Button
                  label={t('m.rooms.startNow')}
                  variant="secondary"
                  onPress={async () => {
                    if (await room.act((api) => api.rooms.start(id))) {
                      await room.reload();
                      await room.join();
                    }
                  }}
                />
                <Button label={t('m.rooms.cancel')} variant="ghost" onPress={() => room.act((api) => api.rooms.end(id)).then(() => room.reload())} />
              </View>
            ) : null}
          </Card>
        ) : (
          <>
            {!callsSupported ? <Notice tone="warn">{t('m.rooms.unsupported')}</Notice> : null}
            {room.env!.removed ? <Notice tone="warn">{t('m.rooms.removed')}</Notice> : null}
            {mine?.invited ? (
              <Notice title={t('m.rooms.invited')}>
                <View style={{ flexDirection: 'row', gap: space[2], marginTop: space[2], flexWrap: 'wrap' }}>
                  <Button label={t('m.rooms.accept')} size="sm" icon="mic" onPress={() => room.act((api) => api.rooms.speak(id, true))} />
                  <Button label={t('m.common.notNow')} size="sm" variant="ghost" onPress={() => room.act((api) => api.rooms.speak(id, false))} />
                </View>
              </Notice>
            ) : null}

            <Card style={{ gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
                {`${t('m.rooms.speakers')} · ${r.speakerCount}/${r.limits.speakers}`}
              </Text>
              {r.speakers.map(person)}
            </Card>

            {room.reactions.length ? (
              <View
                style={{ flexDirection: 'row', gap: space[2], justifyContent: 'center' }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {room.reactions.map((x) => (
                  <Icon key={x.id} name={REACTION_ICON[x.kind]} size={26} color={c.yapi} />
                ))}
              </View>
            ) : null}

            {room.joined ? (
              <Card style={{ gap: space[2] }}>
                <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
                  {`${t('m.rooms.listeners')} · ${r.listeners.length}`}
                </Text>
                {r.listeners.length ? r.listeners.map(person) : <Text style={{ color: c.inkMuted }}>{t('m.rooms.nobodyListening')}</Text>}
              </Card>
            ) : null}

            {!room.joined && !room.env!.removed ? (
              full ? (
                <Notice title={t('m.rooms.full')}>{t('m.rooms.fullBody', { speakers: r.limits.speakers, listeners: r.limits.listeners })}</Notice>
              ) : (
                <Button label={t('m.rooms.join')} icon="headset-outline" disabled={room.joining || !callsSupported} onPress={() => room.join()} />
              )
            ) : null}

            {room.joined && mine ? (
              <Card style={{ gap: space[3] }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  {mine.role === 'speaker' ? (
                    <>
                      <Button
                        label={mine.muted ? t('m.calls.unmute') : t('m.calls.mute')}
                        icon={mine.muted ? 'mic-off' : 'mic'}
                        variant={mine.muted ? 'primary' : 'secondary'}
                        onPress={() => room.act((api) => api.rooms.mute(id, !mine.muted))}
                      />
                      <Button label={t('m.rooms.toListeners')} variant="ghost" onPress={() => room.act((api) => api.rooms.toListener(id, me.id))} />
                    </>
                  ) : canHost ? (
                    <Button label={t('m.rooms.speak')} icon="mic" variant="secondary" onPress={() => room.act((api) => api.rooms.speak(id, true))} />
                  ) : (
                    <Button
                      label={mine.handRaised ? t('m.rooms.lowerHand') : t('m.rooms.raiseHand')}
                      icon="hand-left-outline"
                      variant={mine.handRaised ? 'primary' : 'secondary'}
                      onPress={() => room.act((api) => api.rooms.hand(id, !mine.handRaised))}
                    />
                  )}
                </View>
                <View accessibilityRole="toolbar" accessibilityLabel={t('m.rooms.reactions')} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  {ROOM_REACTIONS.map((k) => (
                    <Pressable
                      key={k}
                      accessibilityRole="button"
                      accessibilityLabel={t(REACTION_LABEL[k])}
                      onPress={() => void room.act((api) => api.rooms.react(id, k))}
                      style={({ pressed }) => ({
                        width: 48,
                        height: 48,
                        borderRadius: radius.full,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
                      })}
                    >
                      <Icon name={REACTION_ICON[k]} size={24} color={c.inkMuted} />
                    </Pressable>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  <Button
                    label={t('m.rooms.leave')}
                    icon="exit-outline"
                    variant="ghost"
                    onPress={async () => {
                      await room.leave();
                      router.back();
                    }}
                  />
                  {canHost ? (
                    <Button
                      label={t('m.rooms.end')}
                      variant="danger"
                      onPress={() =>
                        Alert.alert(t('m.rooms.endConfirm'), t('m.rooms.endBody'), [
                          { text: t('m.rooms.keep'), style: 'cancel' },
                          { text: t('m.rooms.end'), style: 'destructive', onPress: () => void room.act((api) => api.rooms.end(id)) },
                        ])
                      }
                    />
                  ) : null}
                </View>
              </Card>
            ) : null}
          </>
        )}
      </ScrollView>
      {menu.sheet}
      {report.sheet}
    </View>
  );
}
