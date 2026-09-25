'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, type EventAttendee, type RsvpStatus } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CalendarIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Menu,
  MoreIcon,
  ShareIcon,
  TicketIcon,
  useToast,
  type MenuItemDef,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

const RSVP_CHOICES: Extract<RsvpStatus, 'going' | 'interested' | 'not_going'>[] = [
  'going',
  'interested',
  'not_going',
];

function AttendeeRow({ a }: { a: EventAttendee }) {
  return (
    <li className="person-row">
      <Avatar name={a.user.displayName} src={a.user.avatarUrl} size="sm" decorative />
      <div className="person-row__text">
        <Link href={`/u/${encodeURIComponent(a.user.username)}`} className="person-row__name">
          {a.user.displayName}
        </Link>
      </div>
    </li>
  );
}

function AttendeesSection({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<EventAttendee>(
    (cursor, signal) =>
      api.events.attendees(id, {
        status: 'going',
        limit: 20,
        signal,
        ...(cursor ? { cursor } : {}),
      }),
    'attendees',
  );
  return (
    <section aria-labelledby="attendees-h" className="stack-sm">
      <h2 id="attendees-h" className="section-title">
        {t('events.attendeesTitle')}
      </h2>
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <p className="muted">{t('events.attendeesEmpty')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm" aria-label={t('events.attendeesTitle')}>
          {state.items.map((a) => (
            <AttendeeRow key={a.user.id} a={a} />
          ))}
        </ul>
      ) : null}
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </section>
  );
}

