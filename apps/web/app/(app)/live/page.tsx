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
import { useSession } from '../../providers';

export default function LiveList() {
  const { flags, toast, me, locale } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<LiveSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [ticketId, setTicketId] = useState('');
  const [tickets, setTickets] = useState<LiveProduct[]>([]);
  const [needsVerify, setNeedsVerify] = useState(false);
  useEffect(() => {
    if (!me || flags.LIVE === false) return;
    api.raw.get<{ items: LiveProduct[] }>(`/v1/products?sellerId=${me.id}&limit=50`).then(
      (r) => setTickets(r.items.filter((p) => p.kind === 'ticket')),
      () => {},
    );
  }, [me, flags.LIVE]);

  useEffect(() => {
    if (flags.LIVE === false) return;
    api.live.list().then(
      (r) => setItems(r.items),
      (e) => (setItems([]), toast(errorMessage(e))),
    );
  }, [flags.LIVE, toast]);

  if (flags.LIVE === false) return <FeatureOff name="Live" />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Live</h1>
      </div>
      <form
        className="stack-sm yp-card"
        style={{ padding: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.live.create({ title, visibility, ticketProductId: ticketId || undefined });
            sessionStorage.setItem(`ypl-ingest-${r.live.id}`, JSON.stringify(r.ingest));
            router.push(`/live/${r.live.id}`);
          } catch (err) {
            if (isVerificationError(err)) setNeedsVerify(true);
            else toast(errorMessage(err));
          }
        }}
      >
        {needsVerify || me?.needsVerification ? <VerifyPrompt action="live" /> : null}
        <TextField label="Go live about…" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        <Select label="Who can watch" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value)}>
          <option value="public">Everyone</option>
          <option value="followers">Followers</option>
          <option value="friends">Friends</option>
        </Select>
        {tickets.length ? (
          <Select label="Ticket" value={ticketId} onChange={(e) => setTicketId(e.currentTarget.value)} hint="Only people who bought this ticket can watch.">
            <option value="">Free to watch</option>
            {tickets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {formatMoney(p.priceCents, p.currency, locale)}
              </option>
            ))}
          </Select>
        ) : null}
        <Button type="submit" disabled={!title.trim()}>
          Set up live
        </Button>
      </form>
      {items === null ? (
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
                  {l.status === 'live' ? <Badge tone="danger">Live · {l.viewers}</Badge> : <Badge tone="neutral">Scheduled</Badge>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nobody's live right now" />
      )}
    </div>
  );
}
