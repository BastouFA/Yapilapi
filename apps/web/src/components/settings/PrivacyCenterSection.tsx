'use client';

import { useState } from 'react';
import type { ConsentPurpose } from '@yapilapi/api-client';
import { Button, Dialog, Switch, useToast } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi, useApiBaseUrl } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { ErrorView, PageSpinner, ConfirmDialog } from '@/components/common';
import { SettingsCard } from './shared';

const EXPORT_STATUS_KEYS = {
  pending: 'privacy.exportStatus.pending',
  processing: 'privacy.exportStatus.processing',
  completed: 'privacy.exportStatus.completed',
  failed: 'privacy.exportStatus.failed',
} as const;

function OverviewCard() {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.privacy.overview({ signal }), [api]);
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const d = state.data;
  if (!d) return null;
  return (
    <SettingsCard
      id="pc-overview"
      title={t('privacy.overviewTitle')}
      description={t('privacy.overviewLead')}
    >
      <ul className="stack-sm">
        {d.categories.map((c) => (
          <li key={c.key}>
            <strong>{c.label}</strong>
            <span className="muted">
              {' — '}
              {t('privacy.category.items', { count: c.items ?? 0 })}
              {' · '}
              {t('privacy.category.retention', { retention: c.retention })}
            </span>
          </li>
        ))}
      </ul>
      <div className="stack-sm">
        <span className="section-title">{t('privacy.retainedTitle')}</span>
        <ul className="stack-sm">
          {d.retainedAfterDeletion.map((line, i) => (
            <li key={i} className="muted">
              {line}
            </li>
          ))}
        </ul>
      </div>
    </SettingsCard>
  );
}

