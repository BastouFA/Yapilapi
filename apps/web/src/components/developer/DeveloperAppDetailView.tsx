'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DeveloperApiKey,
  DeveloperAppDetail,
  DeveloperWebhook,
  WebhookDelivery,
  WebhookEventTypeInfo,
} from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeIcon,
  EmptyState,
  FeedTabs,
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
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';
import { SecretOnceDialog } from './DeveloperAppsListView';

type Tab = 'overview' | 'keys' | 'webhooks' | 'edit';

const STATUS_KEYS = {
  active: 'developer.status.active',
  suspended: 'developer.status.suspended',
} as const;
const DELIVERY_STATUS_KEYS = {
  pending: 'developer.deliveries.status.pending',
  delivered: 'developer.deliveries.status.delivered',
  failed: 'developer.deliveries.status.failed',
  abandoned: 'developer.deliveries.status.abandoned',
} as const;

function fail(toast: ReturnType<typeof useToast>, t: ReturnType<typeof useI18n>['t'], e: unknown) {
  toast.show({
    tone: 'danger',
    title: t('error.actionFailed'),
    description: describeError(e, t).message,
  });
}

// ------------------------------------------------------------------ overview
function OverviewPanel({ a }: { a: DeveloperAppDetail }) {
  const { t } = useI18n();
  return (
    <Card padding="md" className="stack-sm">
      <p>
        <strong>{t('developer.clientId')}:</strong> <code>{a.clientId}</code>
      </p>
      <p className="muted">
        {a.confidential ? t('developer.confidential.yes') : t('developer.confidential.no')}
      </p>
      <ul className="stack-sm">
        <li>{t('developer.stats.authorizedUsers', { count: a.stats.authorizedUsers })}</li>
        <li>{t('developer.stats.activeKeys', { count: a.stats.activeKeys })}</li>
        <li>{t('developer.stats.webhooks', { count: a.stats.webhooks })}</li>
      </ul>
      {a.homepageUrl ? (
        <p>
          <a href={a.homepageUrl} target="_blank" rel="noreferrer noopener">
            {a.homepageUrl}
          </a>
        </p>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ keys
function NewKeyForm({ appId, onCreated }: { appId: string; onCreated: (key: string) => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('default');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [rateLimitPerMin, setRateLimitPerMin] = useState('120');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const k = await api.developer.createKey(appId, {
        name: name.trim() || undefined,
        expiresInDays: expiresInDays.trim() ? Number(expiresInDays) : undefined,
        rateLimitPerMin: rateLimitPerMin.trim() ? Number(rateLimitPerMin) : undefined,
      });
      toast.show({ tone: 'success', title: t('developer.keys.created') });
      onCreated(k.key);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('developer.keys.new')}</h3>
      <FormField label={t('developer.keys.form.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label={t('developer.keys.form.expiresInDays')}>
        <Input
          type="number"
          min={1}
          max={365}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
        />
      </FormField>
      <FormField label={t('developer.keys.form.rateLimitPerMin')}>
        <Input
          type="number"
          min={1}
          max={1000}
          value={rateLimitPerMin}
          onChange={(e) => setRateLimitPerMin(e.target.value)}
        />
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} onClick={() => void create()}>
        {t('developer.keys.form.create')}
      </Button>
    </Card>
  );
}

function KeyRow({
  appId,
  k,
  onChanged,
}: {
  appId: string;
  k: DeveloperApiKey;
  onChanged: () => void;
}) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const revoke = async () => {
    setBusy(true);
    try {
      await api.developer.revokeKey(appId, k.id);
      toast.show({ tone: 'success', title: t('developer.keys.revoked') });
      setRevokeOpen(false);
      onChanged();
    } catch (e) {
      fail(toast, t, e);
      setRevokeOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="search-row">
      <span className="search-row__text">
        <span>
          {k.name} <code>{k.prefix}…</code>
          {k.revokedAt ? <Badge tone="neutral">{t('developer.keys.revokedBadge')}</Badge> : null}
        </span>
        <span className="muted">
          {t('developer.keys.scopes', { scopes: k.scopes.join(', ') })} ·{' '}
          {k.expiresAt
            ? t('developer.keys.expiresAt', { date: fmt.dateTime(k.expiresAt) })
            : t('developer.keys.neverExpires')}{' '}
          ·{' '}
          {k.lastUsedAt
            ? t('developer.keys.lastUsed', { when: fmt.relative(k.lastUsedAt) })
            : t('developer.keys.neverUsed')}
        </span>
      </span>
      {!k.revokedAt ? (
        <Button size="sm" variant="ghost" onClick={() => setRevokeOpen(true)}>
          {t('developer.keys.revoke')}
        </Button>
      ) : null}
      <ConfirmDialog
        open={revokeOpen}
        title={t('developer.keys.revokeConfirm.title')}
        description={t('developer.keys.revokeConfirm.body')}
        confirmLabel={t('developer.keys.revoke')}
        danger
        busy={busy}
        onConfirm={() => void revoke()}
        onClose={() => setRevokeOpen(false)}
      />
    </li>
  );
}

function KeysPanel({ appId }: { appId: string }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.developer.keys(appId, { signal }), [api, appId]);
  const [newKey, setNewKey] = useState<string | null>(null);

  return (
    <div className="stack">
      <NewKeyForm
        appId={appId}
        onCreated={(key) => {
          setNewKey(key);
          state.reload();
        }}
      />
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('developer.keys.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).length > 0 ? (
        <ul className="stack-sm">
          {(state.data?.items ?? []).map((k) => (
            <KeyRow key={k.id} appId={appId} k={k} onChanged={state.reload} />
          ))}
        </ul>
      ) : null}
      {newKey ? (
        <SecretOnceDialog
          title={t('developer.secretOnce.keyTitle')}
          value={newKey}
          onClose={() => setNewKey(null)}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ webhooks
function DeliveryRow({ d }: { d: WebhookDelivery }) {
  const { t, fmt } = useI18n();
  const tone = d.status === 'delivered' ? 'success' : d.status === 'pending' ? 'neutral' : 'danger';
  return (
    <li className="search-row">
      <span className="search-row__text">
        <span>
          {d.eventType} <Badge tone={tone}>{t(DELIVERY_STATUS_KEYS[d.status])}</Badge>
        </span>
        <span className="muted">
          {t('developer.deliveries.attempts', { count: d.attempts })}
          {d.lastStatusCode
            ? ` · ${t('developer.deliveries.statusCode', { code: d.lastStatusCode })}`
            : ''}
          {d.lastError ? ` · ${d.lastError}` : ''} · {fmt.relative(d.createdAt)}
        </span>
      </span>
    </li>
  );
}

function DeliveriesPanel({ webhookId }: { webhookId: string }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync(
    (signal) => api.developer.deliveries(webhookId, { limit: 20, signal }),
    [api, webhookId],
  );
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];
  if (items.length === 0) return <p className="muted">{t('developer.deliveries.empty')}</p>;
  return (
    <ul className="stack-sm">
      {items.map((d) => (
        <DeliveryRow key={d.id} d={d} />
      ))}
    </ul>
  );
}

function NewWebhookForm({
  appId,
  events,
  onCreated,
}: {
  appId: string;
  events: WebhookEventTypeInfo[];
  onCreated: (secret: string) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (type: string) =>
    setSelected((prev) => (prev.includes(type) ? prev.filter((x) => x !== type) : [...prev, type]));

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const w = await api.developer.createWebhook(appId, {
        url: url.trim(),
        events: selected,
        description: description.trim() || undefined,
      });
      toast.show({ tone: 'success', title: t('developer.webhooks.created') });
      setUrl('');
      setDescription('');
      setSelected([]);
      onCreated(w.secret);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('developer.webhooks.new')}</h3>
      <FormField
        label={t('developer.webhooks.form.url')}
        description={t('developer.webhooks.form.urlHelp')}
        required
      >
        <Input value={url} onChange={(e) => setUrl(e.target.value)} />
      </FormField>
      <FormField label={t('developer.webhooks.form.events')}>
        <div className="stack-sm">
          {events.map((ev) => (
            <Checkbox
              key={ev.type}
              label={`${ev.type} — ${ev.description}`}
              checked={selected.includes(ev.type)}
              onChange={() => toggle(ev.type)}
            />
          ))}
        </div>
      </FormField>
      <FormField label={t('developer.webhooks.form.description')}>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        loading={busy}
        disabled={!url.trim() || selected.length === 0}
        onClick={() => void create()}
      >
        {t('developer.webhooks.form.create')}
      </Button>
    </Card>
  );
}

function WebhookRow({ w, onChanged }: { w: DeveloperWebhook; onChanged: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const test = async () => {
    setBusy(true);
    try {
      await api.developer.testWebhook(w.id);
      toast.show({ tone: 'success', title: t('developer.webhooks.testQueued') });
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const reenable = async () => {
    setBusy(true);
    try {
      await api.developer.updateWebhook(w.id, { active: true });
      toast.show({ tone: 'success', title: t('developer.webhooks.reenabled') });
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const rotateSecret = async () => {
    setBusy(true);
    try {
      const r = await api.developer.rotateWebhookSecret(w.id);
      setNewSecret(r.secret);
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.developer.deleteWebhook(w.id);
      toast.show({ tone: 'success', title: t('developer.webhooks.deleted') });
      setDeleteOpen(false);
      onChanged();
    } catch (e) {
      fail(toast, t, e);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="li" padding="md" className="stack-sm" data-testid="webhook-row">
      <div className="entity-card__meta">
        <span>{w.url}</span>
        <Badge tone={w.active ? 'success' : 'neutral'}>
          {w.active ? t('developer.webhooks.active') : t('developer.webhooks.disabled')}
        </Badge>
      </div>
      <p className="muted">{w.events.join(', ')}</p>
      {!w.active && w.disabledReason ? (
        <p className="yl-notice yl-notice--warning" role="status">
          {t('developer.webhooks.disabledReason', { reason: w.disabledReason })}
        </p>
      ) : null}
      {w.consecutiveFailures > 0 ? (
        <p className="muted">
          {t('developer.webhooks.consecutiveFailures', { count: w.consecutiveFailures })}
        </p>
      ) : null}
      <div className="button-row">
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void test()}>
          {t('developer.webhooks.test')}
        </Button>
        {!w.active ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void reenable()}>
            {t('developer.webhooks.reenable')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void rotateSecret()}>
          {t('developer.webhooks.rotateSecret')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowDeliveries((v) => !v)}>
          {showDeliveries
            ? t('developer.webhooks.hideDeliveries')
            : t('developer.webhooks.viewDeliveries')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
          {t('developer.webhooks.delete')}
        </Button>
      </div>
      {showDeliveries ? <DeliveriesPanel webhookId={w.id} /> : null}
      <ConfirmDialog
        open={deleteOpen}
        title={t('developer.webhooks.deleteConfirm.title')}
        description={t('developer.webhooks.deleteConfirm.body')}
        confirmLabel={t('developer.webhooks.delete')}
        danger
        busy={busy}
        onConfirm={() => void del()}
        onClose={() => setDeleteOpen(false)}
      />
      {newSecret ? (
        <SecretOnceDialog
          title={t('developer.secretOnce.webhookTitle')}
          value={newSecret}
          onClose={() => setNewSecret(null)}
        />
      ) : null}
    </Card>
  );
}

function WebhooksPanel({ appId }: { appId: string }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.developer.webhooks(appId, { signal }), [api, appId]);
  const events = useAsync((signal) => api.developer.webhookEvents({ signal }), [api]);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  return (
    <div className="stack">
      {events.data ? (
        <NewWebhookForm
          appId={appId}
          events={events.data.items}
          onCreated={(secret) => {
            setNewSecret(secret);
            state.reload();
          }}
        />
      ) : null}
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('developer.webhooks.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).length > 0 ? (
        <ul className="stack-sm">
          {(state.data?.items ?? []).map((w) => (
            <WebhookRow key={w.id} w={w} onChanged={state.reload} />
          ))}
        </ul>
      ) : null}
      {newSecret ? (
        <SecretOnceDialog
          title={t('developer.secretOnce.webhookTitle')}
          value={newSecret}
          onClose={() => setNewSecret(null)}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ edit
function EditPanel({
  a,
  onSaved,
}: {
  a: DeveloperAppDetail;
  onSaved: (a: DeveloperAppDetail) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(a.name);
  const [description, setDescription] = useState(a.description ?? '');
  const [homepageUrl, setHomepageUrl] = useState(a.homepageUrl ?? '');
  const [privacyUrl, setPrivacyUrl] = useState(a.privacyUrl ?? '');
  const [redirectUris, setRedirectUris] = useState(a.redirectUris.join('\n'));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.developer.updateApp(a.id, {
        name: name.trim(),
        description: description.trim() || null,
        homepageUrl: homepageUrl.trim() || null,
        privacyUrl: privacyUrl.trim() || null,
        redirectUris: redirectUris
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      toast.show({ tone: 'success', title: t('developer.edit.saved') });
      onSaved({ ...a, ...updated });
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <FormField label={t('developer.form.name')} required>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label={t('developer.form.description')}>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </FormField>
      <FormField label={t('developer.form.homepageUrl')}>
        <Input value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} />
      </FormField>
      <FormField label={t('developer.form.privacyUrl')}>
        <Input value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} />
      </FormField>
      <FormField label={t('developer.form.redirectUris')}>
        <Textarea value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} rows={3} />
      </FormField>
      <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
        {t('developer.edit.save')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ shell
export function DeveloperAppDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const state = useAsync((signal) => api.developer.app(id, { signal }), [api, id]);
  const [tab, setTab] = useState<Tab>('overview');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  usePageTitle(state.data?.name, t('app.name'));

  const del = async () => {
    setBusy(true);
    try {
      await api.developer.deleteApp(id);
      toast.show({ tone: 'success', title: t('developer.deleted') });
      router.push('/developer');
    } catch (e) {
      fail(toast, t, e);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const rotate = async () => {
    setBusy(true);
    try {
      const r = await api.developer.rotateAppSecret(id);
      setRotateOpen(false);
      setRotatedSecret(r.clientSecret);
    } catch (e) {
      fail(toast, t, e);
      setRotateOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const a = state.data;
  if (!a) return <EmptyState icon={<CodeIcon size={28} />} title={t('developer.notFound')} />;

  return (
    <>
      <PageHeader
        title={a.name}
        lead={
          <Badge tone={a.status === 'active' ? 'success' : 'neutral'}>
            {t(STATUS_KEYS[a.status])}
          </Badge>
        }
        actions={
          <div className="button-row">
            {a.confidential ? (
              <Button size="sm" variant="secondary" onClick={() => setRotateOpen(true)}>
                {t('developer.rotateSecret')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
              {t('developer.delete')}
            </Button>
          </div>
        }
      />

      <FeedTabs
        label={a.name}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'overview', label: t('developer.tab.overview') },
          { id: 'keys', label: t('developer.tab.keys') },
          { id: 'webhooks', label: t('developer.tab.webhooks') },
          { id: 'edit', label: t('developer.tab.edit') },
        ]}
      >
        {tab === 'overview' ? <OverviewPanel key="overview" a={a} /> : null}
        {tab === 'keys' ? <KeysPanel key="keys" appId={a.id} /> : null}
        {tab === 'webhooks' ? <WebhooksPanel key="webhooks" appId={a.id} /> : null}
        {tab === 'edit' ? (
          <EditPanel key="edit" a={a} onSaved={(updated) => state.setData(updated)} />
        ) : null}
      </FeedTabs>

      <ConfirmDialog
        open={deleteOpen}
        title={t('developer.deleteConfirm.title')}
        description={t('developer.deleteConfirm.body')}
        confirmLabel={t('developer.delete')}
        danger
        busy={busy}
        onConfirm={() => void del()}
        onClose={() => setDeleteOpen(false)}
      />
      <ConfirmDialog
        open={rotateOpen}
        title={t('developer.rotateSecretConfirm.title')}
        description={t('developer.rotateSecretConfirm.body')}
        confirmLabel={t('developer.rotateSecret')}
        danger
        busy={busy}
        onConfirm={() => void rotate()}
        onClose={() => setRotateOpen(false)}
      />
      {rotatedSecret ? (
        <SecretOnceDialog
          title={t('developer.secretOnce.appTitle')}
          value={rotatedSecret}
          onClose={() => setRotatedSecret(null)}
        />
      ) : null}
    </>
  );
}
