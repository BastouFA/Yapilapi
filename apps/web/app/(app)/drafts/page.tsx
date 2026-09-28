'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, EmptyState, formatScheduled, PostCard, Skeleton, TextField } from '@yapilapi/design-system';
import { noticeText, SCHEDULE_MAX_DAYS, SCHEDULE_MIN_MINUTES, type Post } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { localInput, nextHour, scheduleBounds } from '@/lib/schedule';
import { useSession } from '../../providers';

/**
 * Your drafts and scheduled posts, only ever seen by you. Scheduled posts come
 * first, soonest first. Continue a draft in Create, publish it now, schedule it,
 * move or cancel a scheduled post, or delete it.
 */
export default function DraftsPage() {
  const { t, toast, locale } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [timing, setTiming] = useState<Post | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    api.drafts.list().then(
      (r) => setItems(r.items),
      (e) => {
        setItems([]);
        toast(errorMessage(e));
      },
    );
  }, [toast]);

  const replace = (post: Post) => setItems((cur) => cur?.map((x) => (x.id === post.id ? post : x)) ?? cur);
  const drop = (id: string) => {
    setItems((cur) => cur?.filter((x) => x.id !== id) ?? cur);
    // Its buttons go with it: focus goes to the page title rather than nowhere.
    requestAnimationFrame(() => heading.current?.focus());
  };

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  // Soonest first, as the API lists them; a post just scheduled or moved takes its place.
  const scheduled = (items?.filter((p) => p.status === 'scheduled') ?? []).sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
  const drafts = items?.filter((p) => p.status !== 'scheduled') ?? [];

  const card = (p: Post) => (
    <div key={p.id} className="stack-sm">
      <PostCard post={p} locale={locale} linkAs={NextLink} />
      <div className="row">
        <Link href={`/create?draft=${p.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('m.drafts.continue')}
        </Link>
        <Button
          size="sm"
          loading={busy === `publish-${p.id}`}
          disabled={!!busy}
          onClick={() =>
            run(`publish-${p.id}`, async () => {
              const r = await api.drafts.publish(p.id);
              drop(p.id);
              toast(noticeText(r.moderation, t) ?? t('create.published'));
            })
          }
        >
          {t('m.drafts.publishNow')}
        </Button>
        <Button size="sm" variant="ghost" icon="calendar" disabled={!!busy} onClick={() => setTiming(p)}>
          {t(p.status === 'scheduled' ? 'm.drafts.changeTime' : 'm.create.schedule')}
        </Button>
        {p.status === 'scheduled' ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === `cancel-${p.id}`}
            disabled={!!busy}
            onClick={() =>
              run(`cancel-${p.id}`, async () => {
                replace((await api.drafts.unschedule(p.id)).post);
                toast(t('m.drafts.unscheduled'));
              })
            }
          >
            {t('m.drafts.cancelSchedule')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          loading={busy === `delete-${p.id}`}
          disabled={!!busy}
          onClick={() => {
            if (!confirm(t('m.drafts.deleteConfirm'))) return;
            void run(`delete-${p.id}`, async () => {
              await api.drafts.remove(p.id);
              drop(p.id);
              toast(t('m.drafts.deleted'));
            });
          }}
        >
          {t('m.common.delete')}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1 ref={heading} tabIndex={-1}>
          {t('m.drafts.title')}
        </h1>
        <Link href="/create" className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('drafts.newPost')}
        </Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('m.drafts.intro')}
      </p>
      {items === null ? (
        <Skeleton height={200} />
      ) : !items.length ? (
        <EmptyState title={t('drafts.emptyTitle')} body={t('drafts.emptyBody')} />
      ) : (
        <>
          {scheduled.length ? (
            <section className="stack" aria-labelledby="scheduled-heading">
              <h2 id="scheduled-heading" style={{ margin: 0 }}>
                {t('m.drafts.scheduled')}
              </h2>
              {scheduled.map(card)}
            </section>
          ) : null}
          {drafts.length ? (
            <section className="stack" aria-labelledby="drafts-heading">
              <h2 id="drafts-heading" style={{ margin: 0 }}>
                {t('m.drafts.title')}
              </h2>
              {drafts.map(card)}
            </section>
          ) : null}
        </>
      )}
      {timing ? (
        <ScheduleSheet
          post={timing}
          onClose={() => setTiming(null)}
          onDone={(post) => {
            replace(post);
            setTiming(null);
            if (post.scheduledAt) toast(t('m.drafts.scheduledFor', { time: formatScheduled(post.scheduledAt, locale) }));
          }}
        />
      ) : null}
    </div>
  );
}

function ScheduleSheet({ post, onClose, onDone }: { post: Post; onClose: () => void; onDone: (p: Post) => void }) {
  const [when, setWhen] = useState(() => (post.scheduledAt ? localInput(new Date(post.scheduledAt)) : nextHour()));
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { t } = useSession();
  return (
    <BottomSheet open onClose={onClose} title={t(post.status === 'scheduled' ? 'drafts.changeTheTime' : 'drafts.scheduleThis')}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const at = new Date(when);
          if (Number.isNaN(at.getTime())) return setError(t('compose.chooseDateTime'));
          setBusy(true);
          setError(undefined);
          try {
            onDone((await api.drafts.schedule(post.id, at.toISOString())).post);
          } catch (err) {
            setError(fieldErrors(err).scheduledAt ?? errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={t('compose.publishOn')}
          type="datetime-local"
          value={when}
          {...scheduleBounds()}
          hint={t('compose.scheduleHint', { minutes: SCHEDULE_MIN_MINUTES, days: SCHEDULE_MAX_DAYS })}
          error={error}
          onChange={(e) => setWhen(e.currentTarget.value)}
        />
        <Button type="submit" loading={busy} disabled={!when}>
          {t('m.create.schedule')}
        </Button>
      </form>
    </BottomSheet>
  );
}
