'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Select, TextField } from '@yapilapi/design-system';
import type { AdminContentItem } from '@yapilapi/api-client';
import { ADMIN_CONTENT_KINDS, formatRelativeTime, type AdminContentKind, type MessageKey } from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';
import { Choice, LoadFailed, Loading } from './shared';

const KINDS: Record<AdminContentKind, MessageKey> = {
  post: 'admin.content.kind.post',
  reel: 'admin.content.kind.reel',
  comment: 'admin.content.kind.comment',
  listing: 'admin.content.kind.listing',
  community: 'admin.content.kind.community',
  event: 'admin.content.kind.event',
};

type Status = 'all' | 'visible' | 'removed';

/**
 * Everything people post, newest first: search it, open it, remove it (the author is told and can
 * appeal, as with a moderation decision) or restore what was removed.
 */
export function Content() {
  const { t, toast } = useSession();
  const [kind, setKind] = useState<AdminContentKind>('post');
  const [status, setStatus] = useState<Status>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AdminContentItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<AdminContentItem | null>(null);

  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    api.admin.content({ kind, q: query, status }).then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [kind, query, status, attempt]);

  const more = async () => {
    if (!cursor) return;
    try {
      const r = await api.admin.content({ kind, q: query, status, cursor });
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const patch = (id: string, change: Partial<AdminContentItem>) => setItems((cur) => cur?.map((x) => (x.id === id ? { ...x, ...change } : x)) ?? cur);
  const restore = async (it: AdminContentItem) => {
    try {
      await api.admin.restoreContent(it.kind, it.id);
      patch(it.id, { removed: false, moderationStatus: 'normal' });
      toast(t('admin.content.restored'));
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <div className="stack">
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <div style={{ minWidth: 160 }}>
          <Select label={t('admin.content.kind')} value={kind} onChange={(e) => setKind(e.currentTarget.value as AdminContentKind)}>
            {ADMIN_CONTENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KINDS[k])}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <TextField label={t('admin.content.search')} type="search" value={q} onChange={(e) => setQ(e.currentTarget.value)} maxLength={100} />
        </div>
        <Button type="submit" style={{ alignSelf: 'flex-end' }}>
          {t('admin.people.find')}
        </Button>
      </form>
      <Choice<Status>
        label={t('admin.content.show')}
        value={status}
        onChange={setStatus}
        options={[
          { id: 'all', label: t('admin.content.all') },
          { id: 'visible', label: t('admin.content.visible') },
          { id: 'removed', label: t('admin.content.removedFilter') },
        ]}
      />
      {error ? (
        <LoadFailed error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : items === null ? (
        <Loading />
      ) : !items.length ? (
        <EmptyState title={t('admin.content.none')} />
      ) : (
        <ul className="admin-list">
          {items.map((it) => (
            <ContentRow key={it.id} it={it} onRemove={() => setRemoving(it)} onRestore={() => restore(it)} />
          ))}
        </ul>
      )}
      {cursor && items?.length ? (
        <Button variant="secondary" onClick={more}>
          {t('admin.loadMore')}
        </Button>
      ) : null}
      <RemoveDialog item={removing} onClose={() => setRemoving(null)} onRemoved={(it) => patch(it.id, { removed: true, moderationStatus: 'removed' })} />
    </div>
  );
}

/** Asks why before removing (the reason is kept with the case and in the audit log), then removes it. */
export function RemoveDialog({
  item,
  onClose,
  onRemoved,
}: {
  item: Pick<AdminContentItem, 'kind' | 'id' | 'text'> | null;
  onClose: () => void;
  onRemoved: (item: Pick<AdminContentItem, 'kind' | 'id'>) => void;
}) {
  const { t, toast } = useSession();
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [item?.id]);
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title={t('admin.content.removeTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const it = item!;
              onClose();
              try {
                await api.admin.removeContent(it.kind, it.id, reason.trim());
                onRemoved(it);
                toast(t('admin.content.removed'));
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {t('admin.decision.remove')}
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <p style={{ margin: 0 }}>{t('admin.content.removeBody')}</p>
        {item?.text ? <blockquote className="admin-quote">{item.text}</blockquote> : null}
        <TextField
          label={t('admin.content.reason')}
          hint={t('admin.content.reasonHint')}
          multiline
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          maxLength={2000}
        />
      </div>
    </Dialog>
  );
}

/** One thing: its text, who posted it and when, its state, and what can be done to it. */
export function ContentRow({ it, onRemove, onRestore }: { it: AdminContentItem; onRemove: () => void; onRestore: () => void }) {
  const { t, locale } = useSession();
  return (
    <li className="admin-list__item">
      <div className="row" style={{ alignItems: 'baseline' }}>
        {it.author ? (
          <Link href={`/admin/users/${it.author.id}`}>
            {it.author.displayName} <span className="muted">@{it.author.username}</span>
          </Link>
        ) : (
          <span className="muted">{t('admin.case.unknownAccount')}</span>
        )}
        <span className="muted">{formatRelativeTime(it.createdAt, locale)}</span>
        {it.removed ? <Badge tone="danger">{t('admin.content.removedBadge')}</Badge> : null}
        {it.deletedByOwner ? <Badge tone="neutral">{t('admin.content.deletedByOwner')}</Badge> : null}
        {!it.removed && it.moderationStatus === 'restricted' ? <Badge tone="warning">{t('admin.decision.restrict')}</Badge> : null}
        {!it.removed && it.moderationStatus === 'review' ? <Badge tone="warning">{t('admin.content.inReview')}</Badge> : null}
      </div>
      <p className="admin-list__text">{it.text || t('admin.case.noPreview')}</p>
      <div className="row">
        {it.href && !it.removed && !it.deletedByOwner ? (
          <Link href={it.href} target="_blank" rel="noopener">
            {t('admin.case.openIt')}
          </Link>
        ) : null}
        {it.deletedByOwner ? null : it.removed ? (
          <Button size="sm" variant="secondary" onClick={onRestore}>
            {t('admin.content.restore')}
          </Button>
        ) : (
          <Button size="sm" variant="danger" onClick={onRemove}>
            {t('admin.decision.remove')}
          </Button>
        )}
      </div>
    </li>
  );
}
