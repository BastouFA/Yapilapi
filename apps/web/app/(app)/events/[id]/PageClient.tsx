'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, AvatarGroup, Badge, Button, EmptyState, Icon, Segments, Skeleton } from '@yapilapi/design-system';
import type { EventItem, PublicUser } from '@yapilapi/shared';
import { formatEventWhen, safeTimeZone } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
import { MiniAppsSheet } from '@/components/MiniApps';
import { ReportSheet } from '@/components/PostList';
import { useSession } from '../../../providers';

/** An event. Without an account, a public event is readable and RSVP leads to sign in. */
export default function EventPageClient({ isPublic }: { isPublic: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { t, tp, toast, locale, me, flags } = useSession();
  const [appsOpen, setAppsOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const signIn = useSignIn();
  const signedOut = !me;
  const [ev, setEv] = useState<EventItem | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<{ user: PublicUser; status: string }[]>([]);

  const loadAttendees = useCallback(() => {
    api.events
      .attendees(id)
      .then((r) => setAttendees(r.items))
      .catch(() => {});
  }, [id]);
  const load = useCallback(() => {
    setLoadError(null);
    api.events.get(id).then(
      (r) => setEv(r.event),
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
    loadAttendees();
  }, [id, loadAttendees]);

  useEffect(() => {
    if (signedOut && !isPublic) return;
    load();
  }, [load, signedOut, isPublic]);

  if (signedOut && !isPublic) return <NeedsAccount title={t('eventPage.signIn.title')} body={t('eventPage.signIn.body')} />;
  if (missing) return <EmptyState level={1} title={t('m.event.notFound')} body={t('eventPage.notFoundBody')} />;
  if (!ev && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!ev) return <Skeleton height={240} />;

  const tz = safeTimeZone(ev.timezone);
  const when = formatEventWhen(ev.startsAt, locale, tz);
  const until = ev.endsAt ? new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(ev.endsAt)) : null;
  const going = attendees.filter((a) => a.status === 'going');
  const [hostedBefore = '', hostedAfter = ''] = t('m.event.hostedBy').split('{name}');
  const goingNames = new Intl.ListFormat(locale, { type: 'unit', style: 'short' }).format(going.slice(0, 3).map((a) => a.user.displayName.split(' ')[0] ?? ''));

  return (
    <div className="yp-shell__inner">
      <div className="stack-sm">
        {ev.community ? (
          <Link href={`/c/${ev.community.slug}`} className="muted">
            {ev.community.name}
          </Link>
        ) : null}
        <h1 className="profile__name">{ev.title}</h1>
        <p style={{ margin: 0 }}>
          <strong>{when}</strong>
          {until ? ` – ${until}` : ''}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          {ev.online ? t('m.event.online') : ev.place ? <Link href={`/places/${ev.place.id}`}>{ev.place.name}</Link> : (ev.locationText ?? t('ds.locationTba'))}
          {ev.capacity ? ` · ${t('eventPage.spotsTaken', { going: ev.counts.going, capacity: ev.capacity })}` : ` · ${tp('m.event.going', ev.counts.going)}`}
          {` · ${tp('m.event.interested', ev.counts.interested)}`}
        </p>
        <div className="row">
          {hostedBefore}
          <Link href={`/u/${ev.host.username}`} className="row">
            <Avatar name={ev.host.displayName} src={ev.host.avatarUrl} size="sm" /> {ev.host.displayName}
          </Link>
          {hostedAfter}
        </div>
      </div>

      {ev.host.id !== me?.id ? (
        <div className="stack-sm">
          <Segments
            label={t('eventPage.yourRsvp')}
            value={ev.myRsvp ?? ('none' as never)}
            onChange={async (status: 'going' | 'interested' | 'not_going') => {
              if (signedOut) return signIn();
              try {
                const r = await api.events.rsvp(id, status);
                setEv(r.event);
                loadAttendees();
                toast(r.status === 'waitlist' ? t('m.event.waitlist') : t('eventPage.rsvpSaved'));
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
            options={[
              { id: 'going', label: t('events.going') },
              { id: 'interested', label: t('events.interested') },
              { id: 'not_going', label: t('events.notGoing') },
            ]}
          />
          {ev.myRsvp === 'interested' && ev.capacity && ev.counts.going >= ev.capacity ? <Badge tone="warning">{t('eventPage.waitlist')}</Badge> : null}
        </div>
      ) : (
        <Badge tone="success">{t('eventPage.hosting')}</Badge>
      )}

      {ev.canCheckIn || (ev.myRsvp === 'going' && ev.host.id !== me?.id) ? (
        <div className="row">
          {ev.canCheckIn ? (
            <Link href={`/events/${id}/check-in`} className="yp-btn yp-btn--primary">
              <Icon name="scan" />
              {t('checkin.open')}
            </Link>
          ) : null}
          {ev.myRsvp === 'going' && ev.host.id !== me?.id ? (
            <Link href="/tickets" className="yp-btn yp-btn--secondary">
              <Icon name="ticket" />
              {t('tickets.yourTicket')}
            </Link>
          ) : null}
        </div>
      ) : null}

      {ev.description ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{ev.description}</p> : null}

      {signedOut ? null : (
        <div className="row">
          {/* Mini Apps: the host adds them; guests who replied use them. */}
          {flags.MINI_APPS && (ev.host.id === me?.id || ev.myRsvp) ? (
            <Button size="sm" variant="secondary" icon="create" onClick={() => setAppsOpen(true)}>
              {t('chat.apps')}
            </Button>
          ) : null}
          {ev.host.id !== me?.id ? (
            <Button size="sm" variant="ghost" icon="flag" onClick={() => setReporting(true)}>
              {t('post.report')}
            </Button>
          ) : null}
        </div>
      )}
      <MiniAppsSheet open={appsOpen} onClose={() => setAppsOpen(false)} surface="event" surfaceId={ev.id} canManage={ev.host.id === me?.id} />
      <ReportSheet target={reporting ? { type: 'event', id: ev.id } : null} onClose={() => setReporting(false)} />

      {going.length && !signedOut ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('events.going')}</h2>
          <div className="row">
            <AvatarGroup>
              {going.slice(0, 8).map((a) => (
                <Avatar key={a.user.id} name={a.user.displayName} src={a.user.avatarUrl} size="sm" />
              ))}
            </AvatarGroup>
            <span className="muted">{going.length > 3 ? tp('eventPage.goingMore', going.length - 3, { names: goingNames }) : goingNames}</span>
          </div>
        </section>
      ) : null}

      {signedOut ? (
        <JoinNote text={t('eventPage.join')} />
      ) : (
        <Link href={`/create`} className="yp-btn yp-btn--secondary">
          {t('eventPage.sharePost')}
        </Link>
      )}
      <Button variant="ghost" onClick={async () => toast((await copyText(location.href)) ? t('invite.copied') : t('story.copyFailed'))}>
        {t('invite.copy')}
      </Button>
    </div>
  );
}
