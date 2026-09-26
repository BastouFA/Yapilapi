'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, AvatarGroup, Badge, Button, EmptyState, Segments, Skeleton } from '@yapilapi/design-system';
import type { EventItem, PublicUser } from '@yapilapi/shared';
import { formatEventWhen, safeTimeZone } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
import { useSession } from '../../../providers';

/** An event. Without an account, a public event is readable and RSVP leads to sign in. */
export default function EventPageClient({ isPublic }: { isPublic: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { t, toast, locale, me } = useSession();
  const signIn = useSignIn();
  const signedOut = !me;
  const [ev, setEv] = useState<EventItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [attendees, setAttendees] = useState<{ user: PublicUser; status: string }[]>([]);

  useEffect(() => {
    if (signedOut && !isPublic) return;
    api.events.get(id).then(
      (r) => setEv(r.event),
      () => setMissing(true),
    );
    api.events
      .attendees(id)
      .then((r) => setAttendees(r.items))
      .catch(() => {});
  }, [id, signedOut, isPublic]);

  if (signedOut && !isPublic)
    return <NeedsAccount title="Sign in to see this event" body="Some events are only shared with the host's followers or friends." />;
  if (missing) return <EmptyState title="Event not found" body="It may have been cancelled, or it's private." />;
  if (!ev) return <Skeleton height={240} />;

  const tz = safeTimeZone(ev.timezone);
  const when = formatEventWhen(ev.startsAt, locale, tz);
  const until = ev.endsAt ? new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(ev.endsAt)) : null;
  const going = attendees.filter((a) => a.status === 'going');

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
          {ev.online ? 'Online' : ev.place ? <Link href={`/places/${ev.place.id}`}>{ev.place.name}</Link> : (ev.locationText ?? 'Location to be announced')}
          {ev.capacity ? ` · ${ev.counts.going}/${ev.capacity} spots taken` : ` · ${ev.counts.going} going`} · {ev.counts.interested} interested
        </p>
        <div className="row">
          Hosted by
          <Link href={`/u/${ev.host.username}`} className="row">
            <Avatar name={ev.host.displayName} src={ev.host.avatarUrl} size="sm" /> {ev.host.displayName}
          </Link>
        </div>
      </div>

      {ev.host.id !== me?.id ? (
        <div className="stack-sm">
          <Segments
            label="Your RSVP"
            value={ev.myRsvp ?? ('none' as never)}
            onChange={async (status: 'going' | 'interested' | 'not_going') => {
              if (signedOut) return signIn();
              try {
                const r = await api.events.rsvp(id, status);
                setEv(r.event);
                toast(r.status === 'waitlist' ? "It's full, so you're on the waitlist." : 'RSVP saved');
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
          {ev.myRsvp === 'interested' && ev.capacity && ev.counts.going >= ev.capacity ? <Badge tone="warning">Waitlist</Badge> : null}
        </div>
      ) : (
        <Badge tone="success">You're hosting</Badge>
      )}

      {ev.description ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{ev.description}</p> : null}

      {going.length && !signedOut ? (
        <section className="stack-sm">
          <h2 className="section-title">Going</h2>
          <div className="row">
            <AvatarGroup>
              {going.slice(0, 8).map((a) => (
                <Avatar key={a.user.id} name={a.user.displayName} src={a.user.avatarUrl} size="sm" />
              ))}
            </AvatarGroup>
            <span className="muted">
              {going
                .map((a) => a.user.displayName.split(' ')[0])
                .slice(0, 3)
                .join(', ')}
              {going.length > 3 ? ` and ${going.length - 3} more` : ''}
            </span>
          </div>
        </section>
      ) : null}

      {signedOut ? (
        <JoinNote text="Join YAPILAPI to say you're going and keep up with this event." />
      ) : (
        <Link href={`/create`} className="yp-btn yp-btn--secondary">
          Share a post about this event
        </Link>
      )}
      <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(location.href).then(() => toast('Link copied'))}>
        Copy link
      </Button>
    </div>
  );
}
