'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Avatar, Badge, Button, Card, CardHeadings, Dialog, EmptyState, Select, Stat, TextField } from '@yapilapi/design-system';
import type { AdminContentItem, AdminUserDetail } from '@yapilapi/api-client';
import { formatMoney, formatRelativeTime, MODERATION_TARGET_KEYS, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { ContentRow, RemoveDialog } from '@/components/admin/Content';
import { formatCount, formatWhen, LoadFailed, Loading, useLoad } from '@/components/admin/shared';
import { useSession } from '../../../../providers';

const PROFILE_TYPES: Record<AdminUserDetail['user']['profileType'], MessageKey> = {
  personal: 'admin.user.type.personal',
  creator: 'admin.user.type.creator',
  professional: 'admin.user.type.professional',
  business: 'admin.user.type.business',
};

const CASE_WORDS: Record<string, MessageKey> = {
  report: 'admin.source.report',
  automated: 'admin.source.automated',
  appeal: 'admin.source.appeal',
  ad_review: 'admin.source.adReview',
  admin: 'admin.source.admin',
  open: 'admin.caseStatus.open',
  appealed: 'admin.caseStatus.appealed',
  decided: 'admin.caseStatus.decided',
  final: 'admin.caseStatus.final',
  no_action: 'admin.decision.noAction',
  warn: 'admin.decision.warn',
  restrict: 'admin.decision.restrict',
  remove: 'admin.decision.remove',
  suspend_user: 'admin.decision.suspendUser',
  approve_ad: 'admin.decision.approveAd',
  reject_ad: 'admin.decision.rejectAd',
};
/** A case's source, status or decision in plain words; an unknown code as it is. */
const caseWord = (code: string | null, t: ReturnType<typeof useSession>['t']) =>
  code === null ? '—' : CASE_WORDS[code] ? t(CASE_WORDS[code]) : code.replace(/_/g, ' ');

/** Security events in the words Settings > Security uses for them. */
const eventLabel = (type: string, t: ReturnType<typeof useSession>['t']) => {
  const key = `st.event.${type}` as MessageKey;
  const out = t(key);
  return out === key ? type.replace(/_/g, ' ') : out;
};

const targetLabel = (type: string, t: ReturnType<typeof useSession>['t']) => {
  const key = MODERATION_TARGET_KEYS[type as keyof typeof MODERATION_TARGET_KEYS];
  return key ? t(key) : type.replace(/_/g, ' ');
};

/**
 * One account for the team: who they are, how they sign in, what they post, what was decided about
 * them, money and risk, and what can be done (each change is in the audit log; none on yourself).
 */
export default function AdminUser() {
  const { id } = useParams<{ id: string }>();
  const { me, t, tp, toast, locale } = useSession();
  const { data, setData, error, reload } = useLoad(() => api.admin.user(id), [id]);
  const [removing, setRemoving] = useState<AdminContentItem | null>(null);
  const [confirm, setConfirm] = useState<'suspend' | 'signout' | null>(null);
  const [note, setNote] = useState('');
  if (me?.role !== 'admin') return <EmptyState level={1} title={t('admin.only')} body={t('admin.onlyBody')} />;
  const page = (body: React.ReactNode) => (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <p style={{ margin: 0 }}>
        <Link href="/admin#people">{t('admin.user.back')}</Link>
      </p>
      {body}
    </div>
  );
  if (error) return page(<LoadFailed error={error} onRetry={reload} />);
  if (!data) return page(<Loading />);
  const u = data.user;
  const patchUser = (change: Partial<AdminUserDetail['user']>) => setData((d) => (d ? { ...d, user: { ...d.user, ...change } } : d));
  const act = async (run: () => Promise<unknown>, done: string, after?: () => void) => {
    try {
      await run();
      after?.();
      toast(done);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const items: AdminContentItem[] = data.posts.map((p) => ({
    kind: p.format,
    id: p.id,
    text: p.body,
    author: { id: u.id, username: u.username, displayName: u.displayName },
    createdAt: p.createdAt,
    moderationStatus: p.moderationStatus,
    removed: p.moderationStatus === 'removed',
    deletedByOwner: p.deleted && p.moderationStatus !== 'removed',
    href: p.format === 'reel' ? `/reels/${p.id}` : `/p/${p.id}`,
  }));
  const setPost = (pid: string, moderationStatus: AdminUserDetail['posts'][number]['moderationStatus']) =>
    setData((d) => (d ? { ...d, posts: d.posts.map((p) => (p.id === pid ? { ...p, moderationStatus } : p)) } : d));

  return page(
    <>
      <div className="admin-user__head">
        <Avatar name={u.displayName} src={u.avatarUrl ?? undefined} size="lg" />
        <div className="stack-sm" style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0 }}>
            {u.displayName} <span className="muted">@{u.username}</span>
          </h1>
          <div className="row">
            <Badge tone={u.role === 'user' ? 'neutral' : 'new'}>
              {u.role === 'user' ? t('admin.people.roleUser') : t(u.role === 'admin' ? 'm.role.admin' : 'm.role.moderator')}
            </Badge>
            {u.status === 'suspended' ? <Badge tone="danger">{t('admin.people.suspended')}</Badge> : null}
            {u.deleted ? <Badge tone="danger">{t('admin.user.deleted')}</Badge> : null}
            {data.risk.restrictedAt ? <Badge tone="warning">{t('admin.risk.limited')}</Badge> : null}
            {u.minor ? <Badge tone="warning">{t('admin.user.minor')}</Badge> : null}
            {u.isPrivate ? <Badge tone="neutral">{t('admin.user.private')}</Badge> : null}
            {u.devData ? <Badge tone="neutral">[Dev data]</Badge> : null}
            {data.self ? <Badge tone="neutral">{t('admin.people.you')}</Badge> : null}
          </div>
          {u.bio ? (
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }} dir="auto">
              {u.bio}
            </p>
          ) : null}
          <p style={{ margin: 0 }}>
            <Link href={`/u/${u.username}`}>{t('admin.people.profile')}</Link>
          </p>
        </div>
      </div>
      <CardHeadings level={2}>
        <div className="stack">
          <Card title={t('admin.user.account')}>
            <dl className="admin-facts">
              <div>
                <dt>{t('auth.email')}</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>
                  {u.email}{' '}
                  <Badge tone={u.emailConfirmed ? 'success' : 'warning'}>
                    {t(u.emailConfirmed ? 'admin.risk.emailConfirmed' : 'admin.risk.emailNotConfirmed')}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>{t('admin.user.phone')}</dt>
                <dd>
                  {u.phone ?? '—'}{' '}
                  {u.phone ? (
                    <Badge tone={u.phoneConfirmed ? 'success' : 'warning'}>
                      {t(u.phoneConfirmed ? 'admin.risk.phoneConfirmed' : 'admin.risk.phoneNotConfirmed')}
                    </Badge>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>{t('admin.user.twoStep')}</dt>
                <dd>{u.twoStep ? t('admin.user.on') : t('admin.user.off')}</dd>
              </div>
              <div>
                <dt>{t('admin.user.profileType')}</dt>
                <dd>{t(PROFILE_TYPES[u.profileType])}</dd>
              </div>
              <div>
                <dt>{t('settings.country')}</dt>
                <dd>{u.country ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('admin.user.language')}</dt>
                <dd>{u.locale ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('admin.user.joined')}</dt>
                <dd>{formatWhen(u.createdAt, locale)}</dd>
              </div>
              <div>
                <dt>{t('admin.user.lastActive')}</dt>
                <dd>{u.lastActiveAt ? formatRelativeTime(u.lastActiveAt, locale) : '—'}</dd>
              </div>
              <div>
                <dt>{t('admin.user.risk')}</dt>
                <dd>
                  {t('admin.risk.score', { score: data.risk.score })} · {tp('admin.user.openSignals', data.risk.openSignals)}
                </dd>
              </div>
            </dl>
          </Card>

          {data.self ? (
            <p className="muted">{t('admin.user.selfNote')}</p>
          ) : (
            <Card title={t('admin.user.actions')} subtitle={t('admin.user.actionsSubtitle')}>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div style={{ minWidth: 180 }}>
                  <Select
                    label={t('admin.people.role')}
                    value={u.role}
                    onChange={(e) => {
                      const role = e.currentTarget.value as AdminUserDetail['user']['role'];
                      void act(
                        () => api.admin.setUserRole(u.id, role),
                        t('admin.people.roleChanged'),
                        () => patchUser({ role }),
                      );
                    }}
                  >
                    <option value="user">{t('admin.people.roleUser')}</option>
                    <option value="moderator">{t('m.role.moderator')}</option>
                    <option value="admin">{t('m.role.admin')}</option>
                  </Select>
                </div>
                {u.status === 'suspended' ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      act(
                        () => api.admin.setUserStatus(u.id, 'active'),
                        t('admin.people.reinstated'),
                        () => patchUser({ status: 'active' }),
                      )
                    }
                  >
                    {t('admin.people.reinstate')}
                  </Button>
                ) : u.status === 'active' ? (
                  <Button
                    variant="danger"
                    onClick={() => {
                      setNote('');
                      setConfirm('suspend');
                    }}
                  >
                    {t('admin.people.suspend')}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => setConfirm('signout')} disabled={!data.sessions.length}>
                  {t('admin.user.signOutEverywhere')}
                </Button>
                {!u.emailConfirmed ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      act(
                        () => api.admin.confirmEmail(u.id),
                        t('admin.user.emailMarked'),
                        () => patchUser({ emailConfirmed: true }),
                      )
                    }
                  >
                    {t('admin.user.markEmail')}
                  </Button>
                ) : null}
              </div>
            </Card>
          )}

          <div className="stats">
            <Stat label={t('admin.trend.posts')} value={formatCount(data.counts.posts, locale)} />
            <Stat label={t('admin.trend.reels')} value={formatCount(data.counts.reels, locale)} />
            <Stat label={t('admin.user.followers')} value={formatCount(data.counts.followers, locale)} />
            <Stat label={t('admin.user.following')} value={formatCount(data.counts.following, locale)} />
            <Stat label={t('admin.user.friends')} value={formatCount(data.counts.friends, locale)} />
            <Stat label={t('admin.user.reportsMade')} value={formatCount(data.counts.reportsMade, locale)} />
            <Stat label={t('admin.user.reportsAgainst')} value={formatCount(data.counts.reportsAgainst, locale)} />
          </div>

          <Card title={t('admin.user.posts')} subtitle={t('admin.user.postsSubtitle')}>
            {items.length ? (
              <ul className="admin-list">
                {items.map((it) => (
                  <ContentRow
                    key={it.id}
                    it={it}
                    onRemove={() => setRemoving(it)}
                    onRestore={() =>
                      act(
                        () => api.admin.restoreContent(it.kind, it.id),
                        t('admin.content.restored'),
                        () => setPost(it.id, 'normal'),
                      )
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="muted">{t('admin.user.noPosts')}</p>
            )}
          </Card>

          <Card title={t('admin.user.cases')}>
            {data.cases.length ? (
              <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.user.cases')}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('admin.audit.when')}</th>
                      <th>{t('admin.user.about')}</th>
                      <th>{t('admin.payments.status')}</th>
                      <th>{t('admin.user.decision')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cases.map((c) => (
                      <tr key={c.id}>
                        <td>{formatWhen(c.createdAt, locale)}</td>
                        <td>
                          {targetLabel(c.targetType, t)} <span className="muted">{caseWord(c.source, t)}</span>
                        </td>
                        <td>{caseWord(c.status, t)}</td>
                        <td>
                          {caseWord(c.decision, t)}
                          {c.note ? <div className="muted admin-pre">{c.note}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{t('admin.user.noCases')}</p>
            )}
          </Card>

          <Card title={t('admin.user.sessions')} subtitle={t('admin.user.sessionsSubtitle')}>
            {data.sessions.length ? (
              <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.user.sessions')}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('admin.user.device')}</th>
                      <th>{t('admin.audit.ip')}</th>
                      <th>{t('admin.user.signedIn')}</th>
                      <th>{t('admin.user.lastActive')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s) => (
                      <tr key={s.id}>
                        <td style={{ overflowWrap: 'anywhere' }}>
                          {s.device ?? s.platform ?? ''} <span className="muted">{s.userAgent ?? ''}</span>
                        </td>
                        <td>{s.ip ?? '—'}</td>
                        <td>{formatWhen(s.createdAt, locale)}</td>
                        <td>{formatRelativeTime(s.lastSeenAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{t('admin.user.noSessions')}</p>
            )}
            {data.devices.length ? (
              <>
                <h3 className="admin-subhead">{t('admin.user.devices')}</h3>
                <ul className="admin-plain">
                  {data.devices.map((d) => (
                    <li key={d.id}>
                      {d.name ?? d.platform ?? d.id.slice(0, 8)} <span className="muted">{d.lastSeenAt ? formatRelativeTime(d.lastSeenAt, locale) : ''}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Card>

          <Card title={t('admin.user.security')}>
            {data.securityEvents.length ? (
              <ul className="admin-plain">
                {data.securityEvents.map((e) => (
                  <li key={e.id}>
                    {eventLabel(e.type, t)}{' '}
                    <span className="muted">
                      {formatWhen(e.createdAt, locale)}
                      {e.ip ? ` · ${e.ip}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('admin.user.noSecurity')}</p>
            )}
          </Card>

          <Card title={t('admin.user.money')}>
            <dl className="admin-facts">
              <div>
                <dt>{t('admin.user.bought')}</dt>
                <dd>{data.money.bought.length ? data.money.bought.map((m) => `${formatMoney(m.cents, m.currency, locale)} (${m.count})`).join(', ') : '—'}</dd>
              </div>
              <div>
                <dt>{t('admin.user.sold')}</dt>
                <dd>{data.money.sold.length ? data.money.sold.map((m) => `${formatMoney(m.cents, m.currency, locale)} (${m.count})`).join(', ') : '—'}</dd>
              </div>
              <div>
                <dt>{t('admin.tab.payouts')}</dt>
                <dd>
                  {data.money.payouts.length
                    ? data.money.payouts.map((m) => `${m.status}: ${formatMoney(m.cents, m.currency, locale)} (${m.count})`).join(', ')
                    : '—'}
                </dd>
              </div>
            </dl>
          </Card>

          <Card title={t('admin.user.history')}>
            {data.adminActions.length ? (
              <ul className="admin-plain">
                {data.adminActions.map((a) => (
                  <li key={a.id}>
                    <code>{a.action}</code>{' '}
                    <span className="muted">{[a.actor ? `@${a.actor}` : null, formatWhen(a.createdAt, locale)].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('admin.user.noHistory')}</p>
            )}
          </Card>
        </div>
      </CardHeadings>

      <RemoveDialog item={removing} onClose={() => setRemoving(null)} onRemoved={(it) => setPost(it.id, 'removed')} />
      <Dialog
        open={confirm === 'suspend'}
        onClose={() => setConfirm(null)}
        title={t('admin.suspend.title', { username: u.username })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                void act(
                  () => api.admin.setUserStatus(u.id, 'suspended', note.trim() || undefined),
                  t('admin.people.suspendedToast'),
                  () => setData((d) => (d ? { ...d, user: { ...d.user, status: 'suspended' }, sessions: [] } : d)),
                );
              }}
            >
              {t('admin.people.suspend')}
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <p style={{ margin: 0 }}>{t('admin.suspend.body')}</p>
          <TextField label={t('admin.case.note')} multiline value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={2000} />
        </div>
      </Dialog>
      <Dialog
        open={confirm === 'signout'}
        onClose={() => setConfirm(null)}
        title={t('admin.user.signOutTitle', { username: u.username })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                void act(
                  () => api.admin.signOutEverywhere(u.id),
                  t('admin.user.signedOut'),
                  () => setData((d) => (d ? { ...d, sessions: [] } : d)),
                );
              }}
            >
              {t('admin.user.signOutEverywhere')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('admin.user.signOutBody')}</p>
      </Dialog>
    </>,
  );
}
