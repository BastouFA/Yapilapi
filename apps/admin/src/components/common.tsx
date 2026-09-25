'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertIcon,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
  type BadgeTone,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { describeError } from '@/lib/errors';
import { usePageTitle, type PagedList, type Resource } from '@/lib/hooks';

// ------------------------------------------------------------------ page chrome
/** Page heading. Moves focus to the h1 on mount so keyboard and screen-reader users land on the new page's title. */
export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLHeadingElement>(null);
  usePageTitle(title, t('app.name'));
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="page-head">
      <div>
        <h1 ref={ref} tabIndex={-1} className="page-title">
          {title}
        </h1>
        {lead ? <p className="page-lead">{lead}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const auto = useId();
  const hid = id ?? auto;
  return (
    <section className="panel" aria-labelledby={hid}>
      <div className="panel__head">
        <div>
          <h2 id={hid} className="panel__title">
            {title}
          </h2>
          {description ? <p className="panel__desc">{description}</p> : null}
        </div>
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Facts({ items }: { items: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ errors and loading
export function ErrorNotice({ error, compact }: { error: unknown; compact?: boolean }) {
  const { t } = useI18n();
  const d = describeError(error, t);
  return (
    <div
      className={
        compact
          ? 'yl-notice yl-notice--danger error-notice'
          : 'yl-notice yl-notice--danger error-notice error-notice--block'
      }
      role="alert"
    >
      <p className="error-notice__msg">
        <AlertIcon size={16} /> <span>{d.message}</span>
      </p>
      {d.requestId ? (
        <p className="error-notice__ref">
          {t('error.reference')}: <code>{d.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="loading-block" aria-busy="true">
      <Spinner label={t('common.loading')} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} shape="text" width={i % 2 ? 'md' : 'lg'} />
      ))}
    </div>
  );
}

/** Wraps a loaded resource: loading, error (with request id and retry), optional empty state, then the content. */
export function ResourceView<T>({
  resource,
  children,
  isEmpty,
  emptyTitle,
  emptyBody,
  rows,
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyBody?: string;
  rows?: number;
}) {
  const { t } = useI18n();
  if (resource.data === undefined && resource.loading)
    return <LoadingBlock {...(rows ? { rows } : {})} />;
  if (resource.error && resource.data === undefined)
    return <FailedState error={resource.error} onRetry={resource.reload} />;
  const data = resource.data as T;
  if (isEmpty?.(data))
    return (
      <EmptyState
        title={emptyTitle ?? t('common.emptyTitle')}
        description={emptyBody ?? t('common.emptyBody')}
        headingLevel={3}
      />
    );
  return (
    <div aria-busy={resource.loading || undefined}>
      {resource.error ? <ErrorNotice error={resource.error} /> : null}
      {children(data)}
    </div>
  );
}

export function FailedState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const d = describeError(error, t);
  return (
    <ErrorState
      icon={<AlertIcon size={28} />}
      title={
        d.status === 403
          ? t('error.forbiddenTitle')
          : d.code === 'feature_disabled'
            ? t('error.featureDisabledTitle')
            : t('error.loadFailed')
      }
      description={d.message}
      {...(onRetry ? { retryLabel: t('common.retry'), onRetry } : {})}
      referenceLabel={t('error.reference')}
      requestId={d.requestId}
    />
  );
}

/** Paged list wrapper: states + "Load more". */
export function ListView<T>({
  list,
  children,
  emptyTitle,
  emptyBody,
}: {
  list: PagedList<T>;
  children: (items: T[]) => ReactNode;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  const { t } = useI18n();
  if (list.loading && list.items.length === 0) return <LoadingBlock />;
  if (list.error && list.items.length === 0)
    return <FailedState error={list.error} onRetry={list.reload} />;
  if (list.items.length === 0)
    return (
      <EmptyState
        title={emptyTitle ?? t('common.emptyTitle')}
        description={emptyBody ?? t('common.emptyBody')}
        headingLevel={3}
      />
    );
  return (
    <div aria-busy={list.loading || undefined}>
      {list.error ? <ErrorNotice error={list.error} /> : null}
      {children(list.items)}
      <div className="list-footer">
        <p className="muted" role="status">
          {t('common.showing', { count: list.items.length })}
        </p>
        {list.hasMore ? (
          <Button
            variant="secondary"
            onClick={list.loadMore}
            loading={list.loadingMore}
            loadingLabel={t('common.loading')}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ small display helpers
const TONES: Record<string, BadgeTone> = {
  active: 'success',
  published: 'success',
  verified: 'success',
  paid: 'success',
  approved: 'success',
  succeeded: 'success',
  won: 'success',
  allow: 'success',
  upheld: 'neutral',
  completed: 'success',
  fulfilled: 'success',
  healthy: 'success',
  resolved: 'neutral',
  open: 'info',
  in_review: 'info',
  review: 'info',
  pending: 'info',
  pending_review: 'warning',
  requested: 'warning',
  processing: 'info',
  held: 'warning',
  escalated: 'danger',
  appealed: 'warning',
  restricted: 'warning',
  suspended: 'danger',
  banned: 'danger',
  rejected: 'danger',
  failed: 'danger',
  lost: 'danger',
  block: 'danger',
  denied: 'danger',
  deny: 'danger',
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  unverified: 'neutral',
  closed: 'neutral',
  cancelled: 'neutral',
  draft: 'neutral',
  overturned: 'info',
  deactivated: 'neutral',
  pending_deletion: 'warning',
  deleted: 'neutral',
  triaged: 'info',
  actioned: 'success',
  dismissed: 'neutral',
};

/** Status chip: always shows its text (never colour alone). */
export function StatusBadge({ group, value }: { group: string; value: string | null | undefined }) {
  const { label } = useI18n();
  return (
    <Badge tone={value ? (TONES[value] ?? 'neutral') : 'neutral'}>{label(group, value)}</Badge>
  );
}

export function Time({ value }: { value: string | null | undefined }) {
  const { fmt, t } = useI18n();
  if (!value) return <span className="muted">{t('common.none')}</span>;
  return (
    <time dateTime={value} title={`${value}`}>
      {fmt.dateTime(value)}
    </time>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono">{children}</code>;
}

export function ShortId({ id }: { id: string | null | undefined }) {
  const { t } = useI18n();
  if (!id) return <span className="muted">{t('common.none')}</span>;
  return (
    <code className="mono" title={id}>
      {id.slice(0, 8)}
    </code>
  );
}

/** Key/value rendering of an arbitrary JSON snapshot (evidence, metadata): scalars inline, structures as formatted JSON. */
export function JsonFacts({
  value,
  empty,
}: {
  value: Record<string, unknown> | null | undefined;
  empty?: string;
}) {
  const { t } = useI18n();
  const entries = Object.entries(value ?? {});
  if (!entries.length) return <p className="muted">{empty ?? t('common.none')}</p>;
  return (
    <dl className="facts facts--dense">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {v !== null && typeof v === 'object' ? (
              <pre className="json">{JSON.stringify(v, null, 2)}</pre>
            ) : v === null ? (
              <span className="muted">{t('common.none')}</span>
            ) : (
              <span className="wrap">{String(v)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Filters({
  label,
  children,
  onSubmit,
}: {
  label: string;
  children: ReactNode;
  onSubmit?: () => void;
}) {
  return (
    <form
      className="filters"
      role="search"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
    </form>
  );
}

/** Nav between sibling pages/tabs (real links, so each view has a URL). */
export function SubNav({
  label,
  items,
  current,
}: {
  label: string;
  items: Array<{ href: string; label: string; id: string }>;
  current: string;
}) {
  return (
    <nav aria-label={label} className="subnav">
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={i.href}
              className={i.id === current ? 'subnav__link is-active' : 'subnav__link'}
              aria-current={i.id === current ? 'page' : undefined}
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ------------------------------------------------------------------ mutations
export interface MutationDialogProps<R> {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  tone?: 'primary' | 'danger';
  /** Label of the mandatory reason/note textarea (sent to the API, recorded in the audit log). Omit for no textarea. */
  reasonLabel?: string;
  reasonOptional?: boolean;
  /** Minimum reason length (the API requires at least 3 characters for most reasons). */
  reasonMin?: number;
  reasonHint?: string;
  /** Destructive actions: the person must type this phrase exactly before the button enables. */
  confirmPhrase?: string;
  /** Extra form controls rendered above the reason. */
  children?: ReactNode;
  /** Extra validity gate for `children` controls. */
  valid?: boolean;
  onSubmit: (reason: string) => Promise<R>;
  successMessage: string | ((result: R) => string);
  onDone?: (result: R) => void;
}

/**
 * Every state-changing action goes through this dialog: an explicit summary, an audited reason, a typed confirmation for
 * destructive actions, and a result (toast on success; on failure the API's message plus its request id, dialog stays open).
 */
export function MutationDialog<R>(props: MutationDialogProps<R>) {
  const { t } = useI18n();
  const toast = useToast();
  const formId = useId();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const min = props.reasonLabel ? (props.reasonOptional ? 0 : (props.reasonMin ?? 3)) : 0;

  useEffect(() => {
    if (props.open) {
      setReason('');
      setTyped('');
      setError(undefined);
      setBusy(false);
    }
  }, [props.open]);

  const reasonOk = reason.trim().length >= min;
  const phraseOk = !props.confirmPhrase || typed.trim() === props.confirmPhrase;
  const ready = reasonOk && phraseOk && props.valid !== false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.onSubmit(reason.trim());
      toast.show({
        tone: 'success',
        title:
          typeof props.successMessage === 'function'
            ? props.successMessage(result)
            : props.successMessage,
      });
      props.onClose();
      props.onDone?.(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      closeLabel={t('common.close')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={props.tone === 'danger' ? 'danger' : 'primary'}
            disabled={!ready}
            loading={busy}
            loadingLabel={t('common.working')}
          >
            {props.submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="stack" noValidate>
        {props.children}
        {props.reasonLabel ? (
          <FormField
            label={props.reasonLabel}
            description={
              props.reasonHint ??
              (props.reasonOptional ? t('mutation.reasonOptional') : t('mutation.reasonAudited'))
            }
            required={!props.reasonOptional}
            requiredLabel={t('common.required')}
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={2000}
            />
          </FormField>
        ) : null}
        {props.confirmPhrase ? (
          <FormField
            label={t('mutation.typeToConfirm', { phrase: props.confirmPhrase })}
            required
            requiredLabel={t('common.required')}
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="confirm-phrase"
            />
          </FormField>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
      </form>
    </Dialog>
  );
}
