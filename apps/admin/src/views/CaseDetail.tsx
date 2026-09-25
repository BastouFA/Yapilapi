'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, FormField, Input, Select, useToast } from '@yapilapi/ui';
import { DECISIONS, type CaseDetail, type Decision } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import {
  Facts,
  JsonFacts,
  MutationDialog,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';
import { AppealReviewDialog, SnapshotView } from './moderation-shared';

/** Decisions that change an account or remove content: they need the typed confirmation. */
export const DESTRUCTIVE_DECISIONS: readonly Decision[] = ['remove', 'suspend_user', 'ban_user'];

/**
 * Which decisions the signed-in role may attempt on a case in this state. This only shapes the form: the API is the
 * authority (ban needs an admin, escalated cases are decided by admins, appealed cases by the appeal reviewer).
 */
export function decisionOptions(opts: {
  targetType: string;
  hasSubject: boolean;
  canBan: boolean;
}): Decision[] {
  return DECISIONS.filter((d) => {
    if (d === 'ban_user' && !opts.canBan) return false;
    if ((d === 'suspend_user' || d === 'ban_user') && !opts.hasSubject) return false;
    if (d === 'remove' && opts.targetType === 'user') return false;
    return true;
  });
}

function DecideDialog({
  c,
  open,
  onClose,
  onDone,
}: {
  c: CaseDetail;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const options = decisionOptions({
    targetType: c.targetType,
    hasSubject: c.subject !== null,
    canBan: can('cases.ban'),
  });
  const [decision, setDecision] = useState<Decision>(options[0] ?? 'no_action');
  const [days, setDays] = useState('7');
  const [note, setNote] = useState('');
  const destructive = DESTRUCTIVE_DECISIONS.includes(decision);
  const dayNum = Number(days);
  const daysOk =
    decision !== 'suspend_user' || (Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 365);
  const phrase = c.id.slice(0, 8);
  return (
    <MutationDialog
      open={open}
      onClose={onClose}
      title={t('case.decide.title')}
      description={t('case.decide.desc')}
      tone={destructive ? 'danger' : 'primary'}
      submitLabel={t('case.decide.submit')}
      reasonLabel={t('case.decide.reason')}
      reasonHint={t('case.decide.reasonHint')}
      valid={daysOk}
      {...(destructive ? { confirmPhrase: phrase } : {})}
      onSubmit={(reason) =>
        api.moderation.decide(c.id, {
          decision,
          reason,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(decision === 'suspend_user' ? { durationDays: dayNum } : {}),
        })
      }
      successMessage={(r) => t('case.decide.done', { decision: label('decision', r.decision) })}
      onDone={onDone}
    >
      <FormField label={t('case.decide.decision')} required requiredLabel={t('common.required')}>
        <Select value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
          {options.map((d) => (
            <option key={d} value={d}>
              {label('decision', d)}
            </option>
          ))}
        </Select>
      </FormField>
      <p className="muted" role="note">
        {t(`case.decide.effect.${decision}`)}
      </p>
      {decision === 'suspend_user' ? (
        <FormField
          label={t('case.decide.days')}
          description={t('case.decide.daysHint')}
          required
          requiredLabel={t('common.required')}
        >
          <Input
            type="number"
            min={1}
            max={365}
            step={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            inputMode="numeric"
          />
        </FormField>
      ) : null}
      <FormField label={t('case.decide.note')} description={t('case.decide.noteHint')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </FormField>
    </MutationDialog>
  );
}

function Actions({ c, reload }: { c: CaseDetail; reload: () => void }) {
  const { t } = useI18n();
  const api = useAdminApi();
  const toast = useToast();
  const { user, atLeast, can } = useAdmin();
  const [dlg, setDlg] = useState<'decide' | 'escalate' | null>(null);
  const [busy, setBusy] = useState<'claim' | 'release' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const senior = atLeast('admin');
  const mine = c.assignedTo === user.id;
  const open = c.state !== 'resolved';
  const canDecide =
    can('cases.decide') &&
    open &&
    c.state !== 'appealed' &&
    (c.state !== 'escalated' || can('cases.escalated'));
  const canClaim = open && !mine && (c.state !== 'escalated' || can('cases.escalated'));
  const canRelease = open && c.assignedTo !== null && (mine || senior);
  const canEscalate =
    can('cases.decide') && open && c.state !== 'escalated' && c.state !== 'appealed';

  const run = async (kind: 'claim' | 'release') => {
    setBusy(kind);
    setErr(null);
    try {
      await (kind === 'claim' ? api.moderation.claim(c.id) : api.moderation.release(c.id));
      toast.show({
        tone: 'success',
        title: kind === 'claim' ? t('case.claimed') : t('case.released'),
      });
      reload();
    } catch (e) {
      setErr(describeError(e, t).message);
    } finally {
      setBusy(null);
    }
  };

  if (!can('cases.decide')) return <p className="muted">{t('case.actions.readOnly')}</p>;
  if (!open) return <p className="muted">{t('case.actions.resolved')}</p>;
  return (
    <div className="stack-sm">
      <div className="row">
        {canClaim ? (
          <Button
            variant="secondary"
            onClick={() => void run('claim')}
            loading={busy === 'claim'}
            loadingLabel={t('common.working')}
          >
            {t('case.claim')}
          </Button>
        ) : null}
        {canRelease ? (
          <Button
            variant="secondary"
            onClick={() => void run('release')}
            loading={busy === 'release'}
            loadingLabel={t('common.working')}
          >
            {t('case.release')}
          </Button>
        ) : null}
        {canEscalate ? (
          <Button variant="secondary" onClick={() => setDlg('escalate')}>
            {t('case.escalate')}
          </Button>
        ) : null}
        {canDecide ? (
          <Button onClick={() => setDlg('decide')}>{t('case.decide.open')}</Button>
        ) : null}
      </div>
      {c.state === 'appealed' ? <p className="muted">{t('case.actions.appealed')}</p> : null}
      {c.state === 'escalated' && !can('cases.escalated') ? (
        <p className="muted">{t('case.actions.escalated')}</p>
      ) : null}
      {err ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {err}
        </p>
      ) : null}
      <MutationDialog
        open={dlg === 'escalate'}
        onClose={() => setDlg(null)}
        title={t('case.escalate.title')}
        description={t('case.escalate.desc')}
        submitLabel={t('case.escalate')}
        reasonLabel={t('case.escalate.note')}
        onSubmit={(note) => api.moderation.escalate(c.id, note)}
        successMessage={t('case.escalate.done')}
        onDone={reload}
      />
      {dlg === 'decide' ? (
        <DecideDialog c={c} open onClose={() => setDlg(null)} onDone={reload} />
      ) : null}
    </div>
  );
}

function Detail({ c, reload }: { c: CaseDetail; reload: () => void }) {
  const { t, label, fmt } = useI18n();
  const { can, user } = useAdmin();
  const [review, setReview] = useState<CaseDetail['appeals'][number] | null>(null);
  const s = c.subjectSummary;
  const lp = c.ladderPreview;
  return (
    <>
      <PageHeader
        title={t('case.title', { id: c.id.slice(0, 8) })}
        lead={t('case.lead', { target: label('targetType', c.targetType) })}
        actions={
          <>
            <StatusBadge group="risk" value={c.riskLevel} />
            <StatusBadge group="caseState" value={c.state} />
          </>
        }
      />
      <div className="page-body">
        <Section title={t('case.summary')}>
          <Facts
            items={[
              [
                t('case.f.id'),
                <code key="i" className="mono">
                  {c.id}
                </code>,
              ],
              [
                t('case.f.target'),
                <span key="t">
                  {label('targetType', c.targetType)} <ShortId id={c.targetId} />
                </span>,
              ],
              [t('case.f.source'), label('source', c.source)],
              [
                t('case.f.categories'),
                c.categories.map((x) => label('category', x)).join(', ') || t('common.none'),
              ],
              [t('case.f.reports'), fmt.number(c.reportCount)],
              [
                t('case.f.assigned'),
                c.assignedTo ? (
                  c.assignedTo === user.id ? (
                    t('mod.assignedToMe')
                  ) : (
                    <ShortId key="a" id={c.assignedTo} />
                  )
                ) : (
                  t('mod.unassigned')
                ),
              ],
              [t('case.f.created'), <Time key="c" value={c.createdAt} />],
              [t('case.f.decided'), <Time key="d" value={c.decidedAt} />],
            ]}
          />
        </Section>

        <Section title={t('case.actions.title')} description={t('case.actions.desc')}>
          <Actions c={c} reload={reload} />
        </Section>

        <div className="case-layout">
          <div className="stack">
            <Section title={t('case.evidence.title')} description={t('case.evidence.desc')}>
              <SnapshotView value={c.snapshot} />
            </Section>
            <Section title={t('case.current.title')} description={t('case.current.desc')}>
              <SnapshotView value={c.currentContent} />
            </Section>
            {c.signals && Object.keys(c.signals).length ? (
              <Section title={t('case.signals.title')} description={t('case.signals.desc')}>
                <JsonFacts value={c.signals} />
              </Section>
            ) : null}
            <Section title={t('case.reports.title')} description={t('case.reports.desc')}>
              {c.reports.length === 0 ? (
                <p className="muted">{t('case.reports.none')}</p>
              ) : (
                <DataTable
                  caption={t('case.reports.title')}
                  rows={c.reports}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      id: 'reason',
                      header: t('mod.reports.reason'),
                      rowHeader: true,
                      cell: (r) => label('reportReason', r.reason),
                    },
                    {
                      id: 'details',
                      header: t('case.reports.details'),
                      cell: (r) => <span className="wrap">{r.details ?? t('common.none')}</span>,
                    },
                    {
                      id: 'status',
                      header: t('mod.reports.status'),
                      cell: (r) => <StatusBadge group="reportStatus" value={r.status} />,
                    },
                    {
                      id: 'reporter',
                      header: t('mod.reports.col.reporter'),
                      cell: (r) =>
                        r.reporterId ? <ShortId id={r.reporterId} /> : t('mod.reports.hidden'),
                    },
                    {
                      id: 'at',
                      header: t('mod.col.created'),
                      cell: (r) => <Time value={r.createdAt} />,
                    },
                  ]}
                />
              )}
            </Section>
          </div>

          <div className="stack">
            {c.decision ? (
              <Section title={t('case.decision.title')}>
                <Facts
                  items={[
                    [t('case.decision.what'), label('decision', c.decision.decision)],
                    [
                      t('case.decision.reason'),
                      <span key="r" className="wrap">
                        {c.decision.reason ?? t('common.none')}
                      </span>,
                    ],
                    [
                      t('case.decision.note'),
                      <span key="n" className="wrap">
                        {c.decision.note ?? t('common.none')}
                      </span>,
                    ],
                    [t('case.decision.by'), <ShortId key="b" id={c.decision.decidedBy} />],
                    [t('case.decision.at'), <Time key="a" value={c.decision.decidedAt} />],
                  ]}
                />
              </Section>
            ) : null}

            {s ? (
              <Section title={t('case.subject.title')} description={t('case.subject.desc')}>
                <div className="stack-sm">
                  <Facts
                    items={[
                      [
                        t('case.subject.user'),
                        can('users.read') ? (
                          <Link key="u" href={`/users/${s.id}`}>
                            {s.username ?? s.id.slice(0, 8)}
                          </Link>
                        ) : (
                          (s.username ?? s.id.slice(0, 8))
                        ),
                      ],
                      [t('users.f.age'), label('ageBand', s.ageBand)],
                      [t('users.status'), <StatusBadge key="s" group="status" value={s.status} />],
                      [
                        t('case.subject.points'),
                        <Badge key="p" tone={s.activeStrikePoints > 0 ? 'warning' : 'neutral'}>
                          {fmt.number(s.activeStrikePoints)}
                        </Badge>,
                      ],
                    ]}
                  />
                  {lp ? (
                    <div className="yl-notice yl-notice--info" role="note" data-testid="ladder">
                      <p>
                        <strong>{t('case.ladder.title')}</strong>
                      </p>
                      <p>
                        {t('case.ladder.ifUpheld', {
                          points: lp.pointsIfViolation,
                          total: lp.totalPoints,
                        })}
                      </p>
                      <p>
                        {!lp.recommendation
                          ? t('case.ladder.noRecommendation')
                          : lp.recommendation.days === null
                            ? t('case.ladder.recommendedOpen', {
                                action: label('ladder', lp.recommendation.action),
                              })
                            : t('case.ladder.recommended', {
                                action: label('ladder', lp.recommendation.action),
                                count: lp.recommendation.days,
                              })}
                      </p>
                      <p className="muted">{t('case.ladder.note')}</p>
                    </div>
                  ) : null}
                  {s.enforcements.length ? (
                    <DataTable
                      caption={t('users.enforcements.title')}
                      rows={s.enforcements}
                      rowKey={(e) => e.id}
                      columns={[
                        {
                          id: 'k',
                          header: t('users.enf.kind'),
                          rowHeader: true,
                          cell: (e) => label('enforcement', e.kind),
                        },
                        {
                          id: 'p',
                          header: t('users.enf.points'),
                          numeric: true,
                          cell: (e) => e.strikePoints,
                        },
                        {
                          id: 'f',
                          header: t('users.enf.starts'),
                          cell: (e) => <Time value={e.startsAt} />,
                        },
                        {
                          id: 'r',
                          header: t('users.enf.revoked'),
                          cell: (e) => <Time value={e.revokedAt} />,
                        },
                      ]}
                    />
                  ) : (
                    <p className="muted">{t('users.enforcements.none')}</p>
                  )}
                </div>
              </Section>
            ) : null}

            <Section title={t('case.appeals.title')}>
              {c.appeals.length === 0 ? (
                <p className="muted">{t('case.appeals.none')}</p>
              ) : (
                <ul className="stack" aria-label={t('case.appeals.title')}>
                  {c.appeals.map((a) => (
                    <li key={a.id} className="stack-sm">
                      <div className="row">
                        <StatusBadge group="appealStatus" value={a.status} />
                        <span className="muted">
                          <Time value={a.createdAt} />
                        </span>
                      </div>
                      <blockquote className="quote">{a.statement}</blockquote>
                      {a.reviewerNote ? (
                        <p className="muted">
                          {t('case.appeals.reviewerNote')}: {a.reviewerNote}
                        </p>
                      ) : null}
                      {a.status === 'open' && can('appeals.review') ? (
                        <div>
                          <Button size="sm" onClick={() => setReview(a)}>
                            {t('mod.appeal.review')}
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t('case.timeline.title')}>
              {c.timeline.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <ol className="timeline" aria-label={t('case.timeline.title')}>
                  {c.timeline.map((e) => (
                    <li key={e.id}>
                      <strong>{label('caseEvent', e.event)}</strong>
                      <span className="muted">
                        <Time value={e.at} />
                        {e.actorId ? (
                          <>
                            {' '}
                            · <ShortId id={e.actorId} />
                          </>
                        ) : null}
                        {e.from && e.to && e.from !== e.to
                          ? ` · ${label('caseState', e.from)} → ${label('caseState', e.to)}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>
        </div>
      </div>
      {review ? (
        <AppealReviewDialog
          appealId={review.id}
          statement={review.statement}
          originalDeciderId={review.originalDeciderId}
          open
          onClose={() => setReview(null)}
          onDone={() => {
            setReview(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

export function CaseDetailView({ id }: { id: string }) {
  const { t } = useI18n();
  const api = useAdminApi();
  const { atLeast } = useAdmin();
  const staff = atLeast('moderator');
  const res = useResource(
    (signal) =>
      staff ? api.moderation.case(id, { signal }) : api.moderation.caseReadOnly(id, { signal }),
    [api, id, staff],
  );
  return (
    <>
      <p className="crumb">
        <Link href="/moderation">{t('case.back')}</Link>
      </p>
      <ResourceView resource={res}>{(c) => <Detail c={c} reload={res.reload} />}</ResourceView>
    </>
  );
}
