'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BottomSheet, Button, EmptyState, formatScheduled, PostCard, Skeleton, TextField } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { localInput, nextHour, SCHEDULE_HINT, scheduleBounds } from '@/lib/schedule';
import { useSession } from '../../providers';

/**
 * Your drafts and scheduled posts, only ever seen by you. Scheduled posts come
 * first, soonest first. Continue a draft in Create, publish it now, schedule it,
 * move or cancel a scheduled post, or delete it.
 */
export default function DraftsPage() {
  const { toast, locale } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [timing, setTiming] = useState<Post | null>(null);

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
  const drop = (id: string) => setItems((cur) => cur?.filter((x) => x.id !== id) ?? cur);

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
          Continue
        </Link>
        <Button
          size="sm"
          loading={busy === `publish-${p.id}`}
          disabled={!!busy}
          onClick={() =>
            run(`publish-${p.id}`, async () => {
              const r = await api.drafts.publish(p.id);
              drop(p.id);
              toast(r.moderation ? r.moderation.message : 'Published');
            })
          }
        >
          Publish now
        </Button>
        <Button size="sm" variant="ghost" icon="calendar" disabled={!!busy} onClick={() => setTiming(p)}>
          {p.status === 'scheduled' ? 'Change time' : 'Schedule'}
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
                toast('Moved back to your drafts');
              })
            }
          >
            Cancel schedule
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          loading={busy === `delete-${p.id}`}
          disabled={!!busy}
          onClick={() => {
            if (!confirm('Delete this draft? This can’t be undone.')) return;
            void run(`delete-${p.id}`, async () => {
              await api.drafts.remove(p.id);
              drop(p.id);
              toast('Draft deleted');
            });
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Drafts</h1>
        <Link href="/create" className="yp-btn yp-btn--secondary yp-btn--sm">
          New post
        </Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Only you can see your drafts and scheduled posts. A scheduled post is published at its time, as a new post.
      </p>
      {items === null ? (
        <Skeleton height={200} />
      ) : !items.length ? (
        <EmptyState title="No drafts" body="Save a post as a draft or schedule it from Create, and it waits here." />
      ) : (
        <>
          {scheduled.length ? (
            <section className="stack" aria-labelledby="scheduled-heading">
              <h2 id="scheduled-heading" style={{ margin: 0 }}>
                Scheduled
              </h2>
              {scheduled.map(card)}
            </section>
          ) : null}
          {drafts.length ? (
            <section className="stack" aria-labelledby="drafts-heading">
              <h2 id="drafts-heading" style={{ margin: 0 }}>
                Drafts
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
            if (post.scheduledAt) toast(`Scheduled for ${formatScheduled(post.scheduledAt, locale)}`);
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
  return (
    <BottomSheet open onClose={onClose} title={post.status === 'scheduled' ? 'Change the time' : 'Schedule this post'}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const at = new Date(when);
          if (Number.isNaN(at.getTime())) return setError('Choose a date and time.');
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
          label="Publish on"
          type="datetime-local"
          value={when}
          {...scheduleBounds()}
          hint={SCHEDULE_HINT}
          error={error}
          onChange={(e) => setWhen(e.currentTarget.value)}
        />
        <Button type="submit" loading={busy} disabled={!when}>
          Schedule
        </Button>
      </form>
    </BottomSheet>
  );
}
