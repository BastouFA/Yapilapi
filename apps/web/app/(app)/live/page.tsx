'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, EmptyState, Select, Skeleton, TextField } from '@yapilapi/design-system';
import type { LiveSummary } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

export default function LiveList() {
  const { flags, toast } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<LiveSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState('public');

  useEffect(() => {
    if (flags.LIVE === false) return;
    api.live.list().then(
      (r) => setItems(r.items),
      (e) => (setItems([]), toast(errorMessage(e))),
    );
  }, [flags.LIVE, toast]);

  if (flags.LIVE === false) return <EmptyState title="Live isn't available yet" body="It's being rolled out gradually." />;

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
            const r = await api.live.create({ title, visibility });
            sessionStorage.setItem(`ypl-ingest-${r.live.id}`, JSON.stringify(r.ingest));
            router.push(`/live/${r.live.id}`);
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <TextField label="Go live about…" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        <Select label="Who can watch" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value)}>
          <option value="public">Everyone</option>
          <option value="followers">Followers</option>
          <option value="friends">Friends</option>
        </Select>
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
