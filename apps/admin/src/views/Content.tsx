'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, EmptyState, FormField, Input, Select } from '@yapilapi/ui';
import { CONTENT_TYPES, type ContentType } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import {
  Filters,
  JsonFacts,
  MutationDialog,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';
import { isUuid } from '@/lib/ids';

function MediaTools() {
  const { t } = useI18n();
  const api = useAdminApi();
  const [mediaId, setMediaId] = useState('');
  const [dlg, setDlg] = useState<'block' | 'unblock' | null>(null);
  const ok = isUuid(mediaId.trim());
  return (
    <Section title={t('content.media.title')} description={t('content.media.desc')}>
      <form
        className="filters"
        onSubmit={(e) => e.preventDefault()}
        aria-label={t('content.media.title')}
      >
        <FormField label={t('content.media.id')} className="yl-field--grow">
          <Input
            value={mediaId}
            onChange={(e) => setMediaId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <Button variant="danger" disabled={!ok} onClick={() => setDlg('block')}>
          {t('content.media.block')}
        </Button>
        <Button variant="secondary" disabled={!ok} onClick={() => setDlg('unblock')}>
          {t('content.media.unblock')}
        </Button>
      </form>
      <MutationDialog
        open={dlg === 'block'}
        onClose={() => setDlg(null)}
        title={t('content.media.blockTitle')}
        description={t('content.media.blockDesc')}
        tone="danger"
        submitLabel={t('content.media.block')}
        reasonLabel={t('content.media.reason')}
        confirmPhrase={mediaId.trim().slice(0, 8)}
        onSubmit={(reason) => api.content.blockMedia(mediaId.trim(), reason)}
        successMessage={t('content.media.blocked')}
      />
      <MutationDialog
        open={dlg === 'unblock'}
        onClose={() => setDlg(null)}
        title={t('content.media.unblockTitle')}
        description={t('content.media.unblockDesc')}
        submitLabel={t('content.media.unblock')}
        onSubmit={() => api.content.unblockMedia(mediaId.trim())}
        successMessage={t('content.media.unblocked')}
      />
    </Section>
  );
}

export function ContentView() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const { atLeast } = useAdmin();
  const [type, setType] = useState<ContentType>('post');
  const [id, setId] = useState('');
  const [target, setTarget] = useState<{ type: ContentType; id: string } | null>(null);
  const res = useResource(
    async (signal) => (target ? api.content.lookup(target.type, target.id, { signal }) : null),
    [api, target],
  );
  const valid = isUuid(id.trim());

  return (
    <>
      <PageHeader title={t('content.title')} lead={t('content.lead')} />
      <div className="page-body">
        <Filters
          label={t('content.lookupLabel')}
          onSubmit={() => {
            if (valid) setTarget({ type, id: id.trim() });
          }}
        >
          <FormField label={t('content.type')}>
            <Select value={type} onChange={(e) => setType(e.target.value as ContentType)}>
              {CONTENT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {label('targetType', c)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={t('content.id')}
            description={valid || !id ? undefined : t('content.idInvalid')}
            className="yl-field--grow"
          >
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              invalid={Boolean(id) && !valid}
            />
          </FormField>
          <Button type="submit" disabled={!valid}>
            {t('content.lookup')}
          </Button>
        </Filters>
        {!target ? (
          <EmptyState
            title={t('content.promptTitle')}
            description={t('content.promptBody')}
            headingLevel={2}
          />
        ) : (
          <ResourceView resource={res}>
            {(d) =>
              d && (
                <>
                  <Section
                    title={t('content.result', { type: label('targetType', d.type) })}
                    description={t('content.resultDesc')}
                  >
                    <div className="stack">
                      <dl className="facts">
                        <div>
                          <dt>{t('content.f.id')}</dt>
                          <dd>
                            <code className="mono">{d.id}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{t('content.f.owner')}</dt>
                          <dd>
                            {d.ownerId ? (
                              <Link href={`/users/${d.ownerId}`}>
                                <code className="mono">{d.ownerId}</code>
                              </Link>
                            ) : (
                              t('common.none')
                            )}
                          </dd>
                        </div>
                      </dl>
                      <h3 className="panel__title">{t('content.snapshot')}</h3>
                      <JsonFacts value={d.snapshot} />
                    </div>
                  </Section>
                  <Section title={t('content.cases')}>
                    {d.cases.length === 0 ? (
                      <p className="muted">{t('content.noCases')}</p>
                    ) : (
                      <DataTable
                        caption={t('content.cases')}
                        rows={d.cases}
                        rowKey={(c) => c.id}
                        columns={[
                          {
                            id: 'id',
                            header: t('mod.col.case'),
                            rowHeader: true,
                            cell: (c) => (
                              <Link href={`/moderation/cases/${c.id}`}>
                                <ShortId id={c.id} />
                              </Link>
                            ),
                          },
                          {
                            id: 'state',
                            header: t('mod.col.state'),
                            cell: (c) => <StatusBadge group="caseState" value={c.state} />,
                          },
                          {
                            id: 'risk',
                            header: t('mod.col.risk'),
                            cell: (c) => <StatusBadge group="risk" value={c.risk_level} />,
                          },
                          {
                            id: 'cats',
                            header: t('mod.col.categories'),
                            cell: (c) => c.categories.map((x) => label('category', x)).join(', '),
                          },
                          {
                            id: 'dec',
                            header: t('mod.col.decision'),
                            cell: (c) =>
                              c.decision ? label('decision', c.decision) : t('common.none'),
                          },
                          {
                            id: 'at',
                            header: t('mod.col.created'),
                            cell: (c) => <Time value={c.created_at} />,
                          },
                        ]}
                      />
                    )}
                  </Section>
                </>
              )
            }
          </ResourceView>
        )}
        {atLeast('moderator') ? <MediaTools /> : null}
      </div>
    </>
  );
}