function HostToolsSection({ id, reload }: { id: string; reload: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const cohosts = useAsync((signal) => api.events.cohosts(id, { signal }), [api, id]);
  const ticketTypes = useAsync((signal) => api.events.ticketTypes(id, { signal }), [api, id]);
  const [cohostUsername, setCohostUsername] = useState('');
  const [cohostBusy, setCohostBusy] = useState(false);
  const [ticketForm, setTicketForm] = useState({ name: '', priceCents: '0', quantity: '10' });
  const [ticketBusy, setTicketBusy] = useState(false);
  const [error, setError] = useState('');

  const addCohost = async () => {
    const username = cohostUsername.trim().replace(/^@/, '');
    if (!username) return;
    setCohostBusy(true);
    setError('');
    try {
      const p = await api.profile.get(username);
      await api.events.addCohost(id, p.id);
      setCohostUsername('');
      cohosts.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setCohostBusy(false);
    }
  };

  const removeCohost = async (userId: string) => {
    try {
      await api.events.removeCohost(id, userId);
      cohosts.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const addTicketType = async () => {
    if (!ticketForm.name.trim()) return;
    setTicketBusy(true);
    try {
      await api.events.createTicketType(id, {
        name: ticketForm.name.trim(),
        priceCents: Number(ticketForm.priceCents) || 0,
        quantity: Number(ticketForm.quantity) || 1,
      });
      setTicketForm({ name: '', priceCents: '0', quantity: '10' });
      ticketTypes.reload();
      toast.show({ tone: 'success', title: t('events.host.ticketAdded') });
      reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setTicketBusy(false);
    }
  };

  return (
    <section aria-labelledby="host-tools-h" className="stack">
      <h2 id="host-tools-h" className="section-title">
        {t('events.host.title')}
      </h2>
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('events.host.cohosts')}</h3>
        {cohosts.error ? <ErrorView error={cohosts.error} onRetry={cohosts.reload} /> : null}
        <ul className="stack-sm">
          {(cohosts.data?.items ?? []).map((c) => (
            <li key={c.id} className="person-row">
              <Avatar name={c.displayName} src={c.avatarUrl} size="sm" decorative />
              <span className="person-row__text">{c.displayName}</span>
              <IconButton
                label={t('events.host.removeCohost')}
                icon={<CloseIcon size={16} />}
                onClick={() => void removeCohost(c.id)}
              />
            </li>
          ))}
        </ul>
        <div className="inline-form">
          <Input
            value={cohostUsername}
            onChange={(e) => setCohostUsername(e.target.value)}
            placeholder="@username"
          />
          <Button
            size="sm"
            variant="secondary"
            loading={cohostBusy}
            onClick={() => void addCohost()}
          >
            {t('events.host.addCohost')}
          </Button>
        </div>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
      </Card>
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('events.host.ticketTypesTitle')}</h3>
        {ticketTypes.error ? (
          <ErrorView error={ticketTypes.error} onRetry={ticketTypes.reload} />
        ) : null}
        <ul className="stack-sm">
          {(ticketTypes.data?.items ?? []).map((tt) => (
            <li key={tt.id}>
              {tt.name} — {tt.free ? t('events.ticketFree') : tt.priceCents} ({tt.remaining}/
              {tt.quantity})
            </li>
          ))}
        </ul>
        <div className="inline-form">
          <FormField label={t('events.host.ticketName')}>
            <Input
              value={ticketForm.name}
              onChange={(e) => setTicketForm((f) => ({ ...f, name: e.target.value }))}
            />
          </FormField>
          <FormField label={t('events.host.ticketPrice')}>
            <Input
              type="number"
              min={0}
              value={ticketForm.priceCents}
              onChange={(e) => setTicketForm((f) => ({ ...f, priceCents: e.target.value }))}
            />
          </FormField>
          <FormField label={t('events.host.ticketQuantity')}>
            <Input
              type="number"
              min={1}
              value={ticketForm.quantity}
              onChange={(e) => setTicketForm((f) => ({ ...f, quantity: e.target.value }))}
            />
          </FormField>
          <Button
            size="sm"
            variant="secondary"
            loading={ticketBusy}
            onClick={() => void addTicketType()}
          >
            {t('events.host.addTicketType')}
          </Button>
        </div>
      </Card>
    </section>
  );
}

export function EventDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const ev = useAsync((signal) => api.events.get(id, { signal }), [api, id]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  usePageTitle(ev.data?.title, t('app.name'));

  const run = async (fn: () => Promise<unknown>, okMessage?: string) => {
    setBusy(true);
    try {
      await fn();
      ev.reload();
      if (okMessage) toast.show({ tone: 'success', title: okMessage });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      const r = await api.events.share(id);
      await navigator.clipboard.writeText(r.url);
      toast.show({ tone: 'success', title: t('post.linkCopied') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const addToCalendar = async () => {
    try {
      const r = await api.events.share(id);
      window.open(r.calendarUrl, '_blank', 'noopener');
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  if (ev.loading) return <PageSpinner />;
  if (ev.error) {
    if (ev.error instanceof ApiError && ev.error.status === 404) {
      return <EmptyState icon={<CalendarIcon size={28} />} title={t('events.notFound')} />;
    }
    return <ErrorView error={ev.error} onRetry={ev.reload} />;
  }
  const e = ev.data;
  if (!e) return null;
  const v = e.viewer;
  const canManage = v.isOrganiser || v.isManager;

  const menuItems: MenuItemDef[] = [];
  if (canManage) {
    menuItems.push({
      id: 'edit',
      label: t('events.edit'),
      icon: <EditIcon size={16} />,
      onSelect: () => router.push(`/events/${encodeURIComponent(id)}/edit`),
    });
    if (e.status === 'draft') {
      menuItems.push({
        id: 'publish',
        label: t('events.publish'),
        onSelect: () => void run(() => api.events.publish(id), t('events.publishDone')),
      });
    }
    if (e.status === 'published') {
      menuItems.push({
        id: 'cancel',
        label: t('events.cancel'),
        danger: true,
        onSelect: () => setConfirm('cancel'),
      });
    }
    menuItems.push({
      id: 'delete',
      label: t('events.delete'),
      danger: true,
      onSelect: () => setConfirm('delete'),
    });
  }

  return (
    <>
      <PageHeader
        title={e.title}
        actions={
          menuItems.length > 0 ? (
            <Menu
              label={t('post.moreMenu')}
              trigger={<IconButton label={t('post.moreMenu')} icon={<MoreIcon size={20} />} />}
              items={menuItems}
            />
          ) : undefined
        }
      />
      {e.coverUrl ? <img src={e.coverUrl} alt="" className="event-detail__cover" /> : null}

      {e.status === 'cancelled' ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {t('events.cancelled')}
          {e.cancelReason ? ` ${t('events.cancelledReason', { reason: e.cancelReason })}` : ''}
        </p>
      ) : null}
      {e.status === 'completed' ? (
        <p className="yl-notice yl-notice--info">{t('events.completed')}</p>
      ) : null}
      {e.status === 'draft' ? (
        <p className="yl-notice yl-notice--warning">{t('events.draftNotice')}</p>
      ) : null}

      <div className="event-detail__head">
        <div className="stack-sm">
          <span>{fmt.dateTime(e.startsAt)}</span>
          {e.locationText ? <span>{e.locationText}</span> : null}
          {e.hasOnlineUrl ? (
            v.rsvp === 'going' && e.onlineUrl ? (
              <a href={e.onlineUrl} className="link-btn">
                {t('events.onlineLink')}
              </a>
            ) : (
              <span className="muted">{t('events.onlineLinkHidden')}</span>
            )
          ) : null}
          {e.host ? <span>{t('events.hostedBy', { name: e.host.displayName })}</span> : null}
          {e.place ? <span>{t('events.atPlace', { name: e.place.name })}</span> : null}
          <span>
            {t('events.going', { count: e.counts.going })} ·{' '}
            {t('events.interested', { count: e.counts.interested })}
          </span>
          {e.capacity !== null && e.counts.spotsLeft !== null ? (
            e.counts.spotsLeft > 0 ? (
              <Badge>{t('events.spotsLeft', { count: e.counts.spotsLeft })}</Badge>
            ) : (
              <Badge tone="warning">{t('events.full')}</Badge>
            )
          ) : null}
        </div>
        <div className="button-row">
          {e.status !== 'draft' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void copyLink()}>
                {t('events.share')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<CalendarIcon size={16} />}
                onClick={() => void addToCalendar()}
              >
                {t('events.addToCalendar')}
              </Button>
            </>
          ) : null}
          <IconButton
            label={v.saved ? t('events.unsave') : t('events.save')}
            icon={v.saved ? <CheckIcon size={16} /> : <ShareIcon size={16} />}
            pressed={v.saved}
            onClick={() =>
              void run(
                () => (v.saved ? api.events.unsave(id) : api.events.save(id)),
                v.saved ? undefined : t('events.saved'),
              )
            }
          />
        </div>
      </div>

      {e.description ? <p>{e.description}</p> : null}

      {e.status === 'published' ? (
        <div className="button-row" role="group" aria-label={t('events.rsvp.going')}>
          {v.rsvp === 'waitlist' ? (
            <>
              <p className="muted">{t('events.waitlisted')}</p>
              <Button
                variant="ghost"
                size="sm"
                loading={busy}
                onClick={() => void run(() => api.events.withdrawRsvp(id))}
              >
                {t('events.rsvp.withdraw')}
              </Button>
            </>
          ) : (
            <>
              {RSVP_CHOICES.map((s) => (
                <Button
                  key={s}
                  variant={v.rsvp === s ? 'primary' : 'secondary'}
                  size="sm"
                  loading={busy}
                  onClick={() => void run(() => api.events.rsvp(id, s), t('events.rsvp.updated'))}
                >
                  {t(`events.rsvp.${s}`)}
                </Button>
              ))}
              {e.capacity !== null && e.counts.spotsLeft === 0 && e.waitlistEnabled ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    void run(() => api.events.rsvp(id, 'going'), t('events.rsvp.updated'))
                  }
                >
                  {t('events.rsvp.waitlist')}
                </Button>
              ) : null}
              {v.rsvp ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy}
                  onClick={() => void run(() => api.events.withdrawRsvp(id))}
                >
                  {t('events.rsvp.withdraw')}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {v.rsvp === 'going' || v.rsvp === 'waitlist' || v.rsvp === 'attended' ? (
        <MyTicket id={id} />
      ) : null}

      {e.rules ? (
        <section aria-labelledby="rules-h" className="stack-sm">
          <h2 id="rules-h" className="section-title">
            {t('events.rules')}
          </h2>
          <p>{e.rules}</p>
        </section>
      ) : null}

      {e.ticketTypes && e.ticketTypes.length > 0 ? (
        <section aria-labelledby="tickets-h" className="stack-sm">
          <h2 id="tickets-h" className="section-title">
            {t('events.ticketsTitle')}
          </h2>
          <ul className="stack-sm">
            {e.ticketTypes.map((tt) => (
              <li key={tt.id} className="search-row">
                <TicketIcon size={16} />
                <span className="search-row__text">
                  <span>{tt.name}</span>
                  <span className="muted">
                    {tt.free
                      ? t('events.ticketFree')
                      : fmt.currency(tt.priceCents / 100, tt.currency)}
                    {' · '}
                    {tt.remaining > 0
                      ? t('events.ticketRemaining', { count: tt.remaining })
                      : t('events.ticketSoldOut')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {e.ticketTypes.some((tt) => !tt.free) ? (
            <p className="muted">{t('events.ticketPaidNotice')}</p>
          ) : null}
        </section>
      ) : null}

      <AttendeesSection id={id} />

      {canManage ? <HostToolsSection id={id} reload={ev.reload} /> : null}

      <ConfirmDialog
        open={confirm === 'delete'}
        title={t('events.deleteDialog')}
        description={t('events.deleteBody')}
        confirmLabel={t('events.delete')}
        danger
        busy={busy}
        onConfirm={() =>
          void (async () => {
            setBusy(true);
            try {
              await api.events.delete(id);
              router.push('/events');
            } catch (err) {
              toast.show({
                tone: 'danger',
                title: t('error.actionFailed'),
                description: describeError(err, t).message,
              });
              setBusy(false);
            }
          })()
        }
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title={t('events.cancelDialog')}
        description={
          <>
            <p>{t('events.cancelBody')}</p>
            <FormField label={t('events.cancelReasonLabel')}>
              <Input value={cancelReason} onChange={(ev2) => setCancelReason(ev2.target.value)} />
            </FormField>
          </>
        }
        confirmLabel={t('events.cancel')}
        danger
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await api.events.cancel(id, cancelReason || undefined);
            setConfirm(null);
          })
        }
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function MyTicket({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const ticket = useAsync((signal) => api.events.myTicket(id, { signal }), [api, id]);
  if (ticket.loading || ticket.error || !ticket.data?.checkinCode) return null;
  return (
    <p>
      {t('events.checkinCode')}: <strong dir="ltr">{ticket.data.checkinCode}</strong>
    </p>
  );
}
