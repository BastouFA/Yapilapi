'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AIPanel, Avatar, BottomSheet, Button, Checkbox, EmptyState, EventCard, Icon, PostCard, Skeleton } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../../providers';

export default function MemoryPage() {
  const { id } = useParams<{ id: string }>();
  const { me, toast, locale, flags, t, tp } = useSession();
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

  if (missing) return <EmptyState title={t('memories.notFound')} />;
  if (!data) return <Skeleton height={240} />;
  const m = data.memory;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{m.title}</h1>
        <div className="row">
          {m.mine ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  if (me) setFriends((await api.raw.get<{ items: PublicUser[] }>(`/v1/users/${me.id}/friends`)).items);
                  setSharing(true);
                }}
              >
                {m.visibility === 'private' ? t('m.common.share') : t('memories.sharing')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api.memories.remove(id);
                  router.push('/memories');
                }}
              >
                {t('m.common.delete')}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {flags.MEMORY !== false ? (
        <div className="recap-cta">
          <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <strong>{t('m.recap.make')}</strong>
            <span className="muted">{t('memories.recapHint')}</span>
          </span>
          <Link href={`/recaps/new?source=memory&sourceId=${id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
            <Icon name="play" size={16} />
            {t('memories.makeOne')}
          </Link>
        </div>
      ) : null}

      {m.recap || m.mine ? (
        <AIPanel
          title={t('memories.recapTitle')}
          loading={recapping}
          notice={t('memories.recapNotice')}
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
                {m.recap ? t('memories.recapRewrite') : t('memories.recapWrite')}
              </Button>
            ) : null
          }
        >
          {m.recap ?? t('memories.recapNone')}
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
      {data.hiddenItems ? <p className="muted">{tp('memories.hiddenItems', data.hiddenItems)}</p> : null}
      {!data.posts.length && !data.events.length && !data.moments.length ? (
        <EmptyState title={t('m.feed.empty.title')} body={t('memories.emptyItems')} />
      ) : null}

      <BottomSheet open={sharing} onClose={() => setSharing(false)} title={t('memories.shareTitle')}>
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
            <p className="muted">{t('memories.noFriends')}</p>
          )}
          <Button
            onClick={async () => {
              try {
                const r = await api.memories.share(id, [...picked]);
                toast(r.visibility === 'private' ? t('memories.nowPrivate') : t('memories.nowShared'));
                setSharing(false);
                await load();
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {picked.size ? tp('memories.shareWith', picked.size) : t('memories.keepPrivate')}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
