'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { DeveloperApp } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeIcon,
  Dialog,
  EmptyState,
  FormField,
  Input,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner, useFlash } from '@/components/common';

const STATUS_KEYS = {
  active: 'developer.status.active',
  suspended: 'developer.status.suspended',
} as const;

/** Shown once, then never again: a client secret / API key / webhook secret. Mirrors SecuritySection's recovery-codes dialog. */
export function SecretOnceDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const [copied, flash] = useFlash();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      flash();
    } catch {
      /* the value stays visible to copy by hand */
    }
  };

  return (
    <Dialog
      open
      onClose={() => undefined}
      dismissible={false}
      title={title}
      closeLabel={t('common.close')}
      description={t('developer.secretOnce.body')}
      footer={
        <Button onClick={onClose} disabled={!saved} data-testid="secret-once-done">
          {t('common.done')}
        </Button>
      }
    >
      <p className="recovery-codes" dir="ltr" data-testid="secret-once-value">
        <code>{value}</code>
      </p>
      <div className="button-row">
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      <p role="status" className="yl-sr-only">
        {copied ? t('common.copied') : ''}
      </p>
      <Checkbox
        label={t('developer.secretOnce.saved')}
        checked={saved}
        onChange={(e) => setSaved(e.target.checked)}
        data-testid="secret-once-saved"
      />
    </Dialog>
  );
}

function AppCard({ a }: { a: DeveloperApp }) {
  const { t, fmt } = useI18n();
  return (
    <Card as="li" padding="md" className="stack-sm">
      <Link href={`/developer/${encodeURIComponent(a.id)}`} className="entity-card__title">
        {a.name}
      </Link>
      <span className="entity-card__meta">
        <Badge tone={a.status === 'active' ? 'success' : 'neutral'}>
          {t(STATUS_KEYS[a.status])}
        </Badge>
        <span>
          {a.confidential ? t('developer.confidential.yes') : t('developer.confidential.no')}
        </span>
        <span>{fmt.relative(a.createdAt)}</span>
      </span>
      {a.description ? <p className="muted">{a.description}</p> : null}
    </Card>
  );
}

function NewAppForm({ onCreated }: { onCreated: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confidential, setConfidential] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const a = await api.developer.createApp({
        name: name.trim(),
        description: description.trim() || undefined,
        confidential,
      });
      toast.show({ tone: 'success', title: t('developer.created') });
      setName('');
      setDescription('');
      if (a.clientSecret) setSecret(a.clientSecret);
      onCreated();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('developer.new')}</h3>
      <FormField label={t('developer.form.name')} required>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label={t('developer.form.description')}>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </FormField>
      <Checkbox
        label={t('developer.form.confidential')}
        checked={confidential}
        onChange={(e) => setConfidential(e.target.checked)}
      />
      <p className="muted">{t('developer.form.confidentialHelp')}</p>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} disabled={!name.trim()} onClick={() => void create()}>
        {t('developer.form.create')}
      </Button>
      {secret ? (
        <SecretOnceDialog
          title={t('developer.secretOnce.appTitle')}
          value={secret}
          onClose={() => setSecret(null)}
        />
      ) : null}
    </Card>
  );
}

export function DeveloperAppsListView() {
  const api = useApi();
  const { t } = useI18n();
  usePageTitle(t('developer.title'), t('app.name'));
  const state = useAsync((signal) => api.developer.apps({ signal }), [api]);

  return (
    <>
      <PageHeader title={t('developer.title')} lead={t('developer.lead')} />
      <div className="stack">
        <NewAppForm onCreated={state.reload} />
        {state.loading ? <PageSpinner /> : null}
        {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
        {state.data && state.data.items.length === 0 ? (
          <EmptyState icon={<CodeIcon size={28} />} title={t('developer.empty')} />
        ) : null}
        {(state.data?.items ?? []).length > 0 ? (
          <ul className="stack-sm">
            {(state.data?.items ?? []).map((a) => (
              <AppCard key={a.id} a={a} />
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
