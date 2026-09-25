'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ExperienceMemberRole,
  ExperienceVisibility,
  TogetherContribution,
  TogetherExperienceView,
  TogetherMember,
} from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  PeopleIcon,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

type Tab = 'timeline' | 'members' | 'settings';

const STATUS_KEYS = {
  open: 'together.status.open',
  closed: 'together.status.closed',
  archived: 'together.status.archived',
} as const;
const ROLE_KEYS = {
  owner: 'together.role.owner',
  contributor: 'together.role.contributor',
  viewer: 'together.role.viewer',
} as const satisfies Record<ExperienceMemberRole, string>;
const MEMBERSHIP_KEYS = {
  invited: 'together.membership.invited',
  joined: 'together.membership.joined',
  declined: 'together.membership.declined',
} as const;

function fail(toast: ReturnType<typeof useToast>, t: ReturnType<typeof useI18n>['t'], e: unknown) {
  toast.show({
    tone: 'danger',
    title: t('error.actionFailed'),
    description: describeError(e, t).message,
  });
}

// ------------------------------------------------------------------ timeline
function ContributeForm({ id, onAdded }: { id: string; onAdded: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [mediaId, setMediaId] = useState('');
  const [realCaptureId, setRealCaptureId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.together.addContribution(id, {
        body: text.trim() || undefined,
        mediaId: mediaId.trim() || undefined,
        realCaptureId: realCaptureId.trim() || undefined,
      });
      setText('');
      setMediaId('');
      setRealCaptureId('');
      onAdded();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('together.contribute')}</h3>
      <FormField label={t('together.contribute.text')}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      </FormField>
      <FormField label={t('together.contribute.mediaId')}>
        <Input value={mediaId} onChange={(e) => setMediaId(e.target.value)} />
      </FormField>
      <FormField label={t('together.contribute.realCaptureId')}>
        <Input value={realCaptureId} onChange={(e) => setRealCaptureId(e.target.value)} />
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        loading={busy}
        disabled={!text.trim() && !mediaId.trim() && !realCaptureId.trim()}
        onClick={() => void submit()}
      >
        {t('together.contribute.submit')}
      </Button>
    </Card>
  );
}

function ContributionRow({
  experienceId,
  x,
  isOwner,
  coverContributionId,
  onCoverChanged,
  onRemoved,
}: {
  experienceId: string;
  x: TogetherContribution;
  isOwner: boolean;
  coverContributionId: string | null;
  onCoverChanged: (contributionId: string) => void;
  onRemoved: () => void;
}) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const setAsCover = async () => {
    setBusy(true);
    try {
      const r = await api.together.setCover(experienceId, x.id);
      toast.show({ tone: 'success', title: t('together.cover.pinned') });
      if (r.cover) onCoverChanged(r.cover.contributionId);
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.together.removeContribution(experienceId, x.id);
      onRemoved();
    } catch (e) {
      fail(toast, t, e);
      setBusy(false);
    }
  };

  return (
    <li className="search-row">
      <span className="search-row__text">
        <span>
          <strong>{x.contributor.displayName}</strong> {x.text}
          {coverContributionId === x.id ? (
            <Badge tone="success">{t('together.cover.pin')}</Badge>
          ) : null}
        </span>
        <span className="muted">{fmt.relative(x.takenAt)}</span>
      </span>
      <div className="button-row">
        {coverContributionId !== x.id ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setAsCover()}>
            {isOwner ? t('together.cover.pin') : t('together.cover.vote')}
          </Button>
        ) : null}
        {x.mine ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
            {t('together.contribution.remove')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function TimelinePanel({ x }: { x: TogetherExperienceView }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<TogetherContribution>(
    (cursor, signal) => api.together.timeline(x.id, { order: 'asc', limit: 20, cursor, signal }),
    `timeline:${x.id}`,
  );
  const [cover, setCover] = useState<string | null>(x.cover?.contributionId ?? null);

  return (
    <div className="stack">
      {x.viewer.canContribute ? <ContributeForm id={x.id} onAdded={state.reload} /> : null}
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <p className="muted">{t('together.timeline.empty')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((c) => (
            <ContributionRow
              key={c.id}
              experienceId={x.id}
              x={c}
              isOwner={x.viewer.isOwner}
              coverContributionId={cover}
              onCoverChanged={setCover}
              onRemoved={state.reload}
            />
          ))}
        </ul>
      ) : null}
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </div>
  );
}

