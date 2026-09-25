'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RadioGroup, Radio } from '@yapilapi/ui';
import type { AppealRow, CaseDetail } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useAdmin } from '@/lib/session';
import { JsonFacts, MutationDialog, SubNav } from '@/components/common';

export function ModerationNav({
  current,
}: {
  current: 'queue' | 'appeals' | 'reports' | 'identity';
}) {
  const { t } = useI18n();
  const { atLeast } = useAdmin();
  const items = [
    { id: 'queue', href: '/moderation', label: t('mod.nav.queue') },
    ...(atLeast('moderator')
      ? [{ id: 'appeals', href: '/moderation/appeals', label: t('mod.nav.appeals') }]
      : []),
    { id: 'reports', href: '/moderation/reports', label: t('mod.nav.reports') },
    ...(atLeast('moderator')
      ? [{ id: 'identity', href: '/moderation/identity', label: t('mod.nav.identity') }]
      : []),
  ];
  return <SubNav label={t('mod.nav.label')} items={items} current={current} />;
}

const TEXT_KEYS = ['body', 'text', 'title', 'name', 'displayName', 'description', 'bio'];

/** Evidence snapshot: readable text fields first, then every other field as facts. */
export function SnapshotView({ value }: { value: Record<string, unknown> | null | undefined }) {
  const { t } = useI18n();
  if (!value || Object.keys(value).length === 0)
    return <p className="muted">{t('mod.snapshot.none')}</p>;
  const texts = TEXT_KEYS.filter(
    (k) => typeof value[k] === 'string' && (value[k] as string).length > 0,
  );
  const rest = Object.fromEntries(Object.entries(value).filter(([k]) => !texts.includes(k)));
  return (
    <div className="stack-sm">
      {texts.map((k) => (
        <div key={k}>
          <p className="muted">{k}</p>
          <blockquote className="quote" data-testid={`snapshot-${k}`}>
            {String(value[k])}
          </blockquote>
        </div>
      ))}
      <JsonFacts value={rest} />
    </div>
  );
}

export type Appeal = AppealRow | CaseDetail['appeals'][number];

/** Review an appeal. Reviewer separation is enforced by the API; its refusal (with request id) is shown in the dialog. */
export function AppealReviewDialog({
  appealId,
  statement,
  originalDeciderId,
  open,
  onClose,
  onDone,
}: {
  appealId: string;
  statement: string;
  originalDeciderId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const { user } = useAdmin();
  const [outcome, setOutcome] = useState<'upheld' | 'overturned'>('upheld');
  const conflictNote = originalDeciderId !== null && originalDeciderId === user.id;
  return (
    <MutationDialog
      open={open}
      onClose={onClose}
      title={t('mod.appeal.reviewTitle')}
      description={t('mod.appeal.reviewDesc')}
      submitLabel={t('mod.appeal.submit')}
      reasonLabel={t('mod.appeal.note')}
      tone={outcome === 'overturned' ? 'danger' : 'primary'}
      onSubmit={(note) => api.moderation.reviewAppeal(appealId, { outcome, note })}
      successMessage={(r) =>
        t('mod.appeal.done', { outcome: label('appealStatus', r.status), restored: r.restored })
      }
      onDone={onDone}
    >
      <blockquote className="quote">{statement}</blockquote>
      {conflictNote ? (
        <p className="yl-notice yl-notice--warning" role="note">
          {t('mod.appeal.sameDecider')}
        </p>
      ) : null}
      <RadioGroup
        legend={t('mod.appeal.outcome')}
        name={`outcome-${appealId}`}
        value={outcome}
        onValueChange={(v) => setOutcome(v as 'upheld' | 'overturned')}
      >
        <Radio
          value="upheld"
          label={t('mod.appeal.upheld')}
          description={t('mod.appeal.upheldDesc')}
        />
        <Radio
          value="overturned"
          label={t('mod.appeal.overturned')}
          description={t('mod.appeal.overturnedDesc')}
        />
      </RadioGroup>
    </MutationDialog>
  );
}

export const caseLink = (id: string, text?: string) => (
  <Link href={`/moderation/cases/${id}`}>{text ?? id.slice(0, 8)}</Link>
);