function ConsentsCard() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.privacy.consents({ signal }), [api]);
  const [busy, setBusy] = useState<ConsentPurpose | null>(null);
  const [historyFor, setHistoryFor] = useState<ConsentPurpose | null>(null);
  const history = useAsync(
    (signal) =>
      historyFor
        ? api.privacy.consentHistory({ purpose: historyFor, signal })
        : Promise.resolve(null),
    [api, historyFor],
  );

  const toggle = async (purpose: ConsentPurpose, granted: boolean) => {
    setBusy(purpose);
    try {
      const r = await api.privacy.setConsent(purpose, granted);
      state.setData((d) =>
        d
          ? {
              items: d.items.map((c) => (c.purpose === purpose ? { ...c, granted: r.granted } : c)),
            }
          : d,
      );
      toast.show({ tone: 'success', title: t('common.saved') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(null);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];

  return (
    <SettingsCard
      id="pc-consents"
      title={t('privacy.consentsTitle')}
      description={t('privacy.consentsLead')}
    >
      <ul className="stack">
        {items.map((c) => (
          <li key={c.purpose} className="stack-sm">
            <Switch
              label={c.label}
              description={c.description}
              checked={c.granted}
              disabled={busy === c.purpose || !c.canGrant}
              onChange={(e) => void toggle(c.purpose, e.target.checked)}
            />
            {!c.canGrant ? <p className="muted">{t('privacy.consentTeenLocked')}</p> : null}
            <div className="inline-form">
              {c.isDefault ? (
                <span className="muted">{t('privacy.consentDefault')}</span>
              ) : c.decidedAt ? (
                <span className="muted">
                  {t('privacy.consentDecidedAt', { when: fmt.relative(c.decidedAt) })}
                </span>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setHistoryFor(c.purpose)}>
                {t('privacy.consentHistory')}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Dialog
        open={historyFor !== null}
        onClose={() => setHistoryFor(null)}
        title={t('privacy.consentHistoryTitle')}
        closeLabel={t('common.close')}
      >
        {history.loading ? (
          <PageSpinner />
        ) : history.data && history.data.items.length > 0 ? (
          <ul className="stack-sm">
            {history.data.items.map((h) => (
              <li key={h.id}>
                {h.granted
                  ? t('privacy.consentHistoryGranted')
                  : t('privacy.consentHistoryWithdrawn')}
                {' · '}
                {fmt.dateTime(h.at)}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('privacy.consentHistoryEmpty')}</p>
        )}
      </Dialog>
    </SettingsCard>
  );
}

function AdvertisingCard() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.privacy.advertising({ signal }), [api]);
  const [busy, setBusy] = useState(false);

  const update = async (patch: { personalizedAds?: boolean; limitSensitive?: boolean }) => {
    setBusy(true);
    try {
      const r = await api.privacy.updateAdvertising(patch);
      state.setData(() => r);
      toast.show({ tone: 'success', title: t('common.saved') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const d = state.data;
  if (!d) return null;

  return (
    <SettingsCard id="pc-advertising" title={t('privacy.advertisingTitle')}>
      <Switch
        label={t('privacy.personalizedAds')}
        description={!d.availableToYou ? t('privacy.personalizedAdsHelp') : undefined}
        checked={d.personalizedAds}
        disabled={busy || !d.availableToYou}
        onChange={(e) => void update({ personalizedAds: e.target.checked })}
      />
      <Switch
        label={t('privacy.limitSensitive')}
        description={!d.availableToYou ? t('privacy.limitSensitiveTeenLocked') : undefined}
        checked={d.limitSensitive}
        disabled={busy || (!d.availableToYou && d.limitSensitive)}
        onChange={(e) => void update({ limitSensitive: e.target.checked })}
      />
    </SettingsCard>
  );
}

function VisibilityCard() {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.privacy.visibility({ signal }), [api]);
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const d = state.data;
  if (!d) return null;
  return (
    <SettingsCard
      id="pc-visibility"
      title={t('privacy.visibilityTitle')}
      description={t('privacy.visibilityLead')}
    >
      <ul className="stack-sm">
        <li>{d.profile.private ? t('privacy.visibilityPrivate') : null}</li>
        <li>{d.profile.discoverable ? t('privacy.visibilityDiscoverable') : null}</li>
        <li>{t('privacy.visibilityWhoCanMessage', { who: d.profile.whoCanMessage })}</li>
        <li>{t('privacy.visibilityDefaultPost', { visibility: d.defaults.postVisibility })}</li>
      </ul>
      <div className="inline-form">
        <span className="muted">
          {t('privacy.visibilityBlocked', { count: d.controls.blocked })}
        </span>
        <span className="muted">{t('privacy.visibilityMuted', { count: d.controls.muted })}</span>
        <span className="muted">
          {t('privacy.visibilityRestricted', { count: d.controls.restricted })}
        </span>
        <span className="muted">
          {t('privacy.visibilityCircles', { count: d.controls.circles })}
        </span>
        <span className="muted">
          {t('privacy.visibilityConnectedApps', { count: d.controls.connected_apps })}
        </span>
      </div>
    </SettingsCard>
  );
}

function ExportCard() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const apiBaseUrl = useApiBaseUrl();
  const state = useAsync((signal) => api.privacy.requests({ signal }), [api]);
  const [password, setPassword] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const request = async () => {
    setRequesting(true);
    try {
      await api.privacy.requestExport(password ? { password } : {});
      setPassword('');
      toast.show({ tone: 'success', title: t('privacy.exportRequested') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setRequesting(false);
    }
  };

  const download = async (id: string) => {
    setBusyId(id);
    try {
      const link = await api.privacy.createDownloadLink(id);
      window.open(`${apiBaseUrl}${link.path}`, '_blank', 'noopener');
    } catch (e) {
      fail(e);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsCard
      id="pc-export"
      title={t('privacy.exportTitle')}
      description={t('privacy.exportLead')}
    >
      <div className="inline-form">
        <input
          type="password"
          className="yl-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('privacy.exportPasswordLabel')}
          aria-label={t('privacy.exportPasswordLabel')}
        />
        <Button size="sm" loading={requesting} onClick={() => void request()}>
          {t('privacy.exportRequest')}
        </Button>
      </div>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('privacy.exportRequestsEmpty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((r) => (
            <li key={r.id} className="search-row">
              <span className="search-row__text">
                <span>{fmt.dateTime(r.createdAt)}</span>
                <span className="muted">
                  {r.status in EXPORT_STATUS_KEYS
                    ? t(EXPORT_STATUS_KEYS[r.status as keyof typeof EXPORT_STATUS_KEYS])
                    : r.status}
                </span>
              </span>
              {r.export?.downloadable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busyId === r.id}
                  onClick={() => void download(r.id)}
                >
                  {t('privacy.exportDownload')}
                </Button>
              ) : r.kind === 'export' && r.status === 'completed' ? (
                <span className="muted">{t('privacy.exportExpired')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsCard>
  );
}

function ConnectedAppsCard() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.privacy.connectedApps({ signal }), [api]);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!revokeId) return;
    setBusy(true);
    try {
      await api.privacy.revokeConnectedApp(revokeId);
      state.setData((d) => (d ? { items: d.items.filter((a) => a.id !== revokeId) } : d));
      setRevokeId(null);
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];

  return (
    <SettingsCard id="pc-connected-apps" title={t('privacy.connectedAppsTitle')}>
      {items.length === 0 ? (
        <p className="muted">{t('privacy.connectedAppsEmpty')}</p>
      ) : (
        <ul className="stack-sm">
          {items.map((a) => (
            <li key={a.id}>
              <div className="search-row">
                <span className="search-row__text">
                  <span>{a.app.name}</span>
                  <span className="muted">
                    {t('privacy.connectedAppScopes', {
                      scopes: a.scopes.map((s) => s.description).join(', '),
                    })}
                    {' · '}
                    {a.lastUsedAt
                      ? t('privacy.connectedAppLastUsed', { when: fmt.relative(a.lastUsedAt) })
                      : t('privacy.connectedAppNeverUsed')}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setRevokeId(a.id)}>
                  {t('privacy.connectedAppRevoke')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={revokeId !== null}
        title={t('privacy.connectedAppRevokeDialogTitle')}
        description={t('privacy.connectedAppRevokeDialogBody')}
        confirmLabel={t('privacy.connectedAppRevoke')}
        danger
        busy={busy}
        onConfirm={() => void revoke()}
        onClose={() => setRevokeId(null)}
      />
    </SettingsCard>
  );
}

/** Privacy Center: what we hold, consents, advertising, visibility, data export and connected apps. */
export function PrivacyCenterSection() {
  return (
    <div className="stack">
      <OverviewCard />
      <ConsentsCard />
      <AdvertisingCard />
      <VisibilityCard />
      <ExportCard />
      <ConnectedAppsCard />
    </div>
  );
}
