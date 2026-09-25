'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, FormField, Input, Select, Textarea, useToast } from '@yapilapi/ui';
import {
  PLATFORM_ROLE_NAMES,
  type AdminUserDetail,
  type PlatformRoleName,
} from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import {
  ErrorNotice,
  Facts,
  MutationDialog,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';

function Notes({ id }: { id: string }) {
  const { t } = useI18n();
  const api = useAdminApi();
  const toast = useToast();
  const { can } = useAdmin();
  const notes = useResource((signal) => api.users.notes(id, { signal }), [api, id]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.users.addNote(id, body.trim());
      toast.show({ tone: 'success', title: t('users.notes.added') });
      setBody('');
      notes.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('users.notes.title')} description={t('users.notes.desc')}>
      <div className="stack">
        {can('users.note') ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (body.trim()) void add();
            }}
          >
            <FormField label={t('users.notes.new')}>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={2000}
                rows={3}
              />
            </FormField>
            {error ? <ErrorNotice error={error} /> : null}
            <div>
              <Button
                type="submit"
                loading={busy}
                loadingLabel={t('common.working')}
                disabled={!body.trim()}
              >
                {t('users.notes.add')}
              </Button>
            </div>
          </form>
        ) : null}
        <ResourceView
          resource={notes}
          isEmpty={(d) => d.items.length === 0}
          emptyTitle={t('users.notes.emptyTitle')}
          emptyBody={t('users.notes.emptyBody')}
        >
          {(d) => (
            <ul className="stack-sm" aria-label={t('users.notes.title')}>
              {d.items.map((n) => (
                <li key={n.id} className="quote">
                  <p>{n.body}</p>
                  <p className="muted">
                    {n.author ?? t('common.unknown')} · <Time value={n.createdAt} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </ResourceView>
      </div>
    </Section>
  );
}

function Actions({ u, onChanged }: { u: AdminUserDetail; onChanged: () => void }) {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const [dlg, setDlg] = useState<'suspend' | 'reactivate' | 'role' | null>(null);
  const [days, setDays] = useState('7');
  const [role, setRole] = useState<PlatformRoleName>(u.role);
  const phrase = u.username ?? u.id;
  const showSuspend = can('users.suspend') && u.actions.canSuspend && u.status !== 'suspended';
  const showReactivate =
    can('users.reactivate') && u.actions.canReactivate && u.status === 'suspended';
  const showRole = can('users.role_change') && u.actions.canChangeRole;
  if (!showSuspend && !showReactivate && !showRole)
    return <p className="muted">{t('users.actions.none')}</p>;
  const dayNum = Number(days);
  return (
    <>
      <div className="row">
        {showSuspend ? (
          <Button variant="danger" onClick={() => setDlg('suspend')}>
            {t('users.actions.suspend')}
          </Button>
        ) : null}
        {showReactivate ? (
          <Button variant="secondary" onClick={() => setDlg('reactivate')}>
            {t('users.actions.reactivate')}
          </Button>
        ) : null}
        {showRole ? (
          <Button
            variant="secondary"
            onClick={() => {
              setRole(u.role);
              setDlg('role');
            }}
          >
            {t('users.actions.role')}
          </Button>
        ) : null}
      </div>

      <MutationDialog
        open={dlg === 'suspend'}
        onClose={() => setDlg(null)}
        title={t('users.suspend.title', { name: phrase })}
        description={t('users.suspend.desc')}
        tone="danger"
        submitLabel={t('users.actions.suspend')}
        reasonLabel={t('users.suspend.reason')}
        reasonHint={t('users.suspend.reasonHint')}
        confirmPhrase={phrase}
        valid={Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 90}
        onSubmit={(reason) => api.users.suspend(u.id, { reason, days: dayNum })}
        successMessage={(r) => t('users.suspend.done', { name: phrase, until: r.endsAt ?? '' })}
        onDone={onChanged}
      >
        <FormField
          label={t('users.suspend.days')}
          description={t('users.suspend.daysHint')}
          required
          requiredLabel={t('common.required')}
        >
          <Input
            type="number"
            min={1}
            max={90}
            step={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            inputMode="numeric"
          />
        </FormField>
      </MutationDialog>

      <MutationDialog
        open={dlg === 'reactivate'}
        onClose={() => setDlg(null)}
        title={t('users.reactivate.title', { name: phrase })}
        description={t('users.reactivate.desc')}
        submitLabel={t('users.actions.reactivate')}
        reasonLabel={t('users.reactivate.reason')}
        onSubmit={(reason) => api.users.reactivate(u.id, reason)}
        successMessage={t('users.reactivate.done', { name: phrase })}
        onDone={onChanged}
      />

      <MutationDialog
        open={dlg === 'role'}
        onClose={() => setDlg(null)}
        title={t('users.role.title', { name: phrase })}
        description={t('users.role.desc')}
        tone="danger"
        submitLabel={t('users.role.submit')}
        reasonLabel={t('users.role.reason')}
        confirmPhrase={phrase}
        valid={role !== u.role}
        onSubmit={(reason) => api.users.setRole(u.id, { role, reason })}
        successMessage={(r) => t('users.role.done', { name: phrase, role: label('role', r.role) })}
        onDone={onChanged}
      >
        <FormField
          label={t('users.role.new')}
          description={t('users.role.hint')}
          required
          requiredLabel={t('common.required')}
        >
          <Select value={role} onChange={(e) => setRole(e.target.value as PlatformRoleName)}>
            {PLATFORM_ROLE_NAMES.map((r) => (
              <option key={r} value={r}>
                {label('role', r)}
              </option>
            ))}
          </Select>
        </FormField>
      </MutationDialog>
    </>
  );
}

export function UserDetailView({ id }: { id: string }) {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const res = useResource((signal) => api.users.get(id, { signal }), [api, id]);
  return (
    <>
      <p className="crumb">
        <Link href="/users">{t('users.back')}</Link>
      </p>
      <ResourceView resource={res}>
        {(u) => (
          <>
            <PageHeader
              title={u.username ?? u.id}
              lead={u.displayName ?? undefined}
              actions={
                <>
                  <StatusBadge group="status" value={u.status} />
                  <Badge tone="primary">{label('role', u.role)}</Badge>
                </>
              }
            />
            <div className="page-body">
              <Section title={t('users.overview')} description={t('users.overviewDesc')}>
                <Facts
                  items={[
                    [
                      t('users.f.id'),
                      <code key="id" className="mono">
                        {u.id}
                      </code>,
                    ],
                    [
                      t('users.f.email'),
                      <span key="e" dir="ltr" className="mono">
                        {u.email}
                        {u.emailVerified ? '' : ` (${t('users.f.unverified')})`}
                      </span>,
                    ],
                    [t('users.f.country'), u.countryCode ?? t('common.none')],
                    [t('users.f.age'), label('ageBand', u.ageBand)],
                    [t('users.f.mfa'), u.mfaEnabled ? t('common.yes') : t('common.no')],
                    [t('users.f.created'), <Time key="c" value={u.createdAt} />],
                    [t('users.f.lastLogin'), <Time key="l" value={u.lastLoginAt} />],
                    [
                      t('users.f.private'),
                      u.private === null
                        ? t('common.none')
                        : u.private
                          ? t('common.yes')
                          : t('common.no'),
                    ],
                    [
                      t('users.f.followers'),
                      u.followers === null ? t('common.none') : fmt.number(u.followers),
                    ],
                    [t('users.f.deletion'), <Time key="d" value={u.deletionScheduledFor} />],
                    [t('users.f.posts'), fmt.number(u.counts.posts)],
                    [t('users.f.comments'), fmt.number(u.counts.comments)],
                    [t('users.f.sessions'), fmt.number(u.counts.activeSessions)],
                    [t('users.f.reports'), fmt.number(u.counts.reportsAgainst)],
                  ]}
                />
              </Section>
              <Section title={t('users.actions.title')} description={t('users.actions.desc')}>
                <Actions u={u} onChanged={res.reload} />
              </Section>
              <Section title={t('users.enforcements.title')}>
                {u.enforcements.length === 0 ? (
                  <p className="muted">{t('users.enforcements.none')}</p>
                ) : (
                  <DataTable
                    caption={t('users.enforcements.title')}
                    rows={u.enforcements}
                    rowKey={(e) => e.id}
                    columns={[
                      {
                        id: 'kind',
                        header: t('users.enf.kind'),
                        rowHeader: true,
                        cell: (e) => label('enforcement', e.kind),
                      },
                      {
                        id: 'reason',
                        header: t('users.enf.reason'),
                        cell: (e) => e.reason ?? t('common.none'),
                      },
                      {
                        id: 'pts',
                        header: t('users.enf.points'),
                        numeric: true,
                        cell: (e) => e.strikePoints,
                      },
                      {
                        id: 'from',
                        header: t('users.enf.starts'),
                        cell: (e) => <Time value={e.startsAt} />,
                      },
                      {
                        id: 'to',
                        header: t('users.enf.ends'),
                        cell: (e) => <Time value={e.endsAt} />,
                      },
                      {
                        id: 'rev',
                        header: t('users.enf.revoked'),
                        cell: (e) => <Time value={e.revokedAt} />,
                      },
                      { id: 'eid', header: t('users.enf.id'), cell: (e) => <ShortId id={e.id} /> },
                    ]}
                  />
                )}
              </Section>
              <Notes id={id} />
            </div>
          </>
        )}
      </ResourceView>
    </>
  );
}
