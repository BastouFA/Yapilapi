'use client';

import Link from 'next/link';
import { AlertIcon, Badge, CheckIcon } from '@yapilapi/ui';
import { isUnavailable, type SystemHealth } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { Kpi } from '@/components/charts';
import { Facts, PageHeader, ResourceView, Section } from '@/components/common';

/** Backlogs where any non-zero count means somebody should look. */
const ATTENTION = new Set([
  'webhooksFailed24h',
  'deletionsDue',
  'exportsAwaitingPurge',
  'webhooksDue',
]);

function HealthSection() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const res = useResource((signal) => api.system.health({ signal }), [api]);
  return (
    <Section
      title={t('dashboard.health.title')}
      description={t('dashboard.health.desc')}
      actions={
        <button type="button" className="link-btn" onClick={res.reload}>
          {t('common.refresh')}
        </button>
      }
    >
      <ResourceView resource={res}>
        {(h: SystemHealth) => (
          <div className="stack">
            <div className="health-list">
              <div className="health-item" data-testid="health-db">
                <span>{t('dashboard.health.database')}</span>
                {h.database.ok ? (
                  <Badge tone="success" icon={<CheckIcon size={14} />}>
                    {t('dashboard.health.ok', { ms: h.database.latencyMs ?? 0 })}
                  </Badge>
                ) : (
                  <Badge tone="danger" icon={<AlertIcon size={14} />}>
                    {t('dashboard.health.down')}
                  </Badge>
                )}
              </div>
              <div className="health-item">
                <span>{t('dashboard.health.migrations')}</span>
                <span>
                  {h.database.migrations
                    ? t('dashboard.health.migrationsValue', {
                        count: h.database.migrations.applied,
                      })
                    : t('common.none')}
                </span>
              </div>
              <div className="health-item">
                <span>{t('dashboard.health.uptime')}</span>
                <span>
                  {fmt.number(Math.round(h.uptimeSec / 60))} {t('common.minutesShort')}
                </span>
              </div>
              <div className="health-item">
                <span>{t('dashboard.health.runtime')}</span>
                <span>
                  {h.runtime.env} · {h.runtime.node} · {h.runtime.memoryMb} MB
                </span>
              </div>
              <div className="health-item">
                <span>{t('dashboard.health.flags')}</span>
                <span>
                  {isUnavailable(h.featureFlags)
                    ? t('common.unavailable')
                    : t('dashboard.health.flagsValue', {
                        enabled: h.featureFlags.enabled,
                        total: h.featureFlags.total,
                      })}
                </span>
              </div>
            </div>
            <h3 className="panel__title">{t('dashboard.health.backlogs')}</h3>
            <ul className="health-list">
              {Object.entries(h.backlogs).map(([k, v]) => (
                <li key={k} className="health-item">
                  <span>{label('backlog', k)}</span>
                  {isUnavailable(v) ? (
                    <Badge tone="warning" icon={<AlertIcon size={14} />}>
                      {t('common.unavailable')}
                    </Badge>
                  ) : v > 0 && ATTENTION.has(k) ? (
                    <Badge tone="warning" icon={<AlertIcon size={14} />}>
                      {fmt.number(v)}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">{fmt.number(v)}</Badge>
                  )}
                </li>
              ))}
            </ul>
            <Facts
              items={[
                [
                  t('dashboard.health.adapters'),
                  Object.entries(h.adapters)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · '),
                ],
              ]}
            />
          </div>
        )}
      </ResourceView>
    </Section>
  );
}

