'use client';

import { useState } from 'react';
import { Button, FormField, Input, EmptyState } from '@yapilapi/ui';
import type { ImpersonationResult } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { DataTable } from '@/components/DataTable';
import { Filters, PageHeader, ResourceView, Section, StatusBadge } from '@/components/common';
import { ModerationNav } from './moderation-shared';

export function IdentityView() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [q, setQ] = useState<{ username: string; displayName: string } | null>(null);
  const res = useResource(
    async (signal): Promise<ImpersonationResult | null> => {
      if (!q) return null;
      return api.moderation.impersonationCheck({
        ...(q.username ? { username: q.username } : {}),
        ...(q.displayName ? { displayName: q.displayName } : {}),
        signal,
      });
    },
    [api, q],
  );
  const canRun = username.trim() !== '' || displayName.trim() !== '';
  return (
    <>
      <PageHeader title={t('identity.title')} lead={t('identity.lead')} />
      <ModerationNav current="identity" />
      <div className="page-body">
        <Filters
          label={t('identity.title')}
          onSubmit={() => {
            if (canRun) setQ({ username: username.trim(), displayName: displayName.trim() });
          }}
        >
          <FormField label={t('identity.username')}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label={t('identity.displayName')}>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={80}
              autoComplete="off"
            />
          </FormField>
          <Button type="submit" disabled={!canRun}>
            {t('identity.check')}
          </Button>
        </Filters>
        {!q ? (
          <EmptyState
            title={t('identity.promptTitle')}
            description={t('identity.promptBody')}
            headingLevel={2}
          />
        ) : (
          <ResourceView resource={res}>
            {(r) =>
              r === null ? null : (
                <Section title={t('identity.result')}>
                  <div className="stack">
                    <p role="status">
                      <StatusBadge group="identityRisk" value={r.risk} />{' '}
                      {t(`identity.risk.${r.risk}`)}
                    </p>
                    {r.matches.length ? (
                      <DataTable
                        caption={t('identity.matches')}
                        rows={r.matches}
                        rowKey={(m) => `${m.identityId}-${m.field}-${m.reason}`}
                        columns={[
                          {
                            id: 'kind',
                            header: t('identity.col.kind'),
                            rowHeader: true,
                            cell: (m) => label('identityKind', m.kind),
                          },
                          {
                            id: 'field',
                            header: t('identity.col.field'),
                            cell: (m) => label('identityField', m.field),
                          },
                          {
                            id: 'reason',
                            header: t('identity.col.reason'),
                            cell: (m) => label('identityReason', m.reason),
                          },
                          {
                            id: 'score',
                            header: t('identity.col.score'),
                            numeric: true,
                            cell: (m) => fmt.percent(m.score),
                          },
                        ]}
                      />
                    ) : (
                      <p className="muted">{t('identity.noMatches')}</p>
                    )}
                    <p className="muted">{t('identity.note')}</p>
                  </div>
                </Section>
              )
            }
          </ResourceView>
        )}
      </div>
    </>
  );
}
