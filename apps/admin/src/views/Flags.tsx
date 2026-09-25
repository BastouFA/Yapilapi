'use client';

import { useId, useState } from 'react';
import { Badge, Button, FormField, Input, Switch } from '@yapilapi/ui';
import type { FlagOverride, FlagView } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import { MutationDialog, PageHeader, ResourceView, Section, ShortId } from '@/components/common';
import { isUuid } from '@/lib/ids';

/** Human summary of how far a flag reaches: "Off", "On for everyone" or "On for 25% of people". */
export function rolloutKind(
  f: Pick<FlagView, 'enabled' | 'rolloutPct'>,
): 'off' | 'all' | 'partial' | 'zero' {
  if (!f.enabled) return 'off';
  if (f.rolloutPct >= 100) return 'all';
  return f.rolloutPct <= 0 ? 'zero' : 'partial';
}

function EditFlag({
  flag,
  open,
  onClose,
  onDone,
}: {
  flag: FlagView;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const api = useAdminApi();
  const [enabled, setEnabled] = useState(flag.enabled);
  const [pct, setPct] = useState(flag.rolloutPct);
  const rangeId = useId();
  const changed = enabled !== flag.enabled || pct !== flag.rolloutPct;
  const disabling = flag.enabled && !enabled;
  return (
    <MutationDialog
      open={open}
      onClose={onClose}
      title={t('flags.edit.title', { key: flag.key })}
      description={t('flags.edit.desc')}
      tone={disabling ? 'danger' : 'primary'}
      submitLabel={t('flags.edit.submit')}
      reasonLabel={t('flags.edit.reason')}
      valid={changed}
      {...(disabling ? { confirmPhrase: flag.key } : {})}
      onSubmit={(reason) =>
        api.flags.update(flag.key, {
          ...(enabled !== flag.enabled ? { enabled } : {}),
          ...(pct !== flag.rolloutPct ? { rolloutPct: pct } : {}),
          reason,
        })
      }
      successMessage={t('flags.edit.done', { key: flag.key })}
      onDone={onDone}
    >
      <Switch
        label={t('flags.enabled')}
        description={t('flags.enabledHint')}
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <div className="stack-sm">
        <label htmlFor={rangeId} className="yl-field__label">
          {t('flags.rollout')}
        </label>
        <div className="range-row">
          <input
            id={rangeId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
            aria-describedby={`${rangeId}-h`}
          />
          <output htmlFor={rangeId}>{pct}%</output>
        </div>
        <p id={`${rangeId}-h`} className="muted">
          {t('flags.rolloutHint')}
        </p>
      </div>
    </MutationDialog>
  );
}

function Overrides({
  flag,
  canWrite,
  onChanged,
}: {
  flag: FlagView;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const api = useAdminApi();
  const res = useResource((signal) => api.flags.overrides(flag.key, { signal }), [api, flag.key]);
  const [userId, setUserId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FlagOverride | null>(null);
  const idOk = isUuid(userId.trim());
  return (
    <div className="stack">
      <ResourceView
        resource={res}
        isEmpty={(d) => d.items.length === 0}
        emptyTitle={t('flags.overrides.emptyTitle')}
        emptyBody={t('flags.overrides.emptyBody')}
      >
        {(d) => (
          <DataTable
            caption={t('flags.overrides.title', { key: flag.key })}
            rows={d.items}
            rowKey={(o) => o.userId}
            columns={[
              {
                id: 'u',
                header: t('flags.overrides.user'),
                rowHeader: true,
                cell: (o) => o.username ?? <ShortId id={o.userId} />,
              },
              {
                id: 'e',
                header: t('flags.overrides.value'),
                cell: (o) => (
                  <Badge tone={o.enabled ? 'success' : 'neutral'}>
                    {o.enabled ? t('flags.on') : t('flags.off')}
                  </Badge>
                ),
              },
              ...(canWrite
                ? [
                    {
                      id: 'a',
                      header: t('common.actions'),
                      cell: (o: FlagOverride) => (
                        <Button size="sm" variant="danger" onClick={() => setRemoving(o)}>
                          {t('flags.overrides.remove')}
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </ResourceView>
      {canWrite ? (
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            if (idOk) setAdding(true);
          }}
          aria-label={t('flags.overrides.add')}
        >
          <FormField
            label={t('flags.overrides.userId')}
            description={t('flags.overrides.userIdHint')}
            className="yl-field--grow"
            {...(userId && !idOk ? { error: t('flags.overrides.userIdInvalid') } : {})}
          >
            <Input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <Switch
            label={t('flags.overrides.forceOn')}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <Button type="submit" variant="secondary" disabled={!idOk}>
            {t('flags.overrides.add')}
          </Button>
        </form>
      ) : null}
      <MutationDialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('flags.overrides.addTitle', { key: flag.key })}
        description={t('flags.overrides.addDesc')}
        submitLabel={t('flags.overrides.add')}
        reasonLabel={t('flags.edit.reason')}
        onSubmit={(reason) => api.flags.setOverride(flag.key, userId.trim(), { enabled, reason })}
        successMessage={t('flags.overrides.added')}
        onDone={() => {
          setUserId('');
          res.reload();
          onChanged();
        }}
      />
      {removing ? (
        <MutationDialog
          open
          onClose={() => setRemoving(null)}
          title={t('flags.overrides.removeTitle', { key: flag.key })}
          description={t('flags.overrides.removeDesc')}
          tone="danger"
          submitLabel={t('flags.overrides.remove')}
          confirmPhrase={removing.username ?? removing.userId.slice(0, 8)}
          onSubmit={() => api.flags.removeOverride(flag.key, removing.userId)}
          successMessage={t('flags.overrides.removed')}
          onDone={() => {
            setRemoving(null);
            res.reload();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function FlagCard({
  flag,
  canWrite,
  onChanged,
}: {
  flag: FlagView;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t, fmt } = useI18n();
  const [editing, setEditing] = useState(false);
  const kind = rolloutKind(flag);
  return (
    <li className="panel">
      <div className="panel__body flag-card">
        <div className="flag-card__head">
          <div>
            <p className="flag-card__key">{flag.key}</p>
            <p className="muted">{flag.description ?? t('common.none')}</p>
          </div>
          <div className="row">
            <Badge tone={kind === 'all' ? 'success' : kind === 'off' ? 'neutral' : 'warning'}>
              {t(`flags.state.${kind}`, { pct: flag.rolloutPct })}
            </Badge>
            {!flag.known ? <Badge tone="warning">{t('flags.unknown')}</Badge> : null}
            {canWrite ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {t('flags.edit.open')}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="muted">
          {t('flags.meta', { count: flag.overrides ?? 0, when: fmt.dateTime(flag.updatedAt) })}
        </p>
        {(flag.overrides ?? 0) > 0 || canWrite ? (
          <details>
            <summary>{t('flags.overrides.summary', { count: flag.overrides ?? 0 })}</summary>
            <Overrides flag={flag} canWrite={canWrite} onChanged={onChanged} />
          </details>
        ) : null}
        {editing ? (
          <EditFlag
            flag={flag}
            open
            onClose={() => setEditing(false)}
            onDone={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

export function FlagsView() {
  const { t } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const res = useResource((signal) => api.flags.list({ signal }), [api]);
  return (
    <>
      <PageHeader
        title={t('flags.title')}
        lead={can('flags.write') ? t('flags.lead') : t('flags.leadReadOnly')}
      />
      <div className="page-body">
        <p className="yl-notice yl-notice--info" role="note">
          {t('flags.propagation')}
        </p>
        <Section title={t('flags.list.title')} description={t('flags.list.desc')}>
          <ResourceView
            resource={res}
            isEmpty={(d) => d.items.length === 0}
            emptyTitle={t('flags.emptyTitle')}
            emptyBody={t('flags.emptyBody')}
          >
            {(d) => (
              <ul className="stack" aria-label={t('flags.list.title')}>
                {d.items.map((f) => (
                  <FlagCard
                    key={f.key}
                    flag={f}
                    canWrite={can('flags.write')}
                    onChanged={res.reload}
                  />
                ))}
              </ul>
            )}
          </ResourceView>
        </Section>
        <p className="muted">{t('flags.gap')}</p>
      </div>
    </>
  );
}
