'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, AvatarGroup, Badge, Button, EmptyState, Skeleton, TextField } from '@yapilapi/design-system';
import type { TogetherDetail } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { Capture } from '@/components/Capture';
import { useRealtime, useSession } from '../../../providers';

export default function TogetherPage() {
  const { id } = useParams<{ id: string }>();
  const { toast, locale } = useSession();
  const [t, setT] = useState<TogetherDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [caption, setCaption] = useState('');
  const load = useCallback(
    () =>
      api.together.get(id).then(
        (r) => setT(r.together),
        () => setMissing(true),
      ),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if (e.type === 'together.contribution' && e.data.togetherId === id) void load();
  });

  if (missing) return <EmptyState title="This Together isn't available" />;
  if (!t) return <Skeleton height={240} />;

  async function add(files: File[]) {
    try {
      const { media } = await api.media.upload(files[0]!);
      setT((await api.together.contribute(id, media.id, caption)).together);
      setAdding(false);
      setCaption('');
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t.title}</h1>
        {t.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
      </div>
      <div className="row">
        <AvatarGroup>
          {t.members.map((m) => (
            <Avatar key={m.user.id} name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
          ))}
        </AvatarGroup>
        <span className="muted">{t.members.map((m) => m.user.displayName.split(' ')[0]).join(', ')}</span>
      </div>
      {t.status === 'open' ? (
        adding ? (
          <div className="stack-sm yp-card" style={{ padding: 16 }}>
            <TextField label="Caption (optional)" value={caption} onChange={(e) => setCaption(e.currentTarget.value)} maxLength={300} />
            <Capture onCaptured={add} />
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="row">
            <Button onClick={() => setAdding(true)}>Add your view</Button>
            {t.myRole === 'creator' ? (
              <Button variant="ghost" onClick={async () => setT((await api.together.close(id)).together)}>
                Close
              </Button>
            ) : null}
          </div>
        )
      ) : null}
      {t.contributions.length ? (
        <div className="yp-grid">
          {t.contributions.map((c) => (
            <figure key={c.id} className="yp-card" style={{ margin: 0, overflow: 'hidden' }}>
              {c.media ? (
                <img
                  src={c.media.url}
                  alt={c.media.altText ?? `Photo by ${c.author.displayName}`}
                  style={{ width: '100%', aspectRatio: '4 / 5', objectFit: 'cover' }}
                />
              ) : null}
              <figcaption style={{ padding: 12 }}>
                <strong>{c.author.displayName}</strong>
                <span className="muted"> · {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(c.capturedAt))}</span>
                {c.caption ? <div>{c.caption}</div> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <EmptyState title="No views yet" body="Add the first photo of the moment." />
      )}
    </div>
  );
}
