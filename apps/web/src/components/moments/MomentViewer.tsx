'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type Moment } from '@yapilapi/api-client';
import {
  Avatar,
  Button,
  CloseIcon,
  EmptyState,
  HeartIcon,
  IconButton,
  UserIcon,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';

const PHOTO_MS = 5000;

export function MomentViewer({ username }: { username: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const router = useRouter();
  usePageTitle(t('moments.title'), t('app.name'));

  const list = useAsync(
    (signal) => api.moments.byUser(username, { limit: 50, signal }),
    [api, username],
  );
  const [items, setItems] = useState<Moment[] | null>(null);
  useEffect(() => {
    if (list.data) setItems(list.data.items);
  }, [list.data]);

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [viewers, setViewers] = useState<{
    loading: boolean;
    items: Array<{ id: string; displayName: string; avatarUrl: string | null }>;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef(new Set<string>());
  const closeRef = useRef<HTMLButtonElement>(null);

  const current = items?.[index] ?? null;
  const isAuthor = current?.viewer.isAuthor ?? false;

  const close = useCallback(() => router.push('/'), [router]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, (items?.length ?? 1) - 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, items]);

  useEffect(() => {
    if (!current || !items) return;
    if (index >= items.length) {
      close();
      return;
    }
    if (!seen.current.has(current.id)) {
      seen.current.add(current.id);
      void api.moments.view(current.id).catch(() => undefined);
    }
    setProgress(0);
  }, [current, index, items, api, close]);

  // Auto-advance timer for non-video moments; paused while held or explicitly paused.
  useEffect(() => {
    if (!current || current.kind === 'video' || paused) return;
    const start = Date.now();
    const id = window.setInterval(() => {
      const pct = Math.min(100, ((Date.now() - start) / PHOTO_MS) * 100);
      setProgress(pct);
      if (pct >= 100) setIndex((i) => i + 1);
    }, 100);
    return () => window.clearInterval(id);
  }, [current, paused]);

  const react = async () => {
    if (!current) return;
    const wasLiked = current.viewer.reaction !== null;
    setItems((prev) =>
      prev
        ? prev.map((m) =>
            m.id === current.id
              ? { ...m, viewer: { ...m.viewer, reaction: wasLiked ? null : 'like' } }
              : m,
          )
        : prev,
    );
    try {
      if (wasLiked) await api.moments.unreact(current.id);
      else await api.moments.react(current.id, 'like');
    } catch {
      /* best-effort; not critical path */
    }
  };

  const loadViewers = async () => {
    if (!current) return;
    setViewers({ loading: true, items: [] });
    try {
      const r = await api.moments.viewers(current.id, { limit: 50 });
      setViewers({ loading: false, items: r.items });
    } catch {
      setViewers({ loading: false, items: [] });
    }
  };

  const doDelete = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await api.moments.delete(current.id);
      setConfirmDelete(false);
      setItems((prev) => (prev ? prev.filter((m) => m.id !== current.id) : prev));
    } catch {
      /* leave dialog open; the error state itself is enough context to retry or cancel */
    } finally {
      setBusy(false);
    }
  };

  if (list.loading) return <PageSpinner />;
  if (list.error) {
    if (list.error instanceof ApiError && list.error.status === 404) {
      return <EmptyState icon={<UserIcon size={28} />} title={t('moments.notFound')} />;
    }
    return <ErrorView error={list.error} onRetry={list.reload} />;
  }
  if (!items || items.length === 0) {
    return <EmptyState icon={<UserIcon size={28} />} title={t('moments.notFound')} />;
  }
  if (!current) return null;

  return (
    <div
      className="moment-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t('moments.title')}
      onPointerDown={() => setPaused(true)}
      onPointerUp={() => setPaused(false)}
    >
      <div className="moment-viewer__progress" aria-hidden="true">
        {items.map((m, i) => (
          <progress
            key={m.id}
            className="moment-viewer__bar"
            value={i < index ? 100 : i === index ? progress : 0}
            max={100}
          />
        ))}
      </div>
      <div className="moment-viewer__head">
        <Avatar
          name={current.author.displayName}
          src={current.author.avatarUrl}
          size="sm"
          decorative
        />
        <div className="moment-viewer__head-text">
          <span>{current.author.displayName}</span>
          <span className="muted">{fmt.relative(current.createdAt)}</span>
        </div>
        <IconButton
          ref={closeRef}
          label={t('moments.closeViewer')}
          icon={<CloseIcon size={20} />}
          onClick={close}
        />
      </div>
      <div className="moment-viewer__stage">
        <button
          type="button"
          className="moment-viewer__nav moment-viewer__nav--prev"
          aria-label={t('moments.previous')}
          onClick={() => setIndex((i) => Math.max(i - 1, 0))}
          disabled={index === 0}
        />
        {current.media && current.kind === 'video' ? (
          <video
            src={current.media.url}
            className="moment-viewer__media"
            controls
            onEnded={() => setIndex((i) => i + 1)}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (v.duration) setProgress((v.currentTime / v.duration) * 100);
            }}
          />
        ) : current.media && current.kind === 'audio' ? (
          <audio src={current.media.url} controls onEnded={() => setIndex((i) => i + 1)} />
        ) : current.media ? (
          <img
            src={current.media.url}
            alt={current.media.altText ?? ''}
            className="moment-viewer__media"
          />
        ) : null}
        {current.body ? <p className="moment-viewer__caption">{current.body}</p> : null}
        <button
          type="button"
          className="moment-viewer__nav moment-viewer__nav--next"
          aria-label={t('moments.next')}
          onClick={() => setIndex((i) => i + 1)}
        />
      </div>
      <div className="moment-viewer__foot">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPaused((p) => !p)}
          data-testid="moment-pause-toggle"
        >
          {paused ? t('moments.play') : t('moments.pause')}
        </Button>
        <IconButton
          label={t('moments.react')}
          icon={<HeartIcon size={20} />}
          pressed={current.viewer.reaction !== null}
          onClick={() => void react()}
        />
        {isAuthor ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => void loadViewers()}>
              {t('moments.viewCount', { count: current.viewCount })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
              {t('moments.delete')}
            </Button>
          </>
        ) : null}
      </div>
      {viewers ? (
        <div className="moment-viewer__viewers">
          <h2 className="yl-sr-only">{t('moments.viewedBy')}</h2>
          {viewers.loading ? (
            <p className="muted">{t('common.loading')}</p>
          ) : viewers.items.length === 0 ? (
            <p className="muted">{t('moments.viewersEmpty')}</p>
          ) : (
            <ul className="stack-sm">
              {viewers.items.map((v) => (
                <li key={v.id} className="person-row">
                  <Avatar name={v.displayName} src={v.avatarUrl} size="sm" decorative />
                  <span>{v.displayName}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title={t('moments.deleteDialog')}
        description={t('moments.deleteBody')}
        confirmLabel={t('moments.delete')}
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
