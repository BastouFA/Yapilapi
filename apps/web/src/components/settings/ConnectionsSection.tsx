'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { Circle, CircleKind, UserCard } from '@yapilapi/api-client';
import { ApiError } from '@yapilapi/api-client';
import { Button, Dialog, FormField, Input, Select, Spinner, useToast } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { ConfirmDialog, ErrorView } from '@/components/common';
import { FormError } from '@/components/forms';
import { UserRow } from '@/components/profile/UserRow';
import { SettingsCard } from './shared';

export function ConnectionsSection() {
  const api = useApi();
  const { t } = useI18n();
  return (
    <div className="stack">
      <FollowRequests />
      <FriendRequests />
      <CirclesCard />
      <PeopleList
        id="cn-blocked"
        title={t('connections.blockedTitle')}
        help={t('connections.blockedHelp')}
        empty={t('connections.blockedEmpty')}
        load={(signal) => api.graph.blocks({ signal }).then((r) => r.items)}
        actionLabel={t('connections.unblock')}
        actionAria={(u) => t('connections.unblockAria', { username: u.username })}
        run={(u) => api.graph.unblock(u.username)}
      />
      <PeopleList
        id="cn-muted"
        title={t('connections.mutedTitle')}
        help={t('connections.mutedHelp')}
        empty={t('connections.mutedEmpty')}
        load={(signal) => api.graph.mutes({ signal }).then((r) => r.items)}
        actionLabel={t('connections.unmute')}
        actionAria={(u) => t('connections.unmuteAria', { username: u.username })}
        run={(u) => api.graph.unmute(u.username)}
      />
      <PeopleList
        id="cn-restricted"
        title={t('connections.restrictedTitle')}
        help={t('connections.restrictedHelp')}
        empty={t('connections.restrictedEmpty')}
        load={(signal) => api.graph.restrictions({ signal }).then((r) => r.items)}
        actionLabel={t('connections.unrestrict')}
        actionAria={(u) => t('connections.unrestrictAria', { username: u.username })}
        run={(u) => api.graph.unrestrict(u.username)}
      />
    </div>
  );
}

/** A list of people, each with one action; the row disappears when the action succeeds. */
function PeopleList({
  id,
  title,
  help,
  empty,
  load,
  actionLabel,
  actionAria,
  run,
  extra,
}: {
  id: string;
  title: string;
  help?: string;
  empty: string;
  load: (signal: AbortSignal) => Promise<UserCard[]>;
  actionLabel: string;
  actionAria: (u: UserCard) => string;
  run: (u: UserCard) => Promise<unknown>;
  extra?: (u: UserCard, done: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const list = useAsync(load, []);
  const [busy, setBusy] = useState<string | null>(null);
  const doIt = async (u: UserCard) => {
    setBusy(u.id);
    try {
      await run(u);
      list.setData((d) => d?.filter((x) => x.id !== u.id));
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsCard id={id} title={title} description={help}>
      {list.loading && !list.data ? <Spinner label={t('common.loading')} /> : null}
      {list.error && !list.data ? <ErrorView error={list.error} onRetry={list.reload} /> : null}
      {list.data && list.data.length === 0 ? <p className="muted">{empty}</p> : null}
      {list.data && list.data.length > 0 ? (
        <ul className="person-list" aria-label={title}>
          {list.data.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              actions={
                <>
                  {extra?.(u, () => list.setData((d) => d?.filter((x) => x.id !== u.id)))}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void doIt(u)}
                    loading={busy === u.id}
                    loadingLabel={t('common.working')}
                    aria-label={actionAria(u)}
                  >
                    {actionLabel}
                  </Button>
                </>
              }
            />
          ))}
        </ul>
      ) : null}
    </SettingsCard>
  );
}

function FollowRequests() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  return (
    <PeopleList
      id="cn-follow"
      title={t('connections.followRequestsTitle')}
      help={t('connections.followRequestsHelp')}
      empty={t('connections.followRequestsEmpty')}
      load={(signal) => api.graph.followRequests({ signal }).then((r) => r.items)}
      actionLabel={t('connections.deny')}
      actionAria={(u) => t('connections.denyAria', { username: u.username })}
      run={(u) => api.graph.denyFollowRequest(u.id)}
      extra={(u, done) => (
        <Button
          size="sm"
          onClick={() => {
            api.graph.approveFollowRequest(u.id).then(done, (e: unknown) =>
              toast.show({
                tone: 'danger',
                title: t('error.actionFailed'),
                description: describeError(e, t).message,
              }),
            );
          }}
          aria-label={t('connections.approveAria', { username: u.username })}
          data-testid={`approve-${u.username}`}
        >
          {t('connections.approve')}
        </Button>
      )}
    />
  );
}

