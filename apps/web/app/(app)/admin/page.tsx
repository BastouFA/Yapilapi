'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, SensitiveCover, Select, Stat, Switch, Tabs, TextField } from '@yapilapi/design-system';
import type { AdminPayout, RegionalRule, RiskAccount } from '@yapilapi/api-client';
import { FEATURE_FLAGS, formatMoney, formatRelativeTime, type MessageKey, type StorePurchasePolicy } from '@yapilapi/shared';
import { api, errorMessage, sharedRequest } from '@/lib/api';
import { useSession, type Session } from '../../providers';

/** Moderation decisions (the server's codes) in plain words. Unknown codes are shown as they are. */
const DECISIONS: Record<string, MessageKey> = {
  no_action: 'admin.decision.noAction',
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

/**
 * Admin and moderation console. The UI is only a convenience: every endpoint
 * it calls enforces the moderator/admin role on the server.
 */
export default function Admin() {
  const { me, t } = useSession();
  const [tab, setTab] = useState('moderation');
  if (me?.role === 'user') return <EmptyState level={1} title={t('admin.only')} body={t('admin.onlyBody')} />;
  return (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <div className="yp-topbar">
        <h1>{t('m.role.admin')}</h1>
      </div>
      <Tabs
        id="admin-tabs"
        panelId="admin-panel"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'moderation', label: t('admin.tab.moderation') },
          { id: 'accounts', label: t('admin.tab.accounts') },
          ...(me?.role === 'admin'
            ? [
                { id: 'overview', label: t('admin.tab.overview') },
                { id: 'flags', label: t('admin.tab.flags') },
                { id: 'regions', label: t('admin.tab.regions') },
                { id: 'payouts', label: t('admin.tab.payouts') },
                { id: 'audit', label: t('admin.tab.audit') },
              ]
            : []),
        ]}
      />
      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tabs-${tab}`}>
        {tab === 'moderation' ? (
          <Moderation />
        ) : tab === 'accounts' ? (
          <AccountSignals />
        ) : tab === 'overview' ? (
          <Overview />
        ) : tab === 'flags' ? (
          <div className="stack">
            <Flags />
            <PhonePurchases />
          </div>
        ) : tab === 'regions' ? (
          <RegionalRules />
        ) : tab === 'payouts' ? (
          <Payouts />
        ) : (
          <Audit />
        )}
      </div>
    </div>
  );
}

function Moderation() {
  const { toast, locale, me, t } = useSession();
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState<Record<string, any>[] | null>(null);
  const load = () =>
    api.admin.cases(status).then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const decide = async (id: string, decision: string, note?: string) => {
    try {
      await api.admin.decide(id, decision, note);
      toast(t('admin.case.recorded'));
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="stack">
      <div className="row">
        {['open', 'appealed', 'decided', 'final'].map((s) => (
          <Button key={s} size="sm" variant={s === status ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>
            {CASE_STATUS[s] ? t(CASE_STATUS[s]) : s}
          </Button>
        ))}
      </div>
      {items?.length ? (
        items.map((c) => (
          <Card
            key={c.id}
            title={
              c.target_type === 'ad_campaign'
                ? c.signals?.name
                  ? t('admin.case.adReview', { name: String(c.signals.name) })
                  : t('admin.case.adReviewNoName')
                : `${c.target_type} · ${c.risk}`
            }
            subtitle={[c.source, c.subject_username ? `@${c.subject_username}` : t('admin.case.unknownAccount'), formatRelativeTime(c.created_at, locale)].join(
              ' · ',
            )}
            footer={
              c.needs_other_reviewer ? (
                // The server refuses it too: whoever made the decision can't decide its appeal.
                <span className="muted">{t('admin.case.needsOtherReviewer')}</span>
              ) : ['open', 'appealed'].includes(c.status) && c.target_type === 'ad_campaign' ? (
                <AdDecision onDecide={(approve, note) => decide(c.id, approve ? 'approve_ad' : 'reject_ad', note)} />
              ) : ['open', 'appealed'].includes(c.status) ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => decide(c.id, 'no_action')}>
                    {t('admin.decision.noAction')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => decide(c.id, 'restrict')}>
                    {t('admin.decision.restrict')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => decide(c.id, 'remove')}>
                    {t('admin.decision.remove')}
                  </Button>
                  {me?.role === 'admin' ? (
                    <Button size="sm" variant="danger" onClick={() => decide(c.id, 'suspend_user')}>
                      {t('admin.decision.suspendUser')}
                    </Button>
                  ) : null}
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
            {c.media ? <CaseMedia media={c.media} /> : <p style={{ whiteSpace: 'pre-wrap' }}>{c.excerpt ?? t('admin.case.noPreview')}</p>}
            <code style={{ fontSize: 12 }}>{JSON.stringify(c.signals)}</code>
          </Card>
        ))
      ) : (
        <EmptyState title={t('admin.case.queueClear')} />
      )}
    </div>
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
  const [items, setItems] = useState<RiskAccount[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = () =>
    api.admin.riskAccounts(status).then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const review = async (id: string, action: 'clear' | 'confirm') => {
    try {
      await api.admin.reviewRisk(id, action, notes[id]?.trim() || undefined);
      toast(action === 'clear' ? t('admin.risk.cleared') : t('admin.risk.confirmed'));
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="stack">
      <div className="row">
        {(['open', 'reviewed'] as const).map((s) => (
          <Button key={s} size="sm" variant={s === status ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>
            {s === 'open' ? t('admin.risk.waiting') : t('admin.risk.reviewed')}
          </Button>
        ))}
      </div>
      {items === null ? null : items.length ? (
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

function Overview() {
  const { toast, t } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.admin.summary>> | null>(null);
  useEffect(() => {
    api.admin.summary().then(setData, (e) => toast(errorMessage(e)));
  }, [toast]);
  if (!data) return null;
  return (
    <div className="stack">
      <p className="muted">{t('admin.overview.northStar')}</p>
      <div className="stats">
        <Stat label={t('admin.overview.actions24h')} value={data.summary.meaningful_actions_24h} />
        <Stat label={t('admin.overview.dau')} value={data.summary.dau} />
        <Stat label={t('admin.overview.users')} value={data.summary.users} />
        <Stat label={t('admin.overview.signups7d')} value={data.summary.signups_7d} />
        <Stat label={t('admin.overview.openCases')} value={data.summary.open_cases} />
        <Stat label={t('admin.overview.paidOrders7d')} value={data.summary.paid_orders_7d} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('admin.overview.action7d')}</th>
              <th>{t('admin.overview.count')}</th>
            </tr>
          </thead>
          <tbody>
            {data.meaningfulByAction.map((r) => (
              <tr key={r.name}>
                <td>{r.name.replace(/_/g, ' ')}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Flags() {
  const { toast, t } = useSession();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  useEffect(() => {
    sharedRequest('flags', () => api.flags()).then(
      (r) => setFlags(r.flags),
      (e) => toast(errorMessage(e)),
    );
  }, [toast]);
  return (
    <Card title={t('admin.tab.flags')} subtitle={t('admin.flags.subtitle')}>
      <div className="stack-sm">
        {Object.entries(FEATURE_FLAGS).map(([k, f]) => (
          <Switch
            key={k}
            label={`${k}: ${f.description}`}
            checked={!!flags[k]}
            onChange={async (v) => {
              try {
                setFlags((await api.admin.setFlag(k, v)).flags);
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          />
        ))}
      </div>
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
    // The flags card above reads the same response.
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

function Audit() {
  const { toast, t, locale } = useSession();
  const [items, setItems] = useState<Record<string, any>[]>([]);
  useEffect(() => {
    api.admin.auditLogs().then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  }, [toast]);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('admin.audit.when')}</th>
            <th>{t('admin.audit.action')}</th>
            <th>{t('admin.audit.entity')}</th>
            <th>{t('admin.audit.actor')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id}>
              <td>{new Date(l.created_at).toLocaleString(locale)}</td>
              <td>{l.action}</td>
              <td>
                {l.entity_type} {l.entity_id?.slice(0, 8)}
              </td>
              <td>{l.actor_id?.slice(0, 8) ?? t('admin.audit.system')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  const [items, setItems] = useState<RegionalRule[] | null>(null);
  const [kind, setKind] = useState<'blocked_term' | 'restrict_topic'>('blocked_term');
  const [country, setCountry] = useState('');
  const [value, setValue] = useState('');
  const [basis, setBasis] = useState('');
  const load = () =>
    api.admin.regionalRules().then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="stack">
      <Alert tone="info">{t('admin.regions.intro')}</Alert>
      {items?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('settings.country')}</th>
                <th>{t('admin.regions.rule')}</th>
                <th>{t('admin.regions.legalBasis')}</th>
                <th>{t('admin.regions.withheld')}</th>
                <th />
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
                          await load();
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
              await load();
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
function Payouts() {
  const { toast, locale, t } = useSession();
  const [items, setItems] = useState<AdminPayout[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = () =>
    api.admin.payouts().then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <Card title={t('admin.tab.payouts')} subtitle={t('admin.payouts.subtitle')}>
      {items && !items.length ? <EmptyState title={t('admin.payouts.empty')} /> : null}
      <div className="stack">
        {items?.map((p) => (
          <div key={p.id} className="stack-sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <strong>{formatMoney(p.amount_cents, p.currency, locale)}</strong>
              <span>@{p.username ?? p.user_id}</span>
              <span className="muted">{formatRelativeTime(p.created_at, locale)}</span>
            </div>
            <div className="row">
              <Badge tone={p.available_cents < 0 ? 'danger' : 'neutral'}>
                {t('admin.payouts.available', { amount: formatMoney(p.available_cents, p.currency, locale) })}
              </Badge>
              <Badge tone={p.account_ready ? 'neutral' : 'danger'}>{p.account_ready ? (p.account_label ?? p.currency) : t('admin.payouts.noAccount')}</Badge>
            </div>
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
          </div>
        ))}
      </div>
    </Card>
  );
}
