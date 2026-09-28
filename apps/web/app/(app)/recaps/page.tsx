'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import { recapErrorText, type MessageKey, type Recap } from '@yapilapi/shared';
import { api, ApiError, errorMessage, isGone } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { RECAP_STATUS_LABEL, RecapPostForm, RecapSendSheet, clipLength, downloadRecap, isPending } from '@/components/Recaps';
import { useRealtime, useSession } from '../../providers';

const STATUS_TONE = { queued: 'neutral', rendering: 'neutral', ready: 'success', failed: 'danger' } as const;

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

function statusLine(r: Recap, t: T): string {
  if (r.status === 'failed') {
    const error = recapErrorText(r, t);
    return error ? t('recaps.statusFailedError', { error }) : t(RECAP_STATUS_LABEL.failed);
  }
  if (r.status === 'ready') {
    const len = clipLength(r.durationMs);
    return len ? t('recaps.statusReadyLength', { length: len }) : t(RECAP_STATUS_LABEL.ready);
  }
  return t(RECAP_STATUS_LABEL[r.status]);
}

function sourceLabel(r: Recap, t: T): string {
  return t(
    r.source === 'on_this_day'
      ? 'm.recap.onThisDay'
      : r.source === 'chapter'
        ? 'recaps.source.chapter'
        : r.source === 'together'
          ? 'recaps.source.together'
          : 'recaps.source.memory',
  );
}

function Recaps() {
  const { flags, toast, locale, t, tp } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('open');
  const [items, setItems] = useState<Recap[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [off, setOff] = useState(false);
  const [missing, setMissing] = useState(false);
  // Why the linked recap couldn't load, when that isn't because it's gone; Try again asks again.
  const [openError, setOpenError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

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
    if (flags.MEMORY === false && flags.REAL_TOGETHER === false) return;
    void load();
  }, [load, flags.MEMORY, flags.REAL_TOGETHER]);

  // A recap opened from a link or a notification may not be in the list yet (or may be gone).
  const loaded = items !== null;
  const listed = !!openId && !!items?.some((r) => r.id === openId);
  useEffect(() => {
    setMissing(false);
    setOpenError(null);
    if (!openId || !loaded || listed) return;
    let live = true;
    api.recaps.get(openId).then(
      ({ recap }) => live && setItems((cur) => (cur && !cur.some((r) => r.id === recap.id) ? [recap, ...cur] : cur)),
      (e) => live && (isGone(e) ? setMissing(true) : setOpenError(errorMessage(e))),
    );
    return () => {
      live = false;
    };
  }, [openId, loaded, listed, attempt]);

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

  // Recaps come from Memories and Chapters, and from Together albums.
  if ((flags.MEMORY === false && flags.REAL_TOGETHER === false) || off) return <FeatureOff name={t('m.recap.title')} />;

  const current = openId ? (items?.find((r) => r.id === openId) ?? null) : null;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.recap.yours')}</h1>
        <Link href="/memories" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('memories.title')}
        </Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('recaps.intro')}
        {remaining !== null ? ` ${tp('m.recap.remaining', remaining)}` : ''}
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
          {t('recaps.missing')}
        </p>
      ) : openId && openError ? (
        <p className="muted row" role="status">
          {openError}
          <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            {t('m.common.retry')}
          </Button>
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
                    <img src={r.video.posterUrl} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <Icon name={r.status === 'failed' ? 'alert' : isPending(r) ? 'sparkle' : 'play'} size={20} />
                  )}
                </span>
                <span className="recap-row__text">
                  <bdi className="recap-row__title">{r.title}</bdi>
                  <span className="recap-row__meta">
                    {sourceLabel(r, t)} · {new Date(r.createdAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}
                  </span>
                  <span className="recap-row__status">
                    <Badge tone={STATUS_TONE[r.status]}>{t(RECAP_STATUS_LABEL[r.status])}</Badge>
                    {r.status === 'failed' && recapErrorText(r, t) ? <span className="muted">{recapErrorText(r, t)}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title={t('recaps.emptyTitle')}
          body={t('recaps.emptyBody')}
          action={
            <Link href="/recaps/new?source=on_this_day" className="yp-btn yp-btn--secondary">
              {t('recaps.emptyAction')}
            </Link>
          }
        />
      )}
    </div>
  );
}

function RecapDetail({ recap: r, onClose, onDeleted }: { recap: Recap; onClose: () => void; onDeleted: () => void }) {
  const { toast, t, tp } = useSession();
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
        <button type="button" className="recap-tool" aria-label={t('m.common.close')} onClick={onClose}>
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
          aria-label={t('recaps.videoLabel', { title: r.title })}
        />
      ) : (
        <div className="recap-video recap-video--waiting" style={{ aspectRatio: r.aspect === '1:1' ? '1 / 1' : '9 / 16' }} role="status">
          {r.status === 'failed' ? (
            <>
              <Icon name="alert" size={28} />
              <strong>{t(RECAP_STATUS_LABEL.failed)}</strong>
              {recapErrorText(r, t) ? <span>{recapErrorText(r, t)}</span> : null}
            </>
          ) : (
            <>
              <Icon name="sparkle" size={28} />
              <strong>{t(RECAP_STATUS_LABEL[r.status])}</strong>
              <span>{t('recaps.makingBody')}</span>
            </>
          )}
        </div>
      )}

      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {statusLine(r, t)} · {tp('m.recap.itemCount', r.itemCount)}
        {r.sound ? (
          <>
            {' · '}
            <bdi>{r.sound.title}</bdi>
          </>
        ) : null}
      </p>
      {left > 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {tp('recaps.leftOut', left)}
        </p>
      ) : null}

      {r.status === 'ready' && r.video ? (
        <div className="stack-sm">
          <div className="row">
            <Button icon="download" variant="secondary" onClick={() => downloadRecap(r)}>
              {t('m.shop.download')}
            </Button>
            {r.canPost && !postedId ? (
              <Button variant="secondary" icon="play" aria-expanded={posting} onClick={() => setPosting((v) => !v)}>
                {t('m.recap.postReel')}
              </Button>
            ) : null}
            {r.canSend ? (
              <Button variant="secondary" icon="send" onClick={() => setSending(true)}>
                {t('m.recap.send')}
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
              {t('recaps.posted')} <Link href={`/reels?start=${postedId}`}>{t('recaps.seeReel')}</Link>
            </p>
          ) : null}
          {!r.canPost ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {t('recaps.cantPost')}
            </p>
          ) : null}
          {!r.canSend ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {t('recaps.cantSend')}
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
            if (!confirm(t(isPending(r) ? 'recaps.confirmStop' : 'recaps.confirmDelete'))) return;
            setDeleting(true);
            try {
              const res = await api.recaps.remove(r.id);
              toast(t(res.fileRemoved ? 'm.recap.deleted' : 'm.recap.deletedKept'));
              onDeleted();
            } catch (e) {
              toast(errorMessage(e));
              setDeleting(false);
            }
          }}
        >
          {t(isPending(r) ? 'recaps.stopAndDelete' : 'm.common.delete')}
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
