'use client';

import { Badge, Card, EmptyState, SparkIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';

/** What the assistant did on your behalf, and how much of today's allowance is left. */
export function UsageView() {
  const api = useApi();
  const { t, fmt } = useI18n();
  usePageTitle(t('ai.usage.title'), t('app.name'));

  const usage = useAsync((signal) => api.ai.usage({ signal }), [api]);
  const calls = useAsync((signal) => api.ai.toolCalls({ limit: 50, signal }), [api]);

  return (
    <>
      <PageHeader title={t('ai.usage.title')} lead={t('ai.usage.lead')} />

      {usage.loading ? <PageSpinner /> : null}
      {usage.error ? <ErrorView error={usage.error} onRetry={usage.reload} /> : null}
      {usage.data ? (
        <div className="card-grid">
          <Card padding="md" className="stack-sm">
            <span className="muted">{t('ai.usage.requests')}</span>
            <strong>{fmt.number(usage.data.user.requests)}</strong>
          </Card>
          <Card padding="md" className="stack-sm">
            <span className="muted">{t('ai.usage.tokensIn')}</span>
            <strong>{fmt.number(usage.data.user.tokensUsed)}</strong>
          </Card>
          <Card padding="md" className="stack-sm">
            <span className="muted">{t('ai.usage.remainingLabel')}</span>
            <strong>
              {usage.data.user.tokenLimit > 0
                ? t('ai.usage.remaining', { count: usage.data.user.tokensRemaining })
                : t('ai.usage.unlimited')}
            </strong>
          </Card>
        </div>
      ) : null}

      <section aria-labelledby="ai-tool-calls-h" className="stack-sm">
        <h2 id="ai-tool-calls-h" className="section-title">
          {t('ai.usage.toolCallsTitle')}
        </h2>
        {calls.loading ? <PageSpinner /> : null}
        {calls.error ? <ErrorView error={calls.error} onRetry={calls.reload} /> : null}
        {!calls.loading && !calls.error && calls.data?.items.length === 0 ? (
          <EmptyState icon={<SparkIcon size={28} />} title={t('ai.usage.toolCallsEmpty')} />
        ) : null}
        {calls.data && calls.data.items.length > 0 ? (
          <ul className="stack-sm">
            {calls.data.items.map((c) => (
              <li key={c.id} className="search-row">
                <span className="search-row__text">
                  <span>{c.tool}</span>
                  <span className="muted">{fmt.relative(c.at)}</span>
                </span>
                <Badge
                  tone={
                    c.outcome === 'allowed'
                      ? 'success'
                      : c.outcome === 'denied'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {t(`ai.usage.outcome.${c.outcome}`)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
