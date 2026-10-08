'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeadings,
  Dialog,
  EmptyState,
  SensitiveCover,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TextField,
} from '@yapilapi/design-system';
import type { AdminMiniApp, AdminPayout, RegionalRule, RiskAccount } from '@yapilapi/api-client';
import {
  decisionsFor,
  FEATURE_FLAGS,
  formatList,
  formatMoney,
  formatRelativeTime,
  fullCount,
  MODERATION_TARGET_KEYS,
  type MessageKey,
  type StorePurchasePolicy,
} from '@yapilapi/shared';
import { api, errorMessage, sharedRequest } from '@/lib/api';
import { Announcements } from '@/components/admin/Announcements';
import { Audit } from '@/components/admin/Audit';
import { Content } from '@/components/admin/Content';
import { Overview } from '@/components/admin/Overview';
import { Payments } from '@/components/admin/Payments';
import { Problems } from '@/components/admin/Problems';
import { Choice, LoadFailed, Loading, useLoad } from '@/components/admin/shared';
import { System } from '@/components/admin/System';
import { useSession, type Session } from '../../providers';

/** Moderation decisions (the server's codes) in plain words. Unknown codes are shown as they are. */
const DECISIONS: Record<string, MessageKey> = {
  no_action: 'admin.decision.noAction',
  warn: 'admin.decision.warn',
  restrict: 'admin.decision.restrict',
  remove: 'admin.decision.remove',
  suspend_user: 'admin.decision.suspendUser',
  approve_ad: 'admin.decision.approveAd',
  reject_ad: 'admin.decision.rejectAd',
};
function decisionLabel(decision: unknown, t: Session['t']): string {
  const key = DECISIONS[String(decision)];
  return key ? t(key) : String(decision ?? '').replace(/_/g, ' ');
}

const CASE_STATUS: Record<string, MessageKey> = {
  open: 'admin.caseStatus.open',
  appealed: 'admin.caseStatus.appealed',
  decided: 'admin.caseStatus.decided',
  final: 'admin.caseStatus.final',
};

/** Where a case came from. */
const SOURCES: Record<string, MessageKey> = {
  report: 'admin.source.report',
  automated: 'admin.source.automated',
  appeal: 'admin.source.appeal',
  ad_review: 'admin.source.adReview',
  admin: 'admin.source.admin',
};

/** What was reported, as a label: the same words people see in Settings ("Post", "Account"). */
function targetLabel(type: string, t: Session['t']): string {
  if (type === 'media') return t('admin.target.media');
  const key = MODERATION_TARGET_KEYS[type as keyof typeof MODERATION_TARGET_KEYS];
  return key ? t(key) : type.replace(/_/g, ' ');
}

/** The report reasons, in the words the report sheet uses. */
const REASONS: Record<string, MessageKey> = {
  spam: 'postList.reason.spam',
  harassment: 'postList.reason.harassment',
  hate: 'postList.reason.hate',
  violence: 'postList.reason.violence',
  nudity: 'postList.reason.nudity',
  self_harm: 'postList.reason.selfHarm',
  impersonation: 'postList.reason.impersonation',
  fraud: 'postList.reason.fraud',
  minor_safety: 'postList.reason.minorSafety',
  copyright: 'postList.reason.copyright',
  other: 'postList.reason.other',
};

const PERMISSIONS: Record<string, MessageKey> = {
  profile: 'miniApps.perm.profile',
  members: 'miniApps.perm.members',
  post_message: 'miniApps.perm.postMessage',
};
const SURFACES: Record<string, MessageKey> = {
  conversation: 'miniApps.surface.conversation',
  community: 'miniApps.surface.community',
  event: 'miniApps.surface.event',
  profile: 'miniApps.surface.profile',
  business: 'miniApps.surface.business',
};

/** Where to open what a case is about, when it has a page of its own. */
function caseHref(c: Record<string, any>): string | null {
  const id = String(c.target_id);
  switch (c.target_type) {
    case 'post':
      return `/p/${id}`;
    case 'story':
      return `/s/${id}`;
    case 'listing':
      return `/market/${id}`;
    case 'event':
      return `/events/${id}`;
    case 'mix':
      return `/mixes/${id}`;
    case 'drop':
      return `/drops/${id}`;
    case 'room':
      return `/rooms/${id}`;
    case 'user':
      return c.subject_username ? `/u/${c.subject_username}` : null;
    default:
      return null;
  }
}

/**
 * Admin and moderation console. The UI is only a convenience: every endpoint
 * it calls enforces the moderator/admin role on the server.
 */
