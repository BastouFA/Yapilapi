'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import type { Recap } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { RECAP_STATUS_LABEL, RecapPostForm, RecapSendSheet, clipLength, downloadRecap, isPending } from '@/components/Recaps';
import { useRealtime, useSession } from '../../providers';

const STATUS_TONE = { queued: 'neutral', rendering: 'neutral', ready: 'success', failed: 'danger' } as const;

function statusLine(r: Recap): string {
  if (r.status === 'failed') return r.error ? `${RECAP_STATUS_LABEL.failed}. ${r.error}` : RECAP_STATUS_LABEL.failed;
  if (r.status === 'ready') {
    const len = clipLength(r.durationMs);
    return len ? `${RECAP_STATUS_LABEL.ready} · ${len}` : RECAP_STATUS_LABEL.ready;
  }
  return RECAP_STATUS_LABEL[r.status];
}

function sourceLabel(r: Recap): string {
  return r.source === 'on_this_day' ? 'On this day' : r.source === 'chapter' ? 'From a chapter' : 'From a memory';
}

function Recaps() {
  const { flags, toast, locale } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('open');
  const [items, setItems] = useState<Recap[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [off, setOff] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.recaps.list();
      setItems(r.items);
      setRemaining(r.remainingToday);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'feature_disabled') setOff(true);
      else toast(errorMessage(e));
      setItems((cur) => cur ?? []);
    }
  }, [toast]);

  useEffect(() => {
    if (flags.MEMORY === false) return;
    void load();
  }, [load, flags.MEMORY]);

  // A recap opened from a link or a notification may not be in the list yet (or may be gone).
  const loaded = items !== null;
  const listed = !!openId && !!items?.some((r) => r.id === openId);
  useEffect(() => {
    setMissing(false);
    if (!openId || !loaded || listed) return;
    let live = true;
    api.recaps.get(openId).then(
      ({ recap }) => live && setItems((cur) => (cur && !cur.some((r) => r.id === recap.id) ? [recap, ...cur] : cur)),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [openId, loaded, listed]);

  // While any is waiting or being made, check on those every 2 seconds.
  const pendingIds = (items ?? [])
    .filter(isPending)
    .map((r) => r.id)
    .join(',');
  useEffect(() => {
    if (!pendingIds) return;
    const timer = setInterval(async () => {
      const ids = pendingIds.split(',');
      const fresh = await Promise.all(
        ids.map((id) =>
          api.recaps
            .get(id)
            .then((r) => r.recap)
            .catch(() => null),
        ),
      );
      setItems((cur) => cur?.map((r) => fresh.find((f) => f?.id === r.id) ?? r) ?? cur);
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingIds]);

  useRealtime((e) => {
    if (e.type === 'notification.created' && (e.data?.type === 'recap_ready' || e.data?.type === 'recap_failed')) void load();
  });

  const open = (id: string | null) => router.replace(id ? `/recaps?open=${id}` : '/recaps', { scroll: false });

  if (flags.MEMORY === false || off) return <FeatureOff name="Recap videos" />;

  const current = openId ? (items?.find((r) => r.id === openId) ?? null) : null;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Your recaps</h1>
        <Link href="/memories" className="yp-btn yp-btn--ghost yp-btn--sm">
          Memories
        </Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Short videos made from your memories, chapters and On this day. Only you see them until you share one.
        {remaining !== null ? ` You can make ${remaining} more ${remaining === 1 ? 'recap' : 'recaps'} today.` : ''}
      </p>

      {current ? (
        <RecapDetail
          key={current.id}
          recap={current}
          onClose={() => open(null)}
          onDeleted={() => {
            setItems((cur) => cur?.filter((r) => r.id !== current.id) ?? cur);
            open(null);
          }}
        />
      ) : openId && missing ? (
        <p className="muted" role="status">
          That recap isn&apos;t available anymore.
        </p>
      ) : null}

      {items === null ? (
        <Skeleton height={240} />
      ) : items.length ? (
        <ul className="recap-list">
          {items.map((r) => (
            <li key={r.id}>
              <button type="button" className="recap-row" aria-current={r.id === openId || undefined} onClick={() => open(r.id)}>
                <span className={`recap-row__poster${r.aspect === '1:1' ? ' recap-row__poster--square' : ''}`}>
                  {r.video?.posterUrl ? (
                    <img src={r.video.posterUrl} alt="" loading="lazy" />
                  ) : (
                    <Icon name={r.status === 'failed' ? 'alert' : isPending(r) ? 'sparkle' : 'play'} size={20} />
                  )}
                </span>
                <span className="recap-row__text">
                  <bdi className="recap-row__title">{r.title}</bdi>
                  <span className="recap-row__meta">
                    {sourceLabel(r)} · {new Date(r.createdAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}
                  </span>
                  <span className="recap-row__status">
                    <Badge tone={STATUS_TONE[r.status]}>{RECAP_STATUS_LABEL[r.status]}</Badge>
                    {r.status === 'failed' && r.error ? <span className="muted">{r.error}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No recaps yet"
          body="Open a memory or one of your chapters and choose Make a recap video, or make one from On this day."
          action={
            <Link href="/recaps/new?source=on_this_day" className="yp-btn yp-btn--secondary">
              Make one from On this day
            </Link>
          }
        />
      )}
    </div>
  );
}

function RecapDetail({ recap: r, onClose, onDeleted }: { recap: Recap; onClose: () => void; onDeleted: () => void }) {
  const { toast } = useSession();
  const heading = useRef<HTMLHeadingElement>(null);
  const [posting, setPosting] = useState(false);
  const [postedId, setPostedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const ratio = r.video?.width && r.video?.height ? `${r.video.width} / ${r.video.height}` : r.aspect === '1:1' ? '1 / 1' : '9 / 16';
  const tall = r.video?.width && r.video?.height ? r.video.height > r.video.width : r.aspect !== '1:1';
  const left = r.status === 'ready' && r.usedCount !== null ? r.itemCount - r.usedCount : 0;

  return (
    <section className="recap-detail yp-card" aria-labelledby="recap-detail-title">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <h2 id="recap-detail-title" className="section-title" tabIndex={-1} ref={heading} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <bdi>{r.title}</bdi>
        </h2>
        <button type="button" className="recap-tool" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      </div>

      {r.status === 'ready' && r.video ? (
        <video
          className={`recap-video recap-video--${tall ? 'tall' : 'square'}`}
          style={{ aspectRatio: ratio }}
          src={r.video.url}
          poster={r.video.posterUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
          aria-label={`Recap video: ${r.title}`}
        />
      ) : (
        <div className="recap-video recap-video--waiting" style={{ aspectRatio: r.aspect === '1:1' ? '1 / 1' : '9 / 16' }} role="status">
          {r.status === 'failed' ? (
            <>
              <Icon name="alert" size={28} />
              <strong>{RECAP_STATUS_LABEL.failed}</strong>
              {r.error ? <span>{r.error}</span> : null}
            </>
          ) : (
            <>
              <Icon name="sparkle" size={28} />
              <strong>{RECAP_STATUS_LABEL[r.status]}</strong>
              <span>This usually takes a minute or two. You can leave this page; we&apos;ll let you know when it&apos;s ready.</span>
            </>
          )}
        </div>
      )}

      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {statusLine(r)} · {r.itemCount === 1 ? '1 photo or video' : `${r.itemCount} photos and videos`}
        {r.sound ? (
          <>
            {' · '}
            <bdi>{r.sound.title}</bdi>
          </>
        ) : null}
      </p>
      {left > 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {left === 1 ? '1 was left out because you can’t see it anymore.' : `${left} were left out because you can’t see them anymore.`}
        </p>
      ) : null}

      {r.status === 'ready' && r.video ? (
        <div className="stack-sm">
          <div className="row">
            <Button icon="download" variant="secondary" onClick={() => downloadRecap(r)}>
              Download
            </Button>
            {r.canPost && !postedId ? (
              <Button variant="secondary" icon="play" aria-expanded={posting} onClick={() => setPosting((v) => !v)}>
                Post as reel
              </Button>
            ) : null}
            {r.canSend ? (
              <Button variant="secondary" icon="send" onClick={() => setSending(true)}>
                Send in a chat
              </Button>
            ) : null}
          </div>
          {posting && !postedId ? (
            <RecapPostForm
              recap={r}
              onCancel={() => setPosting(false)}
              onDone={(id) => {
                setPosting(false);
                setPostedId(id);
              }}
            />
          ) : null}
          {postedId ? (
            <p className="muted" style={{ margin: 0 }} role="status">
              Posted. <Link href={`/reels?start=${postedId}`}>See your reel</Link>
            </p>
          ) : null}
          {!r.canPost ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              This recap has photos or videos from other people, so it can&apos;t be posted.
            </p>
          ) : null}
          {!r.canSend ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              This recap has photos or videos from other people, so it can&apos;t be sent in a chat.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        <Button
          variant="ghost"
          icon="trash"
          loading={deleting}
          onClick={async () => {
            if (!confirm(isPending(r) ? 'Stop making this recap video and delete it?' : 'Delete this recap video?')) return;
            setDeleting(true);
            try {
              const res = await api.recaps.remove(r.id);
              toast(res.fileRemoved ? 'Recap deleted' : 'Recap deleted. The video stays where you already shared it.');
              onDeleted();
            } catch (e) {
              toast(errorMessage(e));
              setDeleting(false);
            }
          }}
        >
          {isPending(r) ? 'Stop and delete' : 'Delete'}
        </Button>
      </div>

      {r.canSend ? <RecapSendSheet recap={r} open={sending} onClose={() => setSending(false)} /> : null}
    </section>
  );
}

export default function RecapsPage() {
  return (
    <Suspense>
      <Recaps />
    </Suspense>
  );
}