function FriendRequests() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');
  return (
    <>
      <div className="segmented" role="group" aria-label={t('connections.friendRequestsTitle')}>
        <Button
          size="sm"
          variant={tab === 'incoming' ? 'primary' : 'secondary'}
          aria-pressed={tab === 'incoming'}
          onClick={() => setTab('incoming')}
        >
          {t('connections.incoming')}
        </Button>
        <Button
          size="sm"
          variant={tab === 'outgoing' ? 'primary' : 'secondary'}
          aria-pressed={tab === 'outgoing'}
          onClick={() => setTab('outgoing')}
        >
          {t('connections.outgoing')}
        </Button>
      </div>
      {tab === 'incoming' ? (
        <PeopleList
          key="in"
          id="cn-friends-in"
          title={t('connections.friendRequestsIn')}
          empty={t('connections.friendRequestsEmpty')}
          load={(signal) => api.graph.friendRequests('incoming', { signal }).then((r) => r.items)}
          actionLabel={t('connections.decline')}
          actionAria={(u) => t('connections.declineAria', { username: u.username })}
          run={(u) => api.graph.removeFriend(u.id)}
          extra={(u, done) => (
            <Button
              size="sm"
              onClick={() => {
                api.graph.acceptFriendRequest(u.id).then(done, (e: unknown) =>
                  toast.show({
                    tone: 'danger',
                    title: t('error.actionFailed'),
                    description: describeError(e, t).message,
                  }),
                );
              }}
              aria-label={t('connections.acceptAria', { username: u.username })}
            >
              {t('connections.accept')}
            </Button>
          )}
        />
      ) : (
        <PeopleList
          key="out"
          id="cn-friends-out"
          title={t('connections.friendRequestsOut')}
          empty={t('connections.friendRequestsOutEmpty')}
          load={(signal) => api.graph.friendRequests('outgoing', { signal }).then((r) => r.items)}
          actionLabel={t('connections.cancelRequest')}
          actionAria={(u) => t('connections.cancelRequestAria', { username: u.username })}
          run={(u) => api.graph.removeFriend(u.id)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ circles
const KINDS: CircleKind[] = ['close_friends', 'family', 'work', 'business', 'travel', 'custom'];

function CirclesCard() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const circles = useAsync((signal) => api.graph.circles({ signal }), [api]);
  const [kind, setKind] = useState<CircleKind>('close_friends');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState<Circle | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('connections.circleNameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api.graph.createCircle(kind, name.trim());
      circles.setData((d) => ({ items: [...(d?.items ?? []), c] }));
      setName('');
      toast.show({ tone: 'success', title: t('connections.circleCreated') });
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      id="cn-circles"
      title={t('connections.circlesTitle')}
      description={t('connections.circlesHelp')}
    >
      {circles.loading && !circles.data ? <Spinner label={t('common.loading')} /> : null}
      {circles.error && !circles.data ? (
        <ErrorView error={circles.error} onRetry={circles.reload} />
      ) : null}
      {circles.data && circles.data.items.length === 0 ? (
        <p className="muted">{t('connections.circlesEmpty')}</p>
      ) : null}
      {circles.data && circles.data.items.length > 0 ? (
        <ul className="person-list" aria-label={t('connections.circlesTitle')}>
          {circles.data.items.map((c) => (
            <li key={c.id} className="person-row">
              <div className="person-row__text">
                <strong>{c.name}</strong>
                <span className="person-row__handle">
                  {t(`connections.kind.${c.kind}`)} ·{' '}
                  {t('connections.members', { count: c.memberCount })}
                </span>
              </div>
              <div className="person-row__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setManage(c)}
                  aria-label={t('connections.manageAria', { name: c.name })}
                >
                  {t('connections.manage')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(e) => void create(e)}
        noValidate
        className="stack"
        aria-label={t('connections.newCircle')}
      >
        <h4 className="section-title">{t('connections.newCircle')}</h4>
        <div className="inline-form">
          <FormField label={t('connections.circleKind')}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as CircleKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`connections.kind.${k}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('connections.circleName')} className="yl-grow">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              data-testid="circle-name"
            />
          </FormField>
          <Button
            type="submit"
            loading={busy}
            loadingLabel={t('common.working')}
            data-testid="circle-create"
          >
            {t('connections.createCircle')}
          </Button>
        </div>
        <FormError>{error}</FormError>
      </form>
      {manage ? (
        <CircleDialog
          circle={manage}
          onClose={() => setManage(null)}
          onRenamed={(c) => {
            circles.setData((d) => d && { items: d.items.map((x) => (x.id === c.id ? c : x)) });
            setManage(c);
          }}
          onDeleted={(id) => {
            circles.setData((d) => d && { items: d.items.filter((x) => x.id !== id) });
            setManage(null);
          }}
          onCount={(id, delta) =>
            circles.setData(
              (d) =>
                d && {
                  items: d.items.map((x) =>
                    x.id === id ? { ...x, memberCount: Math.max(0, x.memberCount + delta) } : x,
                  ),
                },
            )
          }
        />
      ) : null}
    </SettingsCard>
  );
}

function CircleDialog({
  circle,
  onClose,
  onRenamed,
  onDeleted,
  onCount,
}: {
  circle: Circle;
  onClose: () => void;
  onRenamed: (c: Circle) => void;
  onDeleted: (id: string) => void;
  onCount: (id: string, delta: number) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const members = useAsync(
    (signal) => api.graph.circleMembers(circle.id, { signal }),
    [api, circle.id],
  );
  const [name, setName] = useState(circle.name);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fail = (e: unknown) => setError(describeError(e, t).message);
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === circle.name) return;
    setBusy(true);
    setError(null);
    try {
      await api.graph.renameCircle(circle.id, name.trim());
      onRenamed({ ...circle, name: name.trim() });
      toast.show({ tone: 'success', title: t('common.saved') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().replace(/^@/, '');
    if (!u) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.profile.get(u);
      await api.graph.addCircleMember(circle.id, p.id);
      members.setData((d) => ({
        items: [
          ...(d?.items ?? []).filter((x) => x.id !== p.id),
          {
            id: p.id,
            username: p.username,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl,
            mode: p.mode,
            isPrivate: p.isPrivate,
          },
        ],
      }));
      onCount(circle.id, 1);
      setUsername('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setError(t('composer.selectedNotFound'));
      else fail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (u: UserCard) => {
    setError(null);
    try {
      await api.graph.removeCircleMember(circle.id, u.id);
      members.setData((d) => d && { items: d.items.filter((x) => x.id !== u.id) });
      onCount(circle.id, -1);
    } catch (err) {
      fail(err);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.graph.deleteCircle(circle.id);
      onDeleted(circle.id);
      toast.show({ tone: 'success', title: t('connections.circleDeleted') });
    } catch (err) {
      fail(err);
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={!confirmDelete}
        onClose={onClose}
        title={t('connections.circleDialog', { name: circle.name })}
        closeLabel={t('common.close')}
        footer={
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {t('connections.deleteCircle')}
          </Button>
        }
      >
        <div className="stack">
          <form onSubmit={(e) => void rename(e)} className="inline-form" noValidate>
            <FormField label={t('connections.circleName')} className="yl-grow">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </FormField>
            <Button type="submit" variant="secondary" disabled={busy}>
              {t('connections.rename')}
            </Button>
          </form>
          <h3 className="section-title">{t('connections.membersTitle')}</h3>
          {members.loading && !members.data ? <Spinner label={t('common.loading')} /> : null}
          {members.data && members.data.items.length === 0 ? (
            <p className="muted">{t('connections.noMembers')}</p>
          ) : null}
          {members.data && members.data.items.length > 0 ? (
            <ul className="person-list" aria-label={t('connections.membersTitle')}>
              {members.data.items.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  actions={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void remove(u)}
                      aria-label={t('connections.removeMemberAria', { username: u.username })}
                    >
                      {t('common.remove')}
                    </Button>
                  }
                />
              ))}
            </ul>
          ) : null}
          <form onSubmit={(e) => void add(e)} className="inline-form" noValidate>
            <FormField
              label={t('connections.addMember')}
              description={t('connections.addMemberHelp')}
              className="yl-grow"
            >
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                dir="ltr"
                autoComplete="off"
              />
            </FormField>
            <Button type="submit" variant="secondary" disabled={busy || !username.trim()}>
              {t('common.add')}
            </Button>
          </form>
          <FormError>{error}</FormError>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('connections.deleteCircleTitle', { name: circle.name })}
        description={t('connections.deleteCircleBody')}
        confirmLabel={t('common.delete')}
        danger
        busy={busy}
        onConfirm={() => void del()}
      />
    </>
  );
}
