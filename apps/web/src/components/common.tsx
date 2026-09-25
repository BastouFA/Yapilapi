'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  ErrorState,
  AlertIcon,
  Skeleton,
  Spinner,
  useLowBandwidth,
  Card,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { describeError } from '@/lib/errors';

/** Localised, retryable error block for failed loads. */
export function ErrorView({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const { t } = useI18n();
  const d = describeError(error, t);
  return (
    <ErrorState
      icon={<AlertIcon size={28} />}
      title={title ?? t('error.loadTitle')}
      description={d.message}
      referenceLabel={t('error.reference')}
      requestId={d.requestId}
      {...(onRetry ? { retryLabel: t('common.retry'), onRetry } : {})}
    />
  );
}

export function PageSpinner() {
  const { t } = useI18n();
  return (
    <div className="page-spinner">
      <Spinner label={t('common.loading')} size="lg" />
    </div>
  );
}

export function PostSkeleton() {
  return (
    <Card padding="md" aria-hidden="true" className="post-skeleton">
      <div className="post-skeleton__head">
        <Skeleton shape="pebble" />
        <div className="post-skeleton__lines">
          <Skeleton width="sm" />
          <Skeleton width="xs" />
        </div>
      </div>
      <Skeleton width="full" />
      <Skeleton width="lg" />
      <Skeleton width="md" />
    </Card>
  );
}

export function FeedSkeleton({ count = 3 }: { count?: number }) {
  const { t } = useI18n();
  return (
    <div aria-busy="true" role="status" className="stack">
      <span className="yl-sr-only">{t('common.loading')}</span>
      {Array.from({ length: count }, (_, i) => (
        <PostSkeleton key={i} />
      ))}
    </div>
  );
}

/** Calls onVisible when scrolled near. Disabled (and replaced by a button) in low-bandwidth mode. */
export function InfiniteFooter({
  hasMore,
  loading,
  error,
  onLoadMore,
  onRetry,
}: {
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const lowBw = useLowBandwidth();
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onLoadMore);
  cb.current = onLoadMore;
  const auto = hasMore && !lowBw && !error;

  useEffect(() => {
    if (!auto || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { rootMargin: '600px 0px' },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [auto, hasMore, loading]);

  if (!hasMore && !error) return null;
  return (
    <div ref={ref} className="infinite-footer">
      {loading ? <FeedSkeleton count={1} /> : null}
      {error ? <ErrorView error={error} onRetry={onRetry} title={t('error.moreTitle')} /> : null}
      {!loading && !error && (lowBw || typeof IntersectionObserver === 'undefined') ? (
        <Button variant="secondary" onClick={onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={t('common.close')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            loadingLabel={t('common.working')}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/** Announce a message to screen readers without showing it. */
export function LiveText({ children }: { children: ReactNode }) {
  return (
    <p className="yl-sr-only" role="status" aria-live="polite">
      {children}
    </p>
  );
}

/** Hook: state that resets after a timeout (used for "Copied!" style feedback). */
export function useFlash(ms = 2500): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    on,
    () => {
      setOn(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), ms);
    },
  ];
}
