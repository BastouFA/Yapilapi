'use client';

import { Badge, Button, Card, Stat } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';
import { api } from '@/lib/api';
import { formatCount, formatDuration, formatWhen, LoadFailed, Loading, useLoad } from './shared';

/** Is the service well: the database, Redis, background jobs, webhooks, and which build is running. */
export function System() {
  const { t, locale } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.system(), []);
  if (error) return <LoadFailed error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const redis = { ok: t('admin.system.ok'), degraded: t('admin.system.degraded'), not_configured: t('admin.system.notConfigured') }[data.redis];
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">{t('admin.system.checkedAt', { when: formatWhen(data.serverTime, locale) })}</span>
        <Button size="sm" variant="secondary" onClick={reload}>
          {t('admin.system.refresh')}
        </Button>
      </div>
      <Card title={t('admin.system.services')}>
        <dl className="admin-facts">
          <div>
            <dt>{t('admin.system.database')}</dt>
            <dd>
              <Badge tone={data.database.ok ? 'success' : 'danger'}>{data.database.ok ? t('admin.system.ok') : t('admin.system.down')}</Badge>
              {data.database.latencyMs !== null ? ` ${t('admin.ai.ms', { ms: data.database.latencyMs })}` : ''}
            </dd>
          </div>
          <div>
            <dt>Redis</dt>
            <dd>
              <Badge tone={data.redis === 'ok' ? 'success' : data.redis === 'degraded' ? 'danger' : 'neutral'}>{redis}</Badge>
            </dd>
          </div>
          <div>
            <dt>{t('admin.system.webhooks')}</dt>
            <dd>
              {t('admin.system.webhooksCounts', { failed: formatCount(data.webhooks.failed, locale), pending: formatCount(data.webhooks.pending, locale) })}
            </dd>
          </div>
          <div>
            <dt>{t('admin.system.build')}</dt>
            <dd>
              <code>{data.app.commit ? data.app.commit.slice(0, 12) : t('admin.system.noCommit')}</code> · {data.app.environment} · Node {data.app.node}
            </dd>
          </div>
          <div>
            <dt>{t('admin.system.uptime')}</dt>
            <dd>{formatDuration(data.app.uptimeSeconds, locale)}</dd>
          </div>
          <div>
            <dt>{t('admin.system.providers')}</dt>
            <dd>{t('admin.system.providersList', { ai: data.app.ai, email: data.app.email, payments: data.app.payments, storage: data.app.storage })}</dd>
          </div>
        </dl>
      </Card>
      <Card title={t('admin.system.jobs')} subtitle={t('admin.system.jobsSubtitle')}>
        <div className="stats">
          <Stat label={t('admin.system.due')} value={formatCount(data.jobs.due, locale)} />
          <Stat label={t('admin.system.scheduled')} value={formatCount(data.jobs.scheduled, locale)} />
          <Stat label={t('admin.system.running')} value={formatCount(data.jobs.running, locale)} />
          <Stat label={t('admin.system.failed24h')} value={formatCount(data.jobs.failed24h, locale)} />
          <Stat label={t('admin.system.failedAll')} value={formatCount(data.jobs.failed, locale)} />
          <Stat
            label={t('admin.system.oldest')}
            value={data.jobs.oldestPendingSeconds === null ? t('admin.system.none') : formatDuration(data.jobs.oldestPendingSeconds, locale)}
          />
        </div>
        {data.jobs.recentFailures.length ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.system.recentFailures')}>
            <table className="table">
              <caption className="admin-caption">{t('admin.system.recentFailures')}</caption>
              <thead>
                <tr>
                  <th>{t('admin.audit.when')}</th>
                  <th>{t('admin.system.kind')}</th>
                  <th>{t('admin.system.attempts')}</th>
                  <th>{t('admin.system.error')}</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.recentFailures.map((j) => (
                  <tr key={j.id}>
                    <td>{formatWhen(j.finishedAt ?? j.createdAt, locale)}</td>
                    <td>
                      <code>{j.kind}</code>
                    </td>
                    <td>{j.attempts}</td>
                    <td className="admin-pre">{j.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{t('admin.system.noFailures')}</p>
        )}
      </Card>
    </div>
  );
}
