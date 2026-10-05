'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Avatar, AvatarGroup, Badge, Button, Dialog, EmptyState, Icon, Segments, Skeleton } from '@yapilapi/design-system';
import type { EventItem, PublicUser } from '@yapilapi/shared';
import { eventEndsAt, formatEventWhen, safeTimeZone, timeZoneLabel } from '@yapilapi/shared';
import { browserTimeZone, isWebLink } from '@/components/EventForm';
import { EventTickets } from '@/components/EventTickets';
import { api, errorMessage, isGone } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
import { useSession } from '../../../providers';

/** An event. Without an account, a public event is readable and RSVP leads to sign in. */
export default function EventPageClient({ isPublic }: { isPublic: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { t, tp, toast, locale, me } = useSession();
  const signIn = useSignIn();
  const signedOut = !me;
  const [ev, setEv] = useState<EventItem | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<{ user: PublicUser; status: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const router = useRouter();

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
  const hosting = ev.host.id === me?.id;
  const over = eventEndsAt(ev) < new Date();
  const full = !!ev.capacity && ev.counts.going >= ev.capacity;
  // An online event's link opens only when it's a web address.
  const joinLink = ev.online && ev.locationText && isWebLink(ev.locationText) ? ev.locationText.trim() : null;
  const otherZone = ev.timezone && tz !== browserTimeZone() ? tz : null;
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
          {otherZone ? <span className="muted"> · {t('m.event.inZone', { zone: timeZoneLabel(otherZone) })}</span> : null}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          {ev.online ? (
            joinLink ? (
              <a href={joinLink} target="_blank" rel="noopener noreferrer nofollow">
                {t('m.event.joinOnline')}
              </a>
            ) : (
              t('m.event.online')
            )
          ) : ev.place ? (
            <Link href={`/places/${ev.place.id}`}>{ev.place.name}</Link>
          ) : (
            (ev.locationText ?? t('ds.locationTba'))
          )}
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

      {over ? (
        <Alert tone="info">{t('m.event.over')}</Alert>
      ) : !hosting ? (
        <div className="stack-sm">
          <Segments
            label={t('eventPage.yourRsvp')}
            value={ev.onWaitlist ? 'going' : (ev.myRsvp ?? ('none' as never))}
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
          {ev.onWaitlist ? (
            <p className="muted" role="status" style={{ margin: 0 }}>
              <Badge tone="warning">{t('eventPage.waitlist')}</Badge> {t('m.event.onWaitlist')}
            </p>
          ) : full && ev.myRsvp !== 'going' ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('m.event.full')}
            </p>
          ) : null}
        </div>
      ) : null}
      {hosting && ev.visibility === 'private' ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('eventPage.linkOnly')}
        </p>
      ) : null}
      {hosting ? (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Badge tone="success">{t('eventPage.hosting')}</Badge>
          {over ? null : (
            <>
              <Link href={`/events/${id}/edit`} className="yp-btn yp-btn--secondary yp-btn--sm">
                <Icon name="edit" />
                {t('m.event.edit')}
              </Link>
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
                {t('m.event.cancel')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={t('m.event.cancelTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              {t('m.common.notNow')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.events.cancel(id);
                  setConfirmCancel(false);
                  router.push('/events');
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('m.event.cancel')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('m.event.cancelBody')}</p>
      </Dialog>

      {ev.canCheckIn || (ev.myRsvp === 'going' && !hosting) ? (
        <div className="row">
          {ev.canCheckIn ? (
            <Link href={`/events/${id}/check-in`} className="yp-btn yp-btn--primary">
              <Icon name="scan" />
              {t('checkin.open')}
            </Link>
          ) : null}
          {ev.myRsvp === 'going' && !hosting ? (
            <Link href="/tickets" className="yp-btn yp-btn--secondary">
              <Icon name="ticket" />
              {t('tickets.yourTicket')}
            </Link>
          ) : null}
        </div>
      ) : null}

      {signedOut ? null : <EventTickets event={ev} hosting={hosting} over={over} />}

      {ev.description ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{ev.description}</p> : null}

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
