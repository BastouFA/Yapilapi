'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Badge, Button, Dialog, EmptyState, Icon, Menu, Skeleton, TextField, type MenuAction } from '@yapilapi/design-system';
import { ROOM_MAX_LISTENERS, ROOM_MAX_SPEAKERS, ROOM_REACTIONS, ROOM_TITLE_MAX, type RoomParticipant, type RoomSummary } from '@yapilapi/shared';
import type { RoomEnvelope } from '@yapilapi/api-client';
import { api, errorMessage, isGone } from '@/lib/api';
import { localInput } from '@/lib/schedule';
import { useRealtime, useSession } from '@/app/providers';
import { everyone, nameList, REACTION_LABEL, useRooms, type T, type TP } from './Rooms';

// ── Formatting ──────────────────────────────────────────────────────────
export function roomDuration(seconds: number | null, t: T): string {
  if (seconds === null) return '';
  if (seconds < 60) return t('m.rooms.underMinute');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? t('m.rooms.hours', { hours: h, minutes: m }) : t('m.rooms.minutes', { count: m });
}

function when(iso: string, locale: string) {
  return new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function endedLine(r: RoomSummary, t: T, tp: TP) {
  if (r.status === 'cancelled') return t('m.rooms.cancelled');
  return tp('rooms.endedLine', r.peakListeners, { duration: roomDuration(r.durationSeconds, t) });
}

// ── The room screen ─────────────────────────────────────────────────────
export function RoomView({ id }: { id: string }) {
  const rooms = useRooms();
  const { me, locale, t, tp } = useSession();
  const router = useRouter();
  const [env, setEnv] = useState<RoomEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether that error means the room is gone or not open to you, rather than that it couldn't load right now.
  const [gone, setGone] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Joining swaps the Join button for the room controls: focus goes to the room's title, not nowhere.
  const title = useRef<HTMLHeadingElement>(null);
  const wasJoined = useRef(false);
  const isJoined = rooms.room?.id === id;
  useEffect(() => {
    if (isJoined && !wasJoined.current && (!document.activeElement || document.activeElement === document.body)) title.current?.focus();
    wasJoined.current = isJoined;
  }, [isJoined]);

  const load = useCallback(
    () =>
      api.rooms.get(id).then(
        (r) => (setEnv(r), setError(null)),
        (e) => (setError(errorMessage(e)), setGone(isGone(e))),
      ),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if (e.type === 'room.state' && e.data?.id === id) setEnv((v) => (v ? { ...v, room: e.data } : v));
    if (e.type === 'room.removed' && e.data?.roomId === id) setEnv((v) => (v ? { ...v, removed: true } : v));
  });

  if (error && !env && gone) return <EmptyState title={t('rooms.notOpen')} body={error} />;
  if (error && !env) return <EmptyState title={error} action={<Button onClick={() => void load()}>{t('m.common.retry')}</Button>} />;
  if (!env || !me) return <Skeleton height={240} />;

  const joined = rooms.room?.id === id;
  const room = joined ? rooms.room! : env.room;
  const canHost = joined ? rooms.canHost : env.canHost;
  const mine = joined ? everyone(room).find((p) => p.user.id === me.id) : undefined;
  const full = room.listenerCount - room.speakerCount >= room.limits.listeners;

  const header = (
    <div className="stack-sm">
      <Link href={`/c/${room.community.slug}`} className="muted">
        {room.community.name}
      </Link>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h1 ref={title} tabIndex={-1} className="profile__name" style={{ margin: 0 }}>
          {room.title}
        </h1>
        {room.status === 'live' ? (
          <Badge tone="danger">{t('m.rooms.live')}</Badge>
        ) : room.status === 'scheduled' ? (
          <Badge tone="warning">{t('m.rooms.scheduled')}</Badge>
        ) : (
          <Badge tone="neutral">{room.status === 'cancelled' ? t('m.rooms.cancelled') : t('m.rooms.ended')}</Badge>
        )}
      </div>
      <span className="muted">
        {room.status === 'scheduled' ? t('rooms.hostedBy', { name: room.createdBy.displayName }) : t('m.rooms.startedBy', { name: room.createdBy.displayName })}
        {room.status === 'live' ? ` · ${tp('m.rooms.listening', room.listenerCount)}` : ''}
      </span>
    </div>
  );

  if (room.status === 'ended' || room.status === 'cancelled')
    return (
      <div className="yp-shell__inner">
        {header}
        <div className="room-ended">
          <Icon name="volume-off" size={28} />
          <p>{endedLine(room, t, tp)}</p>
          <p className="muted">{t('m.rooms.notRecorded')}</p>
        </div>
      </div>
    );

  if (room.status === 'scheduled')
    return (
      <div className="yp-shell__inner">
        {header}
        <ScheduledRoom
          room={room}
          canHost={canHost}
          locale={locale}
          onChange={(r) => setEnv({ ...env, room: { ...env.room, ...r } })}
          onStarted={async () => {
            await load();
            await rooms.join(id);
          }}
        />
      </div>
    );

  if (!joined)
    return (
      <div className="yp-shell__inner">
        {header}
        {env.removed ? <Alert tone="warning">{t('m.rooms.removed')}</Alert> : null}
        {room.speakers.length ? (
          <div className="room-stage" role="group" aria-label={t('m.rooms.speakers')}>
            {room.speakers.map((p) => (
              <SpeakerTile key={p.user.id} p={p} speaking={false} />
            ))}
          </div>
        ) : null}
        {!env.removed ? (
          full ? (
            <Alert tone="info" title={t('m.rooms.full')}>
              {t('m.rooms.fullBody', { speakers: room.limits.speakers, listeners: room.limits.listeners })}
            </Alert>
          ) : (
            <div className="row">
              <Button icon="volume" loading={rooms.joining === id} onClick={() => void rooms.join(id)}>
                {everyone(room).some((p) => p.user.id === me.id) ? t('rooms.rejoin') : t('m.rooms.join')}
              </Button>
            </div>
          )
        ) : null}
      </div>
    );

  const hostActions = (p: RoomParticipant): MenuAction[] => {
    if (!canHost || p.host || p.user.id === me.id) return [];
    const list: MenuAction[] = [];
    if (p.role === 'speaker') {
      if (!p.muted) list.push({ label: t('m.calls.mute'), icon: 'mic-off', onSelect: () => void rooms.act((rid) => api.rooms.muteSpeaker(rid, p.user.id)) });
      list.push({ label: t('m.rooms.toListeners'), icon: 'users', onSelect: () => void rooms.act((rid) => api.rooms.toListener(rid, p.user.id)) });
    } else if (!p.invited) list.push({ label: t('m.rooms.invite'), icon: 'mic', onSelect: () => void rooms.act((rid) => api.rooms.invite(rid, p.user.id)) });
    list.push({ label: t('m.rooms.remove'), icon: 'x-circle', danger: true, onSelect: () => void rooms.act((rid) => api.rooms.remove(rid, p.user.id)) });
    return list;
  };

  const hands = room.listeners.filter((p) => p.handRaised);
  return (
    <div className="yp-shell__inner room">
      {header}
      {mine?.invited ? (
        <Alert tone="info" title={t('m.rooms.invited')}>
          <div className="row" style={{ marginTop: 'var(--space-2)' }}>
            <Button size="sm" icon="mic" onClick={() => void rooms.act((rid) => api.rooms.speak(rid, true))}>
              {t('m.rooms.accept')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void rooms.act((rid) => api.rooms.speak(rid, false))}>
              {t('m.common.notNow')}
            </Button>
          </div>
        </Alert>
      ) : null}

      <section aria-labelledby="room-speakers">
        <h2 id="room-speakers" className="room__heading">
          {t('m.rooms.speakers')} <span className="muted">{t('rooms.seats', { count: room.speakerCount, max: room.limits.speakers })}</span>
        </h2>
        {!room.speakers.length ? <p className="muted">{t('rooms.nobodyOnStage')}</p> : null}
        <div className="room-stage">
          {room.speakers.map((p) => (
            <SpeakerTile key={p.user.id} p={p} speaking={rooms.speaking.has(p.user.id) && !p.muted} actions={hostActions(p)} you={p.user.id === me.id} />
          ))}
        </div>
      </section>

      <div className="room-reactions" aria-hidden>
        {rooms.reactions.map((r) => (
          <span key={r.id} className="room-reactions__float" style={{ insetInlineStart: `${10 + ((r.id * 37) % 70)}%` }}>
            <Icon name={r.kind} size={26} filled={r.kind === 'heart' || r.kind === 'star'} />
          </span>
        ))}
      </div>

      <section aria-labelledby="room-listeners">
        <h2 id="room-listeners" className="room__heading">
          {t('m.rooms.listeners')} <span className="muted">{room.listeners.length}</span>
        </h2>
        {/* Always rendered, so hosts hear hands going up while they're elsewhere in the room. */}
        <p className="muted room__hands" role="status">
          {canHost && hands.length ? tp('rooms.handsRaised', hands.length) : ''}
        </p>
        {room.listeners.length ? (
          <ul className="room-listeners">
            {room.listeners.map((p) => {
              const actions = hostActions(p);
              return (
                <li key={p.user.id}>
                  <Avatar name={p.user.displayName} src={p.user.avatarUrl} size="sm" />
                  <span className="room-listeners__name">{p.user.id === me.id ? t('m.rooms.you', { name: p.user.displayName }) : p.user.displayName}</span>
                  {p.host ? <Badge tone="neutral">{t('m.rooms.host')}</Badge> : null}
                  {p.handRaised ? <Icon name="hand" size={18} label={t('m.rooms.handRaised')} /> : null}
                  {p.invited ? <span className="muted">{t('m.rooms.invitedLabel')}</span> : null}
                  {actions.length ? <Menu label={t('m.rooms.manage', { name: p.user.displayName })} actions={actions} /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{t('m.rooms.nobodyListening')}</p>
        )}
      </section>

      <div className="room-controls" role="group" aria-label={t('rooms.controls')}>
        {mine?.role === 'speaker' ? (
          <>
            <Button
              variant={mine.muted ? 'primary' : 'secondary'}
              icon={mine.muted ? 'mic-off' : 'mic'}
              onClick={() => void rooms.act((rid) => api.rooms.mute(rid, !mine.muted))}
            >
              {mine.muted ? t('m.calls.unmute') : t('m.calls.mute')}
            </Button>
            <Button variant="ghost" onClick={() => void rooms.act((rid) => api.rooms.toListener(rid, me.id))}>
              {t('m.rooms.toListeners')}
            </Button>
          </>
        ) : canHost ? (
          <Button icon="mic" variant="secondary" onClick={() => void rooms.act((rid) => api.rooms.speak(rid, true))}>
            {t('m.rooms.speak')}
          </Button>
        ) : (
          // A toggle: the name stays "Raise hand" and aria-pressed says whether it's up.
          <Button
            icon="hand"
            variant={mine?.handRaised ? 'primary' : 'secondary'}
            aria-pressed={!!mine?.handRaised}
            onClick={() => void rooms.act((rid) => api.rooms.hand(rid, !mine?.handRaised))}
          >
            {t('m.rooms.raiseHand')}
          </Button>
        )}
        <span className="room-controls__reactions" role="group" aria-label={t('m.rooms.reactions')}>
          {ROOM_REACTIONS.map((k) => (
            <button
              key={k}
              type="button"
              className="room-react"
              aria-label={t(REACTION_LABEL[k])}
              title={t(REACTION_LABEL[k])}
              onClick={() => void rooms.act((rid) => api.rooms.react(rid, k))}
            >
              <Icon name={k} size={20} />
            </button>
          ))}
        </span>
        <Button
          variant="ghost"
          icon="logout"
          onClick={async () => {
            await rooms.leave();
            router.push(`/c/${room.community.slug}`);
          }}
        >
          {t('m.rooms.leave')}
        </Button>
        {canHost ? (
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            {t('m.rooms.end')}
          </Button>
        ) : null}
      </div>

      <Dialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title={t('m.rooms.endConfirm')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
              {t('m.rooms.keep')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmEnd(false);
                await rooms.act((rid) => api.rooms.end(rid));
              }}
            >
              {t('m.rooms.end')}
            </Button>
          </>
        }
      >
        <p>{t('m.rooms.endBody')}</p>
      </Dialog>
    </div>
  );
}

function SpeakerTile({ p, speaking, actions = [], you }: { p: RoomParticipant; speaking: boolean; actions?: MenuAction[]; you?: boolean }) {
  const { t } = useSession();
  return (
    <div className={`room-speaker${speaking ? ' is-speaking' : ''}`}>
      <span className="room-speaker__avatar">
        <Avatar name={p.user.displayName} src={p.user.avatarUrl} size="lg" />
        {p.muted ? (
          <span className="room-speaker__muted">
            <Icon name="mic-off" size={14} label={t('m.rooms.muted')} />
          </span>
        ) : null}
      </span>
      <span className="room-speaker__name">{you ? t('m.rooms.you', { name: p.user.displayName }) : p.user.displayName}</span>
      <span className="muted room-speaker__meta">{speaking ? t('m.rooms.speaking') : p.host ? t('m.rooms.host') : t('m.rooms.speaker')}</span>
      {actions.length ? <Menu label={t('m.rooms.manage', { name: p.user.displayName })} actions={actions} /> : null}
    </div>
  );
}

function ScheduledRoom({
  room,
  canHost,
  locale,
  onChange,
  onStarted,
}: {
  room: RoomSummary;
  canHost: boolean;
  locale: string;
  onChange: (r: Partial<RoomSummary>) => void;
  onStarted: () => Promise<void>;
}) {
  const { toast, t } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-sm">
      <p>
        <Icon name="calendar" size={18} /> {room.scheduledFor ? when(room.scheduledFor, locale) : t('rooms.soon')}
      </p>
      <div className="row">
        <Button
          variant={room.remindMe ? 'secondary' : 'primary'}
          icon="bell"
          aria-pressed={room.remindMe}
          onClick={async () => {
            try {
              onChange({ remindMe: (await api.rooms.remind(room.id, !room.remindMe)).remindMe });
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        >
          {t('m.rooms.remind')}
        </Button>
        {canHost ? (
          <>
            <Button
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.rooms.start(room.id);
                  await onStarted();
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('m.rooms.startNow')}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  onChange((await api.rooms.end(room.id)).room);
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('m.rooms.cancel')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── On the community page ───────────────────────────────────────────────
export function CommunityRooms({ slug, isMember }: { slug: string; isMember: boolean }) {
  const { locale, toast, t, tp } = useSession();
  const rooms = useRooms();
  const router = useRouter();
  const [data, setData] = useState<{ items: RoomSummary[]; canStart: boolean; locked?: boolean } | null>(null);
  const [title, setTitle] = useState('');
  const [later, setLater] = useState(false);
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api.communities.rooms(slug).then(setData, (e) => {
        setData({ items: [], canStart: false });
        toast(errorMessage(e));
      }),
    [slug, toast],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <Skeleton height={120} />;
  if (data.locked) return <Alert tone="info">{t('rooms.locked')}</Alert>;
  const live = data.items.filter((r) => r.status === 'live');
  const scheduled = data.items.filter((r) => r.status === 'scheduled');
  const ended = data.items.filter((r) => r.status === 'ended');

  return (
    <div className="stack">
      {data.canStart ? (
        <form
          className="room-new"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api.communities.startRoom(slug, { title: title.trim(), scheduledFor: later && at ? new Date(at).toISOString() : undefined });
              setTitle('');
              setLater(false);
              if (r.room.status === 'live') {
                router.push(`/rooms/${r.room.id}`);
                await rooms.join(r.room.id);
              } else await load();
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label={t('m.rooms.new')}
            placeholder={t('m.rooms.titleLabel')}
            value={title}
            maxLength={ROOM_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="row" style={{ gap: 'var(--space-2)' }}>
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> {t('rooms.scheduleLater')}
          </label>
          {later ? (
            <TextField
              label={t('rooms.startsAt')}
              type="datetime-local"
              value={at}
              min={localInput(new Date())}
              onChange={(e) => setAt(e.target.value)}
              hint={t('rooms.startsAtHint')}
            />
          ) : null}
          <div className="row">
            <Button type="submit" icon="mic" loading={busy} disabled={!title.trim() || (later && !at)}>
              {later ? t('rooms.schedule') : t('m.rooms.start')}
            </Button>
          </div>
          <p className="muted">{t('rooms.startNote', { speakers: ROOM_MAX_SPEAKERS, listeners: ROOM_MAX_LISTENERS })}</p>
        </form>
      ) : null}

      {!data.items.length ? <p className="muted">{t('rooms.empty')}</p> : null}
      {[...live, ...scheduled, ...ended].map((r) => (
        <article key={r.id} className="room-card">
          <div className="room-card__head">
            {r.status === 'live' ? (
              <Badge tone="danger">{t('m.rooms.live')}</Badge>
            ) : r.status === 'scheduled' ? (
              <Badge tone="warning">{t('m.rooms.scheduled')}</Badge>
            ) : (
              <Badge>{t('m.rooms.ended')}</Badge>
            )}
            <Link href={`/rooms/${r.id}`} className="room-card__title">
              {r.title}
            </Link>
          </div>
          <p className="muted room-card__meta">
            {r.status === 'live'
              ? `${tp('m.rooms.listening', r.listenerCount)}${
                  r.speakerPreview.length
                    ? ` · ${t('rooms.onStage', {
                        names: nameList(
                          r.speakerPreview.map((u) => u.displayName),
                          locale,
                        ),
                      })}`
                    : ''
                }`
              : r.status === 'scheduled'
                ? `${r.scheduledFor ? `${when(r.scheduledFor, locale)} · ` : ''}${t('rooms.withHost', { name: r.createdBy.displayName })}`
                : endedLine(r, t, tp)}
          </p>
          {r.status === 'live' && isMember ? (
            <div className="row">
              <Button
                size="sm"
                icon="volume"
                loading={rooms.joining === r.id}
                disabled={r.listenerCount - r.speakerCount >= r.limits.listeners && rooms.room?.id !== r.id}
                onClick={async () => {
                  if (await rooms.join(r.id)) router.push(`/rooms/${r.id}`);
                }}
              >
                {rooms.room?.id === r.id ? t('rooms.open') : r.listenerCount - r.speakerCount >= r.limits.listeners ? t('m.rooms.full') : t('communities.join')}
              </Button>
            </div>
          ) : r.status === 'scheduled' && isMember ? (
            <div className="row">
              <Button
                size="sm"
                variant="secondary"
                icon="bell"
                aria-pressed={r.remindMe}
                onClick={async () => {
                  try {
                    const res = await api.rooms.remind(r.id, !r.remindMe);
                    setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? { ...x, remindMe: res.remindMe } : x)) } : d));
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t('m.rooms.remind')}
              </Button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