const MOD_TABS = ['moderation', 'accounts', 'problems'] as const;
const ADMIN_TABS = ['people', 'content', 'overview', 'system', 'flags', 'miniapps', 'regions', 'payments', 'payouts', 'announcements', 'audit'] as const;
type Tab = (typeof MOD_TABS)[number] | (typeof ADMIN_TABS)[number];
const TAB_LABELS: Record<Tab, MessageKey> = {
  moderation: 'admin.tab.moderation',
  accounts: 'admin.tab.accounts',
  problems: 'admin.tab.problems',
  people: 'admin.tab.people',
  content: 'admin.tab.content',
  overview: 'admin.tab.overview',
  system: 'admin.tab.system',
  flags: 'admin.tab.flags',
  miniapps: 'admin.tab.miniApps',
  regions: 'admin.tab.regions',
  payments: 'admin.tab.payments',
  payouts: 'admin.tab.payouts',
  announcements: 'admin.tab.announcements',
  audit: 'admin.tab.audit',
};

export default function Admin() {
  const { me, t } = useSession();
  const tabs: Tab[] = me?.role === 'admin' ? [...MOD_TABS, ...ADMIN_TABS] : [...MOD_TABS];
  const [tab, setTab] = useState<Tab>('moderation');
  // The tab is in the address (/admin#people), so a link (back from an account's page) opens it.
  useEffect(() => {
    const fromHash = () => {
      const h = location.hash.slice(1) as Tab;
      if (tabs.includes(h)) setTab(h);
    };
    fromHash();
    addEventListener('hashchange', fromHash);
    return () => removeEventListener('hashchange', fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.role]);
  if (me?.role === 'user') return <EmptyState level={1} title={t('admin.only')} body={t('admin.onlyBody')} />;
  const choose = (id: string) => {
    setTab(id as Tab);
    history.replaceState(null, '', `#${id}`);
  };
  return (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <div className="yp-topbar">
        <h1>{t('m.role.admin')}</h1>
      </div>
      <Tabs id="admin-tabs" panelId="admin-panel" value={tab} onChange={choose} tabs={tabs.map((id) => ({ id, label: t(TAB_LABELS[id]) }))} />
      {/* Cards in every tab sit straight under the page's h1. */}
      <CardHeadings level={2}>
        <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tabs-${tab}`}>
          {tab === 'moderation' ? (
            <Moderation />
          ) : tab === 'accounts' ? (
            <AccountSignals />
          ) : tab === 'problems' ? (
            <Problems />
          ) : tab === 'people' ? (
            <People />
          ) : tab === 'content' ? (
            <Content />
          ) : tab === 'overview' ? (
            <Overview />
          ) : tab === 'system' ? (
            <System />
          ) : tab === 'flags' ? (
            <div className="stack">
              <Flags />
              <PassTheMicStats />
              <SquadStats />
              <YapStats />
              <PhonePurchases />
            </div>
          ) : tab === 'miniapps' ? (
            <MiniAppReview />
          ) : tab === 'regions' ? (
            <RegionalRules />
          ) : tab === 'payments' ? (
            <Payments />
          ) : tab === 'payouts' ? (
            <Payouts />
          ) : tab === 'announcements' ? (
            <Announcements />
          ) : (
            <Audit />
          )}
        </div>
      </CardHeadings>
    </div>
  );
}

function Moderation() {
  const { toast, t } = useSession();
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad(() => api.admin.cases(status), [status]);
  const decide = async (id: string, decision: string, note?: string) => {
    try {
      await api.admin.decide(id, decision, note);
      toast(t('admin.case.recorded'));
      reload();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="stack">
      <div className="row" role="group" aria-label={t('admin.case.show')}>
        {['open', 'appealed', 'decided', 'final'].map((s) => (
          <Button key={s} size="sm" variant={s === status ? 'primary' : 'secondary'} aria-pressed={s === status} onClick={() => setStatus(s)}>
            {CASE_STATUS[s] ? t(CASE_STATUS[s]) : s}
          </Button>
        ))}
      </div>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.items.length ? (
        data.items.map((c) => <CaseCard key={c.id} c={c} onDecide={(decision, note) => decide(c.id, decision, note)} />)
      ) : (
        <EmptyState title={t('admin.case.queueClear')} />
      )}
    </div>
  );
}

function CaseCard({ c, onDecide }: { c: Record<string, any>; onDecide: (decision: string, note?: string) => Promise<void> }) {
  const { locale, me, t, tp } = useSession();
  const [note, setNote] = useState('');
  const [suspending, setSuspending] = useState(false);
  const open = ['open', 'appealed'].includes(c.status);
  const href = caseHref(c);
  const reports = Number(c.signals?.reports ?? 0);
  const reasons = Array.isArray(c.signals?.reasons) ? (c.signals.reasons as string[]) : [];
  const others = Object.fromEntries(Object.entries(c.signals ?? {}).filter(([k]) => k !== 'reports' && k !== 'reasons' && k !== 'name'));
  const decisions = decisionsFor(c.target_type).filter((d) => d !== 'suspend_user' || me?.role === 'admin');
  return (
    <Card
      title={
        c.target_type === 'ad_campaign'
          ? c.signals?.name
            ? t('admin.case.adReview', { name: String(c.signals.name) })
            : t('admin.case.adReviewNoName')
          : targetLabel(c.target_type, t)
      }
      subtitle={[
        SOURCES[c.source] ? t(SOURCES[c.source]) : c.source,
        c.subject_username ? `@${c.subject_username}` : t('admin.case.unknownAccount'),
        formatRelativeTime(c.created_at, locale),
      ].join(' · ')}
      footer={
        c.needs_other_reviewer ? (
          // The server refuses it too: whoever made the decision can't decide its appeal.
          <span className="muted">{t('admin.case.needsOtherReviewer')}</span>
        ) : open && c.target_type === 'ad_campaign' ? (
          <AdDecision onDecide={(approve, n) => onDecide(approve ? 'approve_ad' : 'reject_ad', n)} />
        ) : open ? (
          <>
            <div style={{ flex: '1 1 100%', minWidth: 0 }}>
              <TextField label={t('admin.case.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={2000} />
            </div>
            {decisions.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={d === 'no_action' ? 'ghost' : d === 'warn' || d === 'restrict' ? 'secondary' : 'danger'}
                onClick={() => (d === 'suspend_user' ? setSuspending(true) : onDecide(d, note.trim() || undefined))}
              >
                {decisionLabel(d, t)}
              </Button>
            ))}
          </>
        ) : (
          <span className="muted">{t('admin.case.decision', { decision: decisionLabel(c.decision, t) })}</span>
        )
      }
    >
      {c.risk === 'escalate' ? <Alert tone="danger">{t('admin.case.escalated')}</Alert> : null}
      {c.needs_other_reviewer ? (
        <Alert tone="info" title={t('admin.case.needsOtherReviewer')}>
          {t('admin.case.needsOtherReviewerBody', { decision: decisionLabel(c.decision, t) })}
        </Alert>
      ) : null}
      {c.appeal_statement ? (
        <p style={{ whiteSpace: 'pre-wrap' }}>
          <strong>{c.status === 'appealed' ? t('admin.case.appealAgainst', { decision: decisionLabel(c.decision, t) }) : t('admin.case.appeal')}</strong>{' '}
          {c.appeal_statement}
        </p>
      ) : null}
      {c.media ? <CaseMedia media={c.media} /> : null}
      {c.excerpt || !c.media ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.excerpt ?? t('admin.case.noPreview')}</p> : null}
      {reports ? (
        <p className="muted" style={{ margin: 0 }}>
          {tp('admin.case.reported', reports)}
          {reasons.length
            ? ` · ${formatList(
                reasons.map((r) => (REASONS[r] ? t(REASONS[r]) : r)),
                locale,
              )}`
            : ''}
        </p>
      ) : null}
      {Object.keys(others).length ? (
        <details>
          <summary className="muted">{t('admin.case.signals')}</summary>
          <code style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{JSON.stringify(others)}</code>
        </details>
      ) : null}
      {href ? (
        <p style={{ margin: 0 }}>
          <Link href={href} target="_blank" rel="noopener">
            {t('admin.case.openIt')}
          </Link>
        </p>
      ) : null}
      <Dialog
        open={suspending}
        onClose={() => setSuspending(false)}
        title={t('admin.suspend.title', { username: c.subject_username ?? '' })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSuspending(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setSuspending(false);
                await onDecide('suspend_user', note.trim() || undefined);
              }}
            >
              {t('admin.decision.suspendUser')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('admin.suspend.body')}</p>
      </Dialog>
    </Card>
  );
}

/** Media an automated check flagged, blurred until the moderator chooses to look. */
function CaseMedia({ media }: { media: { kind: string; url: string; moderation: string } }) {
  const [shown, setShown] = useState(false);
  const { locale, t } = useSession();
  return (
    <div className="stack-sm">
      <p className="muted" style={{ margin: 0 }}>
        {t(media.kind === 'video' ? 'admin.media.checkVideo' : 'admin.media.checkPhoto', { result: media.moderation })}
      </p>
      <div className="case-media">
        {media.kind === 'video' && !/\.(jpe?g|png|webp)$/i.test(media.url) ? (
          <video src={media.url} controls={shown} muted className={shown ? undefined : 'yp-blurred'} />
        ) : (
          <img src={media.url} alt="" loading="lazy" decoding="async" className={shown ? undefined : 'yp-blurred'} />
        )}
        {shown ? null : <SensitiveCover onReveal={() => setShown(true)} locale={locale} />}
      </div>
    </div>
  );
}

const SIGNAL_TEXT: Record<string, MessageKey> = {
  disposable_email: 'admin.signal.disposableEmail',
  signup_ip_velocity: 'admin.signal.signupIpVelocity',
  signup_subnet_velocity: 'admin.signal.signupSubnetVelocity',
  post_velocity: 'admin.signal.postVelocity',
  message_velocity: 'admin.signal.messageVelocity',
  duplicate_text: 'admin.signal.duplicateText',
  link_spam: 'admin.signal.linkSpam',
  auto_restricted: 'admin.signal.autoRestricted',
  held_while_limited: 'admin.signal.heldWhileLimited',
};

/**
 * Spam and bot signals by account. Clearing lifts any limit and releases held
 * posts and messages; confirming keeps the limit and removes the flagged items.
 */
function AccountSignals() {
  const { toast, locale, t } = useSession();
  const [status, setStatus] = useState<'open' | 'reviewed'>('open');
  const { data, error, reload } = useLoad(() => api.admin.riskAccounts(status), [status]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const items: RiskAccount[] | null = data?.items ?? null;
  const review = async (id: string, action: 'clear' | 'confirm') => {
    try {
      await api.admin.reviewRisk(id, action, notes[id]?.trim() || undefined);
      toast(action === 'clear' ? t('admin.risk.cleared') : t('admin.risk.confirmed'));
      reload();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="stack">
      <div className="row" role="group" aria-label={t('admin.case.show')}>
        {(['open', 'reviewed'] as const).map((s) => (
          <Button key={s} size="sm" variant={s === status ? 'primary' : 'secondary'} aria-pressed={s === status} onClick={() => setStatus(s)}>
            {s === 'open' ? t('admin.risk.waiting') : t('admin.risk.reviewed')}
          </Button>
        ))}
      </div>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : items === null ? (
        <Loading />
      ) : items.length ? (
        items.map((a) => (
          <Card
            key={a.user.id}
            title={
              <>
                {a.user.displayName} <span className="muted">@{a.user.username}</span>{' '}
                {a.restrictedAt ? <Badge tone="warning">{t('admin.risk.limited')}</Badge> : null}
              </>
            }
            subtitle={[
              t('admin.risk.joined', { when: formatRelativeTime(a.user.createdAt, locale) }),
              t(a.user.emailVerified ? 'admin.risk.emailConfirmed' : 'admin.risk.emailNotConfirmed'),
              t(a.user.phoneVerified ? 'admin.risk.phoneConfirmed' : 'admin.risk.phoneNotConfirmed'),
              t('admin.risk.score', { score: a.score }),
            ].join(' · ')}
            footer={
              status === 'open' ? (
                <>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <TextField
                      label={t('admin.risk.note')}
                      value={notes[a.user.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [a.user.id]: e.currentTarget.value })}
                      maxLength={2000}
                    />
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => review(a.user.id, 'clear')}>
                    {a.restrictedAt ? t('admin.risk.clearAndLift') : t('admin.risk.clear')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => review(a.user.id, 'confirm')}>
                    {t('admin.risk.confirm')}
                  </Button>
                </>
              ) : null
            }
          >
            <ul className="risk-signals">
              {a.signals.map((s) => (
                <li key={s.id} data-status={s.status}>
                  <span>
                    <strong>{SIGNAL_TEXT[s.kind] ? t(SIGNAL_TEXT[s.kind]!) : s.kind.replace(/_/g, ' ')}</strong>{' '}
                    <span className="muted">
                      · {s.status} · {formatRelativeTime(s.createdAt, locale)}
                      {s.weight ? ` · ${t('admin.risk.weight', { weight: s.weight })}` : ''}
                    </span>
                  </span>
                  {s.excerpt ? <span style={{ whiteSpace: 'pre-wrap' }}>“{s.excerpt}”</span> : null}
                  {Object.keys(s.detail ?? {}).length ? <code style={{ fontSize: 12 }}>{JSON.stringify(s.detail)}</code> : null}
                </li>
              ))}
            </ul>
          </Card>
        ))
      ) : (
        <EmptyState title={status === 'open' ? t('admin.risk.nothingWaiting') : t('admin.risk.noRecent')} />
      )}
    </div>
  );
}

type AdminUser = {
  id: string;
  email: string;
  role: 'user' | 'moderator' | 'admin';
  status: string;
  created_at: string;
  username: string;
  display_name: string;
};

/** Find an account, change its role, suspend or reinstate it. Suspending asks first and can carry a note for the record. */
function People() {
  const { me, toast, locale, t } = useSession();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, setData, error, reload } = useLoad(() => api.admin.users(query), [query]);
  const [suspending, setSuspending] = useState<AdminUser | null>(null);
  const [note, setNote] = useState('');
  const items = (data?.items ?? null) as AdminUser[] | null;
  const patch = (id: string, change: Partial<AdminUser>) => setData((d) => (d ? { items: d.items.map((u) => (u.id === id ? { ...u, ...change } : u)) } : d));
  const setStatus = async (u: AdminUser, status: 'active' | 'suspended', why?: string) => {
    try {
      await api.admin.setUserStatus(u.id, status, why);
      patch(u.id, { status });
      toast(status === 'suspended' ? t('admin.people.suspendedToast') : t('admin.people.reinstated'));
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="stack">
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <TextField label={t('admin.people.search')} type="search" value={q} onChange={(e) => setQ(e.currentTarget.value)} maxLength={100} />
        </div>
        <Button type="submit" style={{ alignSelf: 'flex-end' }}>
          {t('admin.people.find')}
        </Button>
      </form>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : items === null ? (
        <Loading />
      ) : items.length ? (
        items.map((u) => {
          const self = u.id === me?.id;
          return (
            <Card
              key={u.id}
              title={
                <>
                  {u.display_name} <span className="muted">@{u.username}</span>{' '}
                  {u.status === 'suspended' ? <Badge tone="danger">{t('admin.people.suspended')}</Badge> : null}
                  {self ? <Badge tone="neutral">{t('admin.people.you')}</Badge> : null}
                </>
              }
              subtitle={[u.email, t('admin.risk.joined', { when: formatRelativeTime(u.created_at, locale) })].join(' · ')}
              footer={
                self ? null : (
                  <>
                    <div style={{ minWidth: 180 }}>
                      <Select
                        label={t('admin.people.role')}
                        value={u.role}
                        onChange={async (e) => {
                          const role = e.currentTarget.value as AdminUser['role'];
                          try {
                            await api.admin.setUserRole(u.id, role);
                            patch(u.id, { role });
                            toast(t('admin.people.roleChanged'));
                          } catch (err) {
                            toast(errorMessage(err));
                          }
                        }}
                      >
                        <option value="user">{t('admin.people.roleUser')}</option>
                        <option value="moderator">{t('m.role.moderator')}</option>
                        <option value="admin">{t('m.role.admin')}</option>
                      </Select>
                    </div>
                    {u.status === 'suspended' ? (
                      <Button size="sm" variant="secondary" onClick={() => setStatus(u, 'active')} style={{ alignSelf: 'flex-end' }}>
                        {t('admin.people.reinstate')}
                      </Button>
                    ) : u.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="danger"
                        style={{ alignSelf: 'flex-end' }}
                        onClick={() => {
                          setNote('');
                          setSuspending(u);
                        }}
                      >
                        {t('admin.people.suspend')}
                      </Button>
                    ) : null}
                  </>
                )
              }
            >
              <div className="row">
                <Link href={`/admin/users/${u.id}`}>{t('admin.people.details')}</Link>
                <Link href={`/u/${u.username}`}>{t('admin.people.profile')}</Link>
              </div>
            </Card>
          );
        })
      ) : (
        <EmptyState title={t('admin.people.none')} />
      )}
      <Dialog
        open={!!suspending}
        onClose={() => setSuspending(null)}
        title={t('admin.suspend.title', { username: suspending?.username ?? '' })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSuspending(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const u = suspending!;
                setSuspending(null);
                await setStatus(u, 'suspended', note.trim() || undefined);
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
    </div>
  );
}

function Flags() {
  const { toast, t, refreshFlags } = useSession();
  // Not the shared copy: switches must show what the server has now, never a cached guess.
  const { data, setData, error, reload } = useLoad(() => api.flags(), []);
  return (
    <Card title={t('admin.tab.flags')} subtitle={t('admin.flags.subtitle')}>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton height={200} />
      ) : (
        <div className="stack-sm">
          {Object.entries(FEATURE_FLAGS).map(([k, f]) => (
            <Switch
              key={k}
              label={`${k}: ${f.description}`}
              checked={!!data.flags[k as keyof typeof data.flags]}
              onChange={async (v) => {
                try {
                  const r = await api.admin.setFlag(k, v);
                  setData({ ...data, flags: r.flags as typeof data.flags });
                  // This page's own app follows at once (everyone else's on their next load).
                  await refreshFlags();
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/** Pass the Mic and Fair start, at a glance: chains this week and the fair-start pool. */
function PassTheMicStats() {
  const { t, locale } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.passTheMic(), []);
  const n = (v: number) => fullCount(v, locale);
  return (
    <Card title={t('mic.title')}>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton height={60} />
      ) : (
        <div className="stack-sm">
          <p style={{ margin: 0 }}>{t('admin.mic.chains', { active: n(data.chains.active), links: n(data.chains.links) })}</p>
          <p style={{ margin: 0 }}>
            {t('admin.mic.fairStart', { active: n(data.fairStart.active), slowed: n(data.fairStart.slowed), done: n(data.fairStart.done) })}
          </p>
        </div>
      )}
    </Card>
  );
}

/** Squads at a glance. What is shared in them is moderated through reports, like any post. */
function SquadStats() {
  const { t, locale } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.squads(), []);
  const n = (v: number) => fullCount(v, locale);
  return (
    <Card title={t('squads.title')}>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton height={40} />
      ) : (
        <p style={{ margin: 0 }}>
          {t('admin.squads', { squads: n(data.squads), members: n(data.members), invites: n(data.invites), posts: n(data.postsThisWeek) })}
        </p>
      )}
    </Card>
  );
}

/**
 * Yaps at a glance: voice posts, voice replies, voice intros, and how their transcripts are
 * doing (many failed or unavailable means speech-to-text needs a look). The wording is in
 * English for now: only operators see it.
 */
function YapStats() {
  const { t, locale } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.yaps(), []);
  const n = (v: number) => fullCount(v, locale);
  return (
    <Card title={t('feed.yaps')}>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton height={60} />
      ) : (
        <div className="stack-sm">
          <p style={{ margin: 0 }}>
            Yaps: {n(data.yaps)}, {n(data.thisWeek)} this week. Voice replies: {n(data.voiceReplies)}. Voice intros: {n(data.intros)}.
          </p>
          <p style={{ margin: 0 }}>
            Transcripts: {n(data.transcripts.ready ?? 0)} ready, {n(data.transcripts.pending ?? 0)} being made, {n(data.transcripts.failed ?? 0)} failed,{' '}
            {n(data.transcripts.unavailable ?? 0)} not available.
          </p>
        </div>
      )}
    </Card>
  );
}

/**
 * How the phone apps offer digital goods (Plus, creator subscriptions, tips, boosts, downloads,
 * tickets to lives). Read only: it is set in the API's configuration, and the choices are
 * explained in docs/operations/in-app-purchases.md.
 */
function PhonePurchases() {
  const { t } = useSession();
  const [policy, setPolicy] = useState<StorePurchasePolicy | null>(null);
  useEffect(() => {
    sharedRequest('flags', () => api.flags()).then(
      (r) => setPolicy(r.purchases ?? null),
      () => setPolicy(null),
    );
  }, []);
  const ios = {
    hidden: 'admin.purchases.hidden',
    external_link: 'admin.purchases.iosLink',
    iap: 'admin.purchases.iosIap',
  } as const satisfies Record<string, MessageKey>;
  const android = {
    play_billing_required: 'admin.purchases.hidden',
    user_choice: 'admin.purchases.androidLink',
  } as const satisfies Record<string, MessageKey>;
  const countries = (list: string[]) => (list.length ? t('admin.purchases.countries', { list: list.join(', ') }) : t('admin.purchases.noCountries'));
  return (
    <Card title={t('admin.purchases.title')} subtitle={t('admin.purchases.subtitle')}>
      {policy ? (
        <dl className="stack-sm">
          <div>
            <dt>
              <strong>{t('admin.purchases.ios', { setting: 'IOS_DIGITAL_PURCHASES', mode: policy.ios.mode })}</strong>
            </dt>
            <dd>
              {t(ios[policy.ios.mode])}
              {policy.ios.mode === 'external_link' ? ` ${countries(policy.ios.linkCountries)}` : ''}
            </dd>
          </div>
          <div>
            <dt>
              <strong>{t('admin.purchases.android', { setting: 'ANDROID_DIGITAL_PURCHASES', mode: policy.android.mode })}</strong>
            </dt>
            <dd>
              {t(android[policy.android.mode])}
              {policy.android.mode === 'user_choice' ? ` ${countries(policy.android.linkCountries)}` : ''}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted">{t('m.common.loadingMore')}</p>
      )}
      <p className="muted">{t('admin.purchases.howToChange', { path: 'docs/operations/in-app-purchases.md' })}</p>
    </Card>
  );
}

/** Mini Apps waiting for review: what they ask for and where they can go. Approving makes them installable. */
function MiniAppReview() {
  const { toast, locale, t } = useSession();
  const { data, setData, error, reload } = useLoad(() => api.admin.miniApps(), []);
  const decide = async (m: AdminMiniApp, approve: boolean, reason?: string) => {
    try {
      await api.admin.decideMiniApp(m.id, approve, reason);
      setData((d) => (d ? { items: d.items.filter((x) => x.id !== m.id) } : d));
      toast(approve ? t('admin.mini.approved', { name: m.name }) : t('admin.mini.rejected', { name: m.name }));
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  if (error) return <LoadFailed error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.items.length) return <EmptyState title={t('admin.mini.empty')} />;
  return (
    <div className="stack">
      {data.items.map((m) => (
        <Card
          key={m.id}
          title={m.name}
          subtitle={[t('admin.mini.from', { app: m.developer_app }), formatRelativeTime(m.created_at, locale)].join(' · ')}
          footer={<MiniAppDecision onDecide={(approve, reason) => decide(m, approve, reason)} />}
        >
          {m.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{m.description}</p> : null}
          <p style={{ margin: 0, overflowWrap: 'anywhere' }}>
            <a href={m.entry_url} target="_blank" rel="noopener noreferrer">
              {m.entry_url}
            </a>
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {m.permissions.length
              ? t('admin.mini.asks', {
                  list: formatList(
                    m.permissions.map((p) => (PERMISSIONS[p] ? t(PERMISSIONS[p]) : p)),
                    locale,
                  ),
                })
              : t('admin.mini.asksNothing')}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {t('admin.mini.where', {
              list: formatList(
                m.surfaces.map((s) => (SURFACES[s] ? t(SURFACES[s]) : s)),
                locale,
              ),
            })}
          </p>
        </Card>
      ))}
    </div>
  );
}

/** Approve a Mini App, or turn it down, with a reason its developer will see if you give one. */
function MiniAppDecision({ onDecide }: { onDecide: (approve: boolean, reason?: string) => void }) {
  const { t } = useSession();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  if (rejecting)
    return (
      <form
        className="row"
        style={{ flex: 1 }}
        onSubmit={(e) => {
          e.preventDefault();
          onDecide(false, reason.trim() || undefined);
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <TextField label={t('admin.mini.why')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={2000} autoFocus />
        </div>
        <Button type="submit" size="sm" variant="danger">
          {t('admin.mini.reject')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
          {t('common.cancel')}
        </Button>
      </form>
    );
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
        {t('admin.mini.reject')}
      </Button>
      <Button size="sm" onClick={() => onDecide(true)}>
        {t('admin.mini.approve')}
      </Button>
    </>
  );
}

/** Approve an ad, or reject it with a reason the advertiser will see. */
function AdDecision({ onDecide }: { onDecide: (approve: boolean, note?: string) => void }) {
  const { t } = useSession();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  if (rejecting)
    return (
      <form
        className="row"
        style={{ flex: 1 }}
        onSubmit={(e) => {
          e.preventDefault();
          onDecide(false, note.trim());
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <TextField label={t('admin.ad.why')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={2000} />
        </div>
        <Button type="submit" size="sm" variant="danger" disabled={!note.trim()}>
          {t('admin.decision.rejectAd')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
          {t('common.cancel')}
        </Button>
      </form>
    );
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
        {t('admin.ad.reject')}
      </Button>
      <Button size="sm" onClick={() => onDecide(true)}>
        {t('admin.decision.approveAd')}
      </Button>
    </>
  );
}

/** Per-country rules: matching posts are withheld for viewers in that country, never deleted. */
function RegionalRules() {
  const { toast, t, tp } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.regionalRules(), []);
  const items: RegionalRule[] | null = data?.items ?? null;
  const [kind, setKind] = useState<'blocked_term' | 'restrict_topic'>('blocked_term');
  const [country, setCountry] = useState('');
  const [value, setValue] = useState('');
  const [basis, setBasis] = useState('');
  return (
    <div className="stack">
      <Alert tone="info">{t('admin.regions.intro')}</Alert>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : items === null ? (
        <Loading />
      ) : items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('settings.country')}</th>
                <th>{t('admin.regions.rule')}</th>
                <th>{t('admin.regions.legalBasis')}</th>
                <th>{t('admin.regions.withheld')}</th>
                <th>
                  <span className="yp-visually-hidden">{t('m.common.remove')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.country}</td>
                  <td>
                    {r.kind === 'blocked_term' ? t('admin.regions.termRow', { term: r.term ?? '' }) : t('admin.regions.topicRow', { topic: r.topic ?? '' })}
                  </td>
                  <td>{r.legalBasis}</td>
                  <td>{r.withheldPosts}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api.admin.deleteRegionalRule(r.id);
                          toast(t('admin.regions.removed'));
                          reload();
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      {t('m.common.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{t('admin.regions.none')}</p>
      )}
      <Card title={t('admin.regions.addTitle')}>
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.admin.addRegionalRule(
                kind === 'blocked_term'
                  ? { kind, country, term: value, legalBasis: basis }
                  : { kind, country, topic: value.replace(/^#/, ''), legalBasis: basis },
              );
              toast(tp('admin.regions.added', r.rule.withheldPosts, { country: r.rule.country }));
              setValue('');
              setBasis('');
              reload();
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <Select label={t('admin.regions.rule')} value={kind} onChange={(e) => setKind(e.currentTarget.value as typeof kind)}>
            <option value="blocked_term">{t('admin.regions.kindTerm')}</option>
            <option value="restrict_topic">{t('admin.regions.kindTopic')}</option>
          </Select>
          <TextField
            label={t('admin.regions.countryCode')}
            hint={t('admin.regions.countryCodeHint')}
            value={country}
            onChange={(e) => setCountry(e.currentTarget.value)}
            maxLength={2}
            required
          />
          <TextField
            label={kind === 'blocked_term' ? t('admin.regions.term') : t('admin.regions.topic')}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            maxLength={100}
            required
          />
          <TextField
            label={t('admin.regions.legalBasis')}
            multiline
            value={basis}
            onChange={(e) => setBasis(e.currentTarget.value)}
            maxLength={1000}
            required
          />
          <Button type="submit" size="sm" disabled={country.length !== 2 || !value.trim() || basis.trim().length < 3}>
            {t('admin.regions.add')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** Payouts waiting for a decision: who asked, what they still have in that currency, and where it would go. Approving sends it. */
const PAYOUT_STATUS: Record<AdminPayout['status'], MessageKey> = {
  pending: 'admin.payouts.status.pending',
  verified: 'admin.payouts.status.verified',
  processing: 'admin.payouts.status.processing',
  paid: 'admin.payouts.status.paid',
  failed: 'admin.payouts.status.failed',
};

/** Payouts by status, waiting ones first. Waiting ones can be approved (which sends them) or turned down. */
function Payouts() {
  const { toast, locale, t } = useSession();
  const [status, setStatus] = useState<AdminPayout['status']>('pending');
  const { data, error, reload } = useLoad(() => api.admin.payouts(status), [status]);
  const items: AdminPayout[] | null = data?.items ?? null;
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
      reload();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <Card title={t('admin.tab.payouts')} subtitle={t('admin.payouts.subtitle')}>
      <Choice
        label={t('admin.case.show')}
        value={status}
        onChange={setStatus}
        options={(Object.keys(PAYOUT_STATUS) as AdminPayout['status'][]).map((id) => ({ id, label: t(PAYOUT_STATUS[id]) }))}
      />
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : items === null ? (
        <Loading />
      ) : !items.length ? (
        <EmptyState title={status === 'pending' ? t('admin.payouts.empty') : t('admin.payouts.emptyOther')} />
      ) : null}
      <div className="stack">
        {items?.map((p) => (
          <div key={p.id} className="stack-sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <strong>{formatMoney(p.amount_cents, p.currency, locale)}</strong>
              <Link href={`/admin/users/${p.user_id}`}>@{p.username ?? p.user_id}</Link>
              <span className="muted">{formatRelativeTime(p.created_at, locale)}</span>
            </div>
            <div className="row">
              <Badge tone={p.available_cents < 0 ? 'danger' : 'neutral'}>
                {t('admin.payouts.available', { amount: formatMoney(p.available_cents, p.currency, locale) })}
              </Badge>
              <Badge tone={p.account_ready ? 'neutral' : 'danger'}>{p.account_ready ? (p.account_label ?? p.currency) : t('admin.payouts.noAccount')}</Badge>
              {p.status !== 'pending' ? (
                <Badge tone={p.status === 'failed' ? 'danger' : p.status === 'paid' ? 'success' : 'neutral'}>{t(PAYOUT_STATUS[p.status])}</Badge>
              ) : null}
            </div>
            {p.status !== 'pending' ? (
              p.failure_reason || p.paid_at ? (
                <p className="muted" style={{ margin: 0 }}>
                  {p.failure_reason ?? t('admin.payouts.paidOn', { when: formatRelativeTime(p.paid_at!, locale) })}
                </p>
              ) : null
            ) : (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <Button disabled={!p.account_ready || p.available_cents < 0} onClick={() => act(() => api.admin.approvePayout(p.id))}>
                  {t('admin.payouts.approve')}
                </Button>
                <TextField
                  label={t('admin.payouts.reason')}
                  value={reasons[p.id] ?? ''}
                  onChange={(e) => setReasons({ ...reasons, [p.id]: e.currentTarget.value })}
                  maxLength={300}
                />
                <Button
                  variant="secondary"
                  disabled={(reasons[p.id] ?? '').trim().length < 3}
                  onClick={() => act(() => api.admin.rejectPayout(p.id, reasons[p.id]!.trim()))}
                >
                  {t('admin.payouts.reject')}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
