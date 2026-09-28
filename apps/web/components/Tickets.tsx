'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Icon, Segments, Skeleton } from '@yapilapi/design-system';
import {
  directionsUrl,
  formatEventWhen,
  safeTimeZone,
  spacedTicketCode,
  ticketIcs,
  ticketIcsName,
  ticketPlaceLine,
  eventEndsAt,
  type EventTicket,
  type PublicUser,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';
import { PeoplePicker } from './PeoplePicker';
import { QrCode } from './ProfilePlus';

type When = 'upcoming' | 'past';

/**
 * Your Tickets wallet: tickets for events you said you're going to and tickets you bought, each
 * with its QR code, backup code and what you need to get there. Past tickets (ended, cancelled or
 * refunded) are on their own tab. A ticket that changes (checked in at the door, given to you)
 * updates live.
 */
export function TicketsWallet() {
  const { t, toast } = useSession();
  const [when, setWhen] = useState<When>('upcoming');
  const [items, setItems] = useState<EventTicket[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(
    (w: When) =>
      api.tickets.list(w).then(
        (r) => {
          setItems(r.items);
          setError(false);
        },
        (e) => {
          setItems((cur) => cur ?? []);
          setError(true);
          toast(errorMessage(e));
        },
      ),
    [toast],
  );
  useEffect(() => {
    setItems(null);
    void load(when);
  }, [when, load]);
  useRealtime((e) => {
    if (e.type === 'ticket.updated') void load(when);
  });

  return (
    <div className="yp-shell__inner tickets">
      <div className="yp-topbar">
        <h1>{t('tickets.title')}</h1>
      </div>
      <Segments
        label={t('tickets.which')}
        value={when}
        onChange={setWhen}
        options={[
          { id: 'upcoming', label: t('tickets.upcoming') },
          { id: 'past', label: t('tickets.past') },
        ]}
      />
      {items === null ? (
        <Skeleton height={420} />
      ) : error && !items.length ? (
        <EmptyState title={t('tickets.loadError')} action={<Button onClick={() => void load(when)}>{t('m.common.retry')}</Button>} />
      ) : items.length ? (
        <ul className="tickets__list">
          {items.map((ticket) => (
            <li key={ticket.id}>
              <TicketCard ticket={ticket} onChanged={() => void load(when)} />
            </li>
          ))}
        </ul>
      ) : when === 'upcoming' ? (
        <EmptyState
          title={t('tickets.empty.title')}
          body={t('tickets.empty.body')}
          action={
            <Link href="/events" className="yp-btn yp-btn--primary">
              {t('tickets.findEvents')}
            </Link>
          }
        />
      ) : (
        <EmptyState title={t('tickets.empty.title')} body={t('tickets.empty.past')} />
      )}
    </div>
  );
}

/** Download the ticket's event as an .ics file (the calendar opens it). */
function downloadIcs(ticket: EventTicket) {
  const blob = new Blob([ticketIcs(ticket, { url: `${location.origin}/events/${ticket.event.id}` })], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ticketIcsName(ticket.event.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One ticket: the event, when and where, the ticket type and holder, the QR code and the backup code. */
export function TicketCard({ ticket, onChanged }: { ticket: EventTicket; onChanged: () => void }) {
  const { t, locale } = useSession();
  const [giving, setGiving] = useState(false);
  const e = ticket.event;
  const tz = safeTimeZone(e.timezone);
  const when = formatEventWhen(e.startsAt, locale, tz);
  const until = e.endsAt ? new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: tz }).format(new Date(e.endsAt)) : null;
  const place = e.online ? t('tickets.online') : (ticketPlaceLine(e) ?? t('tickets.tba'));
  const directions = directionsUrl(e, 'web');
  const over = eventEndsAt(e).getTime() < Date.now();
  const usable = ticket.status === 'valid' && !e.cancelled;
  const checkedAt = ticket.checkedInAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(ticket.checkedInAt))
    : null;

  return (
    <article className={`ticket${usable ? '' : ' ticket--void'}`} aria-labelledby={`ticket-${ticket.id}`}>
      <header className="ticket__head">
        <h2 id={`ticket-${ticket.id}`} className="ticket__title">
          <Link href={`/events/${e.id}`}>
            <bdi>{e.title}</bdi>
          </Link>
        </h2>
        <div className="ticket__badges">
          {ticket.status === 'refunded' ? <Badge tone="danger">{t('tickets.status.refunded')}</Badge> : null}
          {ticket.status === 'cancelled' || e.cancelled ? <Badge tone="danger">{t('tickets.status.cancelled')}</Badge> : null}
          {checkedAt ? <Badge tone="success">{t('tickets.checkedIn', { time: checkedAt })}</Badge> : null}
        </div>
        {ticket.from ? <p className="ticket__from">{t('tickets.from', { name: ticket.from.displayName })}</p> : null}
      </header>

      <dl className="ticket__facts">
        <div>
          <dt>{t('tickets.label.when')}</dt>
          <dd>
            {when}
            {until ? ` – ${until}` : ''}
          </dd>
        </div>
        <div>
          <dt>{t('tickets.label.where')}</dt>
          <dd>
            <bdi>{place}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('tickets.label.type')}</dt>
          <dd>
            <bdi>{ticket.type ?? t('tickets.type.rsvp')}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('tickets.label.holder')}</dt>
          <dd>
            <bdi>{ticket.holder.displayName}</bdi>
          </dd>
        </div>
      </dl>

      {usable && ticket.token && ticket.code ? (
        <div className="ticket__pass">
          <QrCode value={ticket.token} size={224} label={t('tickets.qrLabel', { title: e.title, code: spacedTicketCode(ticket.code) })} />
          <div className="ticket__code">
            <span className="ticket__code-label">{t('tickets.code')}</span>
            <span className="ticket__code-value" aria-label={ticket.code.split('').join(' ')}>
              {spacedTicketCode(ticket.code)}
            </span>
            <span className="ticket__hint">{t('tickets.codeHelp')}</span>
            <span className="ticket__hint">{t('tickets.brightness')}</span>
          </div>
        </div>
      ) : e.cancelled ? (
        <p className="ticket__note">{t('tickets.status.eventCancelled')}</p>
      ) : over ? (
        <p className="ticket__note">{t('tickets.status.over')}</p>
      ) : null}

      <div className="ticket__actions">
        {!e.cancelled && !over ? (
          <Button variant="secondary" icon="calendar" onClick={() => downloadIcs(ticket)}>
            {t('tickets.addToCalendar')}
          </Button>
        ) : null}
        {usable && directions ? (
          <a className="yp-btn yp-btn--secondary" href={directions} target="_blank" rel="noopener noreferrer">
            <Icon name="compass" />
            {t('tickets.directions')}
          </a>
        ) : null}
        <Link href={`/events/${e.id}`} className="yp-btn yp-btn--ghost">
          {t('tickets.openEvent')}
        </Link>
        {ticket.transferable ? (
          <Button variant="ghost" icon="send" onClick={() => setGiving(true)}>
            {t('tickets.give')}
          </Button>
        ) : null}
      </div>
      {usable && !ticket.transferable && !ticket.checkedInAt && !over ? <p className="ticket__hint">{t('tickets.give.off')}</p> : null}
      {giving ? (
        <GiveTicket
          ticket={ticket}
          onClose={() => setGiving(false)}
          onGiven={() => {
            setGiving(false);
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}

/** Give a ticket to a friend: pick one friend, and confirm. */
function GiveTicket({ ticket, onClose, onGiven }: { ticket: EventTicket; onClose: () => void; onGiven: () => void }) {
  const { t, toast } = useSession();
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  const friend = picked[0];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tickets.give.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!friend}
            loading={busy}
            onClick={async () => {
              if (!friend) return;
              setBusy(true);
              try {
                await api.tickets.transfer(ticket.id, friend.id);
                toast(t('tickets.give.done', { name: friend.displayName }));
                onGiven();
              } catch (e) {
                toast(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {friend ? t('tickets.give.confirm', { name: friend.displayName }) : t('tickets.give')}
          </Button>
        </>
      }
    >
      <p className="ticket__hint">{t('tickets.give.body')}</p>
      {ticket.source === 'rsvp' ? <p className="ticket__hint">{t('tickets.give.rsvp')}</p> : null}
      <PeoplePicker
        picked={picked}
        onChange={setPicked}
        label={t('tickets.give.label')}
        max={1}
        canPick={(s) => s.relation === 'friend'}
        unavailable={t('tickets.give.friendsOnly')}
        hint={t('tickets.give.friendsOnly')}
      />
    </Dialog>
  );
}
