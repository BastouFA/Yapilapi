'use client';

import { FeatureOff } from '@/components/FeatureOff';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Checkbox, EmptyState, TextField } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

export default function TogetherList() {
  const { flags, me, toast } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.together.list>>['items']>([]);
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (!flags.REAL_TOGETHER || !me) return;
    api.together.list().then(
      (r) => setItems(r.items),
      () => {},
    );
    api.raw.get<{ items: PublicUser[] }>(`/v1/users/${me.id}/friends`).then(
      (r) => setFriends(r.items),
      () => {},
    );
  }, [flags.REAL_TOGETHER, me]);

  if (!flags.REAL_TOGETHER) return <FeatureOff name="Real Together" />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Together</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        One moment, everyone's view. Friends at the same place add what they see, and only the people in it can look.
      </p>
      <form
        className="stack-sm yp-card"
        style={{ padding: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.together.create({ title, memberIds: [...picked] });
            router.push(`/together/${r.together.id}`);
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <TextField label="What's the moment?" placeholder="Saturday football" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        {friends.length ? (
          <div className="stack-sm">
            <span className="yp-field__label">Invite friends</span>
            {friends.map((f) => (
              <Checkbox
                key={f.id}
                label={
                  <span className="row">
                    <Avatar name={f.displayName} src={f.avatarUrl} size="sm" /> {f.displayName}
                  </span>
                }
                checked={picked.has(f.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setPicked((s) => {
                    const n = new Set(s);
                    if (on) n.add(f.id);
                    else n.delete(f.id);
                    return n;
                  });
                }}
              />
            ))}
          </div>
        ) : (
          <p className="muted">Add friends first to invite them.</p>
        )}
        <Button type="submit" disabled={!title.trim()}>
          Start a Together
        </Button>
      </form>
      {items.map((t) => (
        <Link key={t.id} href={`/together/${t.id}`} className="yp-ccard">
          <h3 className="yp-ccard__title">{t.title}</h3>
          <span className="yp-ccard__meta">
            {t.contributions} perspectives · {t.members} people {t.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
          </span>
        </Link>
      ))}
    </div>
  );
}
