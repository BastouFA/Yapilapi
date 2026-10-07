'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Skeleton } from '@yapilapi/design-system';
import { ADMIN_PERIODS, type AdminPeriod } from '@yapilapi/shared';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Something loaded from the API, with its error and a way to load it again. `data` is null while
 * loading (and after a failure until the next load succeeds).
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then(
      (r) => live && setData(r),
      (e) => {
        if (!live) return;
        setData(null);
        setError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, setData, error, reload };
}

/** Why a section couldn't load, with Try again. */
export function LoadFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useSession();
  return (
    <Alert tone="danger" title={t('admin.loadFailed')}>
      <span role="alert">{error}</span>{' '}
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('m.common.retry')}
      </Button>
    </Alert>
  );
}

export function Loading() {
  const { t } = useSession();
  return (
    <div className="stack" aria-busy aria-label={t('common.loading')}>
      <Skeleton height={120} />
      <Skeleton height={120} />
    </div>
  );
}

/** A row of toggle buttons: one choice out of a few (a period, a status). */
export function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="row" role="group" aria-label={label}>
      {options.map((o) => (
        <Button key={String(o.id)} size="sm" variant={o.id === value ? 'primary' : 'secondary'} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** 7, 30 or 90 days. */
export function PeriodChoice({ value, onChange }: { value: AdminPeriod; onChange: (d: AdminPeriod) => void }) {
  const { t, tp } = useSession();
  return (
    <Choice
      label={t('admin.period.label')}
      value={value}
      onChange={onChange}
      options={ADMIN_PERIODS.map((d) => ({ id: d, label: tp('admin.period.days', d) }))}
    />
  );
}

export const formatCount = (n: number, locale: string) => new Intl.NumberFormat(locale).format(n);

/** A date and time in the reader's language. */
export const formatWhen = (d: string | Date, locale: string) => new Date(d).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

/** How long, in the largest unit that fits ("3 h", "12 min"). */
export function formatDuration(seconds: number, locale: string): string {
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  const [unit, size] = units.find(([, s]) => seconds >= s) ?? units[3]!;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(Math.floor(seconds / size));
}

/** Pretty JSON for a metadata cell. */
export const prettyJson = (v: unknown) => JSON.stringify(v ?? {}, null, 2);
