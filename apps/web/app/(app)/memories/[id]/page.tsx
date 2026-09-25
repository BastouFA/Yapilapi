'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AIPanel, Avatar, BottomSheet, Button, Checkbox, EmptyState, EventCard, PostCard, Skeleton } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../../providers';

export default function MemoryPage() {
  const { id } = useParams<{ id: string }>();
  const { me, toast, locale } = useSession();
  const router = useRouter();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.memories.get>> | null>(null);
  const [missing, setMissing] = useState(false);
  const [recapping, setRecapping] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = () => api.memories.get(id).then(setData, () => setMissing(true));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (missing) return <EmptyState title="Memory not found" />;
  if (!data) return <Skeleton height={240} />;
  const m = data.memory;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{m.title}</h1>
        {m.mine ? (
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                if (me) setFriends((await api.raw.get<{ items: PublicUser[] }>(`/v1/users/${me.id}/friends`)).items);
                setSharing(true);
              }}
            >
              {m.visibility === 'private' ? 'Share' : 'Sharing'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api.memories.remove(id);
                router.push('/memories');
              }}
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      {m.recap || m.mine ? (
        <AIPanel
          title="Recap"
          loading={recapping}
          notice="Written from the posts in this memory that you can see. You decide whether to share it."
          actions={
            m.mine ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  setRecapping(true);
                  try {
                    await api.memories.recap(id);
                    await load();
                  } catch (e) {
                    toast(errorMessage(e));
                  } finally {
                    setRecapping(false);
                  }
                }}
              >
                {m.recap ? 'Write a new recap' : 'Write a recap'}
              </Button>
            ) : null
          }
        >
          {m.recap ?? 'No recap yet.'}
        </AIPanel>
      ) : null}

      {data.events.map((e) => (
        <EventCard key={e.id} event={e} linkAs={NextLink} locale={locale} />
      ))}
      {data.moments.map((mo) => (
        <figure key={mo.id} style={{ margin: 0 }}>
          {mo.media_url && mo.media_kind === 'image' ? <img src={mo.media_url} alt="" style={{ borderRadius: 8 }} /> : null}
          {mo.body ? <figcaption>{mo.body}</figcaption> : null}
        </figure>
      ))}
      {data.posts.map((p) => (
        <PostCard key={p.id} post={p} locale={locale} linkAs={NextLink} />
      ))}
      {data.hiddenItems ? <p className="muted">{data.hiddenItems} items aren't visible to you anymore.</p> : null}
      {!data.posts.length && !data.events.length && !data.moments.length ? (
        <EmptyState title="Nothing here yet" body="Add posts to this memory from the post menu, or create a memory from an event." />
      ) : null}

      <BottomSheet open={sharing} onClose={() => setSharing(false)} title="Share with friends">
        <div className="stack-sm">
          {friends.length ? (
            friends.map((f) => (
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
            ))
          ) : (
            <p className="muted">You can share memories with friends. Add friends from their profiles.</p>
          )}
          <Button
            onClick={async () => {
              try {
                const r = await api.memories.share(id, [...picked]);
                toast(r.visibility === 'private' ? 'Memory is private' : 'Memory shared');
                setSharing(false);
                await load();
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {picked.size ? `Share with ${picked.size}` : 'Keep private'}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
