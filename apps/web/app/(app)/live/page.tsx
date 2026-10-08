'use client';

import { FeatureOff } from '@/components/FeatureOff';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, EmptyState, Select, Skeleton, TextField } from '@yapilapi/design-system';
import type { LiveProduct, LiveSummary } from '@yapilapi/api-client';
import { formatMoney } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { isVerificationError, VerifyPrompt } from '@/components/Verification';
import { PlacePicker, type TaggedPlace } from '@/components/CityMap';
import { useSession } from '../../providers';

export default function LiveList() {
  const { flags, toast, me, locale, t } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<LiveSummary[] | null>(null);
  const [title, setTitle] = useState('');
  // Lives of people under 18 are never for everyone (the server holds to this too).
  const teen = !!me?.under18;
  const [visibility, setVisibility] = useState(teen ? 'followers' : 'public');
  const [ticketId, setTicketId] = useState('');
  // A place page it's at: the live shows on the Near you map there while it's on.
  const [place, setPlace] = useState<TaggedPlace | null>(null);
  const [tickets, setTickets] = useState<LiveProduct[]>([]);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!me || flags.LIVE === false) return;
    api.raw.get<{ items: LiveProduct[] }>(`/v1/products?sellerId=${me.id}&limit=50`).then(
      (r) => setTickets(r.items.filter((p) => p.kind === 'ticket')),
      () => {},
    );
  }, [me, flags.LIVE]);

  useEffect(() => {
    if (flags.LIVE === false) return;
    setLoadError(null);
    api.live.list().then(
      (r) => setItems(r.items),
      (e) => setLoadError(errorMessage(e)),
    );
  }, [flags.LIVE, attempt]);

  if (flags.LIVE === false) return <FeatureOff name={t('m.live.title')} />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.live.title')}</h1>
      </div>
      <form
        className="stack-sm yp-card"
        style={{ padding: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.live.create({ title, visibility, ticketProductId: ticketId || undefined, placeId: place?.id });
            sessionStorage.setItem(`ypl-ingest-${r.live.id}`, JSON.stringify(r.ingest));
            router.push(`/live/${r.live.id}`);
          } catch (err) {
            if (isVerificationError(err)) setNeedsVerify(true);
            else toast(errorMessage(err));
          }
        }}
      >
        {needsVerify || me?.needsVerification ? <VerifyPrompt action="live" /> : null}
        <TextField label={t('live.form.title')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        <Select
          label={t('live.form.audience')}
          value={teen && visibility === 'public' ? 'followers' : visibility}
          onChange={(e) => setVisibility(e.currentTarget.value)}
          hint={teen ? t('live.form.teenHint') : undefined}
        >
          {teen ? null : <option value="public">{t('visibility.public')}</option>}
          <option value="followers">{t('visibility.followers')}</option>
          <option value="friends">{t('visibility.friends')}</option>
        </Select>
        {tickets.length ? (
          <Select label={t('tickets.label.type')} value={ticketId} onChange={(e) => setTicketId(e.currentTarget.value)} hint={t('live.form.ticketHint')}>
            <option value="">{t('live.form.free')}</option>
            {tickets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {formatMoney(p.priceCents, p.currency, locale)}
              </option>
            ))}
          </Select>
        ) : null}
        <PlacePicker value={place} onChange={setPlace} />
        <Button type="submit" disabled={!title.trim()}>
          {t('live.form.submit')}
        </Button>
      </form>
      {loadError ? (
        <EmptyState title={loadError} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('m.common.retry')}</Button>} />
      ) : items === null ? (
        <Skeleton height={120} />
      ) : items.length ? (
        <ul className="yp-list">
          {items.map((l) => (
            <li key={l.id}>
              <Link href={`/live/${l.id}`} className="yp-list__item">
                <Avatar name={l.host.displayName} src={l.host.avatarUrl} />
                <span className="yp-list__text">
                  <span className="yp-list__primary">{l.title}</span>
                  <span className="yp-list__secondary">{l.host.displayName}</span>
                </span>
                <span className="yp-list__end">
                  {l.status === 'live' ? (
                    <Badge tone="danger">{t('m.live.badge', { count: l.viewers })}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('m.live.scheduled')}</Badge>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('m.live.empty')} />
      )}
    </div>
  );
}