function QueueSection() {
  const { t, fmt } = useI18n();
  const api = useAdminApi();
  const res = useResource((signal) => api.moderation.queueStats({ signal }), [api]);
  return (
    <Section
      title={t('dashboard.queue.title')}
      actions={
        <Link href="/moderation" className="link-btn">
          {t('dashboard.queue.open')}
        </Link>
      }
    >
      <ResourceView resource={res}>
        {(s) => {
          const total = s.queue.reduce((a, r) => a + r.count, 0);
          const by = (risk: string) =>
            s.queue.filter((r) => r.riskLevel === risk).reduce((a, r) => a + r.count, 0);
          const oldest = s.queue
            .map((r) => r.oldest)
            .filter((x): x is string => Boolean(x))
            .sort()[0];
          return (
            <div className="grid-kpi">
              <Kpi label={t('dashboard.queue.open')} value={fmt.number(total)} />
              <Kpi label={t('risk.critical')} value={fmt.number(by('critical'))} />
              <Kpi label={t('risk.high')} value={fmt.number(by('high'))} />
              <Kpi label={t('dashboard.queue.appeals')} value={fmt.number(s.openAppeals)} />
              <Kpi
                label={t('dashboard.queue.oldest')}
                value={oldest ? fmt.date(oldest) : t('common.none')}
              />
            </div>
          );
        }}
      </ResourceView>
    </Section>
  );
}

function MetricsSection() {
  const { t, fmt } = useI18n();
  const api = useAdminApi();
  const eng = useResource((signal) => api.analytics.engagement(30, { signal }), [api]);
  const msa = useResource((signal) => api.analytics.msa(1, { signal }), [api]);
  const cell = (v: number | null) => (v === null ? t('chart.suppressed') : fmt.number(v));
  return (
    <Section
      title={t('dashboard.metrics.title')}
      description={t('dashboard.metrics.desc')}
      actions={
        <Link href="/analytics/msa" className="link-btn">
          {t('dashboard.metrics.open')}
        </Link>
      }
    >
      <div className="stack">
        <ResourceView resource={eng}>
          {(e) =>
            isUnavailable(e) ? (
              <p className="muted">{t('analytics.unavailable')}</p>
            ) : (
              <div className="grid-kpi">
                <Kpi label={t('dashboard.metrics.dau')} value={cell(e.current.dau)} />
                <Kpi label={t('dashboard.metrics.wau')} value={cell(e.current.wau)} />
                <Kpi label={t('dashboard.metrics.mau')} value={cell(e.current.mau)} />
                <Kpi
                  label={t('dashboard.metrics.stickiness')}
                  value={
                    e.current.stickiness === null
                      ? t('chart.suppressed')
                      : fmt.percent(e.current.stickiness)
                  }
                />
              </div>
            )
          }
        </ResourceView>
        <ResourceView resource={msa}>
          {(m) => {
            if (isUnavailable(m)) return <p className="muted">{t('analytics.unavailable')}</p>;
            const w = m.windows[0];
            if (!w) return null;
            return (
              <div className="grid-kpi">
                <Kpi
                  label={t('dashboard.metrics.mwp')}
                  value={cell(w.mwp)}
                  note={t('dashboard.metrics.window', { from: w.windowStart, to: w.windowEnd })}
                />
                <Kpi label={t('dashboard.metrics.participants')} value={cell(w.participants)} />
                <Kpi
                  label={t('dashboard.metrics.mwpShare')}
                  value={w.mwpShare === null ? t('chart.suppressed') : fmt.percent(w.mwpShare)}
                />
              </div>
            );
          }}
        </ResourceView>
      </div>
    </Section>
  );
}

function AccessSection() {
  const { t, label } = useI18n();
  const { role, permissions } = useAdmin();
  return (
    <Section
      title={t('dashboard.access.title')}
      description={t('dashboard.access.desc', { role: label('role', role) })}
    >
      <ul className="row" aria-label={t('dashboard.access.title')}>
        {[...permissions].sort().map((p) => (
          <li key={p}>
            <Badge tone="neutral">
              <code>{p}</code>
            </Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function DashboardView() {
  const { t } = useI18n();
  const { can, atLeast, user } = useAdmin();
  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        lead={t('dashboard.lead', { name: user.profile.displayName })}
      />
      <div className="page-body">
        {can('system.read') ? <HealthSection /> : null}
        {atLeast('moderator') ? <QueueSection /> : null}
        {can('analytics.read') ? <MetricsSection /> : null}
        <AccessSection />
      </div>
    </>
  );
}