// ------------------------------------------------------------------ members
function MembersPanel({ x, onChanged }: { x: TogetherExperienceView; onChanged: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.together.members(x.id, { signal }), [api, x.id]);
  const suggested = useAsync(
    (signal) => api.together.suggestedInvites(x.id, { signal }),
    [api, x.id],
  );
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'contributor' | 'viewer'>('contributor');
  const [busy, setBusy] = useState(false);

  const invite = async (uid: string) => {
    setBusy(true);
    try {
      await api.together.invite(x.id, uid, role);
      toast.show({ tone: 'success', title: t('together.members.invited') });
      setUserId('');
      state.reload();
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const setMemberRole = async (m: TogetherMember, r: 'contributor' | 'viewer') => {
    try {
      await api.together.setMemberRole(x.id, m.user.id, r);
      state.reload();
    } catch (e) {
      fail(toast, t, e);
    }
  };
  const removeMember = async (m: TogetherMember) => {
    try {
      await api.together.removeMember(x.id, m.user.id);
      toast.show({ tone: 'success', title: t('together.members.removed') });
      state.reload();
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    }
  };

  return (
    <div className="stack">
      {x.viewer.isOwner ? (
        <Card padding="md" className="stack-sm">
          <FormField label={t('together.members.inviteUserId')}>
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
          </FormField>
          <FormField label={t('together.members.inviteRole')}>
            <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="contributor">{t('together.role.contributor')}</option>
              <option value="viewer">{t('together.role.viewer')}</option>
            </Select>
          </FormField>
          <Button
            size="sm"
            loading={busy}
            disabled={!userId.trim()}
            onClick={() => void invite(userId.trim())}
          >
            {t('together.members.invite')}
          </Button>
        </Card>
      ) : null}

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('together.members.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).length > 0 ? (
        <ul className="stack-sm">
          {(state.data?.items ?? []).map((m) => (
            <li key={m.user.id} className="search-row">
              <span className="search-row__text">
                <span>{m.user.displayName}</span>
                <span className="muted">
                  {t(ROLE_KEYS[m.role])} · {t(MEMBERSHIP_KEYS[m.status])}
                </span>
              </span>
              {x.viewer.isOwner && m.role !== 'owner' ? (
                <div className="button-row">
                  {m.role !== 'contributor' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void setMemberRole(m, 'contributor')}
                    >
                      {t('together.members.setRole')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void setMemberRole(m, 'viewer')}
                    >
                      {t('together.members.setRoleViewer')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void removeMember(m)}>
                    {t('together.members.remove')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {x.viewer.isOwner ? (
        <Card padding="md" className="stack-sm">
          <h3 className="section-title">{t('together.suggested.title')}</h3>
          {suggested.data && suggested.data.suggestions.length === 0 ? (
            <p className="muted">{t('together.suggested.empty')}</p>
          ) : null}
          {(suggested.data?.suggestions ?? []).map((s) => (
            <div key={s.userId} className="search-row">
              <span className="search-row__text">{s.displayName}</span>
              <Button size="sm" variant="ghost" onClick={() => void invite(s.userId)}>
                {t('together.suggested.invite')}
              </Button>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ settings
function SettingsPanel({
  x,
  onSaved,
}: {
  x: TogetherExperienceView;
  onSaved: (v: TogetherExperienceView) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [title, setTitle] = useState(x.title);
  const [description, setDescription] = useState(x.description);
  const [visibility, setVisibility] = useState<ExperienceVisibility>(x.visibility);
  const [showOnProfile, setShowOnProfile] = useState(x.viewer.showOnProfile);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const v = await api.together.update(x.id, {
        title: title.trim(),
        description: description.trim(),
        visibility,
      });
      toast.show({ tone: 'success', title: t('together.settings.saved') });
      onSaved(v);
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const saveProfileOptIn = async (v: boolean) => {
    setShowOnProfile(v);
    try {
      await api.together.setProfileOptIn(x.id, v);
      toast.show({ tone: 'success', title: t('together.settings.saved') });
    } catch (e) {
      fail(toast, t, e);
      setShowOnProfile(!v);
    }
  };
  const exportAsMemory = async () => {
    setExportBusy(true);
    try {
      await api.together.exportAsMemory(x.id);
      toast.show({ tone: 'success', title: t('together.settings.exported') });
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="stack">
      {x.viewer.membership === 'joined' ? (
        <Card padding="md" className="stack-sm">
          <Switch
            label={t('together.settings.showOnProfile')}
            checked={showOnProfile}
            onChange={(e) => void saveProfileOptIn(e.target.checked)}
          />
          <Button size="sm" loading={exportBusy} onClick={() => void exportAsMemory()}>
            {t('together.settings.exportAsMemory')}
          </Button>
        </Card>
      ) : null}

      {x.viewer.isOwner ? (
        <Card padding="md" className="stack-sm">
          <FormField label={t('together.form.title')} required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
          <FormField label={t('together.form.description')}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </FormField>
          <FormField label={t('together.form.visibility')}>
            <Select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as ExperienceVisibility)}
            >
              <option value="private">{t('together.form.visibility.private')}</option>
              <option value="friends">{t('together.form.visibility.friends')}</option>
              <option value="public">{t('together.form.visibility.public')}</option>
            </Select>
          </FormField>
          <Button size="sm" loading={busy} disabled={!title.trim()} onClick={() => void save()}>
            {t('memory.edit.save')}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ shell
export function TogetherDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const state = useAsync((signal) => api.together.get(id, { signal }), [api, id]);
  const [tab, setTab] = useState<Tab>('timeline');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [keepContributions, setKeepContributions] = useState(false);
  const [busy, setBusy] = useState(false);
  usePageTitle(state.data?.title, t('app.name'));

  const del = async () => {
    setBusy(true);
    try {
      await api.together.remove(id);
      toast.show({ tone: 'success', title: t('together.deleted') });
      router.push('/together');
    } catch (e) {
      fail(toast, t, e);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    setBusy(true);
    try {
      await api.together.leave(id, keepContributions);
      toast.show({ tone: 'success', title: t('together.left') });
      router.push('/together');
    } catch (e) {
      fail(toast, t, e);
      setLeaveOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const accept = async () => {
    setBusy(true);
    try {
      const v = await api.together.accept(id);
      toast.show({ tone: 'success', title: t('together.accepted') });
      state.setData(v);
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    try {
      await api.together.decline(id);
      toast.show({ tone: 'success', title: t('together.declined') });
      router.push('/together');
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    try {
      const v = await api.together.close(id);
      toast.show({ tone: 'success', title: t('together.closed') });
      state.setData(v);
    } catch (e) {
      fail(toast, t, e);
    }
  };
  const reopen = async () => {
    try {
      const v = await api.together.reopen(id);
      toast.show({ tone: 'success', title: t('together.reopened') });
      state.setData(v);
    } catch (e) {
      fail(toast, t, e);
    }
  };
  const archive = async () => {
    try {
      const v = await api.together.archive(id);
      toast.show({ tone: 'success', title: t('together.archived') });
      state.setData(v);
    } catch (e) {
      fail(toast, t, e);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const x = state.data;
  if (!x) return <EmptyState icon={<PeopleIcon size={28} />} title={t('together.notFound')} />;

  return (
    <>
      <PageHeader
        title={x.title}
        lead={<Badge>{t(STATUS_KEYS[x.status])}</Badge>}
        actions={
          <div className="button-row">
            {x.viewer.membership === 'invited' ? (
              <>
                <Button size="sm" loading={busy} onClick={() => void accept()}>
                  {t('together.accept')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decline()}>
                  {t('together.decline')}
                </Button>
              </>
            ) : null}
            {x.viewer.membership === 'joined' && !x.viewer.isOwner ? (
              <Button size="sm" variant="ghost" onClick={() => setLeaveOpen(true)}>
                {t('together.leave')}
              </Button>
            ) : null}
            {x.viewer.isOwner ? (
              <>
                {x.status === 'open' ? (
                  <Button size="sm" variant="secondary" onClick={() => void close()}>
                    {t('together.close')}
                  </Button>
                ) : null}
                {x.status === 'closed' ? (
                  <Button size="sm" variant="secondary" onClick={() => void reopen()}>
                    {t('together.reopen')}
                  </Button>
                ) : null}
                {x.status !== 'archived' ? (
                  <Button size="sm" variant="secondary" onClick={() => void archive()}>
                    {t('together.archive')}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
                  {t('together.delete')}
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <FeedTabs
        label={x.title}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'timeline', label: t('together.tab.timeline') },
          { id: 'members', label: t('together.tab.members') },
          { id: 'settings', label: t('together.tab.settings') },
        ]}
      >
        {tab === 'timeline' ? <TimelinePanel key="timeline" x={x} /> : null}
        {tab === 'members' ? <MembersPanel key="members" x={x} onChanged={state.reload} /> : null}
        {tab === 'settings' ? (
          <SettingsPanel key="settings" x={x} onSaved={(v) => state.setData(v)} />
        ) : null}
      </FeedTabs>

      <ConfirmDialog
        open={deleteOpen}
        title={t('together.deleteConfirm.title')}
        description={t('together.deleteConfirm.body')}
        confirmLabel={t('together.delete')}
        danger
        busy={busy}
        onConfirm={() => void del()}
        onClose={() => setDeleteOpen(false)}
      />
      <ConfirmDialog
        open={leaveOpen}
        title={t('together.leaveConfirm.title')}
        description={t('together.leaveConfirm.body')}
        confirmLabel={t('together.leave')}
        danger
        busy={busy}
        onConfirm={() => void leave()}
        onClose={() => setLeaveOpen(false)}
      >
        <Switch
          label={t('together.leaveConfirm.keep')}
          checked={keepContributions}
          onChange={(e) => setKeepContributions(e.target.checked)}
        />
      </ConfirmDialog>
    </>
  );
}
