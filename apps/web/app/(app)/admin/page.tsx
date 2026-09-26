'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, EmptyState, Select, Stat, Switch, Tabs, TextField } from '@yapilapi/design-system';
import type { RegionalRule } from '@yapilapi/api-client';
import { FEATURE_FLAGS, formatRelativeTime } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

/**
 * Admin and moderation console. The UI is only a convenience: every endpoint
 * it calls enforces the moderator/admin role on the server.
 */
export default function Admin() {
  const { me } = useSession();
  const [tab, setTab] = useState('moderation');
  if (me?.role === 'user') return <EmptyState title="Admins only" body="You don't have access to this page." />;
  return (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <div className="yp-topbar">
        <h1>Admin</h1>
      </div>
      <Tabs
        id="admin-tabs"
        panelId="admin-panel"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'moderation', label: 'Moderation' },
          ...(me?.role === 'admin'
            ? [
                { id: 'overview', label: 'Overview' },
                { id: 'flags', label: 'Feature flags' },
                { id: 'regions', label: 'Regional rules' },
                { id: 'audit', label: 'Audit log' },
              ]
            : []),
        ]}
      />
      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tabs-${tab}`}>
        {tab === 'moderation' ? (
          <Moderation />
        ) : tab === 'overview' ? (
          <Overview />
        ) : tab === 'flags' ? (
          <Flags />
        ) : tab === 'regions' ? (
          <RegionalRules />
        ) : (
          <Audit />
        )}
      </div>
    </div>
  );
}

function Moderation() {
  const { toast, locale, me } = useSession();
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
      toast('Decision recorded');
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
            {s}
          </Button>
        ))}
      </div>
      {items?.length ? (
        items.map((c) => (
          <Card
            key={c.id}
            title={c.target_type === 'ad_campaign' ? `Ad review · ${c.signals?.name ?? 'campaign'}` : `${c.target_type} · ${c.risk}`}
            subtitle={`${c.source} · @${c.subject_username ?? 'unknown'} · ${formatRelativeTime(c.created_at, locale)}`}
            footer={
              ['open', 'appealed'].includes(c.status) && c.target_type === 'ad_campaign' ? (
                <AdDecision onDecide={(approve, note) => decide(c.id, approve ? 'approve_ad' : 'reject_ad', note)} />
              ) : ['open', 'appealed'].includes(c.status) ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => decide(c.id, 'no_action')}>
                    No action
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => decide(c.id, 'restrict')}>
                    Restrict
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => decide(c.id, 'remove')}>
                    Remove
                  </Button>
                  {me?.role === 'admin' ? (
                    <Button size="sm" variant="danger" onClick={() => decide(c.id, 'suspend_user')}>
                      Suspend user
                    </Button>
                  ) : null}
                </>
              ) : (
                <span className="muted">Decision: {c.decision}</span>
              )
            }
          >
            {c.risk === 'escalate' ? <Alert tone="danger">Escalated: review first.</Alert> : null}
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.excerpt ?? '(no text preview)'}</p>
            <code style={{ fontSize: 12 }}>{JSON.stringify(c.signals)}</code>
          </Card>
        ))
      ) : (
        <EmptyState title="Queue is clear" />
      )}
    </div>
  );
}

function Overview() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.admin.summary>> | null>(null);
  useEffect(() => {
    api.admin.summary().then(setData);
  }, []);
  if (!data) return null;
  return (
    <div className="stack">
      <p className="muted">North Star: meaningful social actions (posts, comments, messages, follows, joins, RSVPs).</p>
      <div className="stats">
        <Stat label="Meaningful actions, 24h" value={data.summary.meaningful_actions_24h} />
        <Stat label="Active users, 24h" value={data.summary.dau} />
        <Stat label="Users" value={data.summary.users} />
        <Stat label="Sign-ups, 7d" value={data.summary.signups_7d} />
        <Stat label="Open cases" value={data.summary.open_cases} />
        <Stat label="Paid orders, 7d" value={data.summary.paid_orders_7d} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Action (7 days)</th>
              <th>Count</th>
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
  const { toast } = useSession();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  useEffect(() => {
    api.flags().then((r) => setFlags(r.flags));
  }, []);
  return (
    <Card title="Feature flags" subtitle="Changes apply to everyone immediately and are recorded in the audit log.">
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

function Audit() {
  const [items, setItems] = useState<Record<string, any>[]>([]);
  useEffect(() => {
    api.admin.auditLogs().then((r) => setItems(r.items));
  }, []);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id}>
              <td>{new Date(l.created_at).toLocaleString()}</td>
              <td>{l.action}</td>
              <td>
                {l.entity_type} {l.entity_id?.slice(0, 8)}
              </td>
              <td>{l.actor_id?.slice(0, 8) ?? 'system'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Approve an ad, or reject it with a reason the advertiser will see. */
function AdDecision({ onDecide }: { onDecide: (approve: boolean, note?: string) => void }) {
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
          <TextField label="Why it was rejected (the advertiser sees this)" value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={2000} />
        </div>
        <Button type="submit" size="sm" variant="danger" disabled={!note.trim()}>
          Reject ad
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
          Cancel
        </Button>
      </form>
    );
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
        Reject
      </Button>
      <Button size="sm" onClick={() => onDecide(true)}>
        Approve ad
      </Button>
    </>
  );
}

/** Per-country rules: matching posts are withheld for viewers in that country, never deleted. */
function RegionalRules() {
  const { toast } = useSession();
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
      <Alert tone="info">
        Rules withhold matching posts only for people whose country is set to the rule&apos;s country. Authors see where their post is withheld. Record the
        legal basis for every rule; each change is in the audit log.
      </Alert>
      {items?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Country</th>
                <th>Rule</th>
                <th>Legal basis</th>
                <th>Posts withheld</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.country}</td>
                  <td>{r.kind === 'blocked_term' ? `Term: ${r.term}` : `Topic: #${r.topic}`}</td>
                  <td>{r.legalBasis}</td>
                  <td>{r.withheldPosts}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api.admin.deleteRegionalRule(r.id);
                          toast('Rule removed');
                          await load();
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No regional rules.</p>
      )}
      <Card title="Add a rule">
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
              toast(`Rule added. ${r.rule.withheldPosts} existing posts withheld in ${r.rule.country}.`);
              setValue('');
              setBasis('');
              await load();
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <Select label="Rule" value={kind} onChange={(e) => setKind(e.currentTarget.value as typeof kind)}>
            <option value="blocked_term">Withhold posts containing a term</option>
            <option value="restrict_topic">Withhold posts in a topic</option>
          </Select>
          <TextField
            label="Country code"
            hint="Two letters, for example DE"
            value={country}
            onChange={(e) => setCountry(e.currentTarget.value)}
            maxLength={2}
            required
          />
          <TextField
            label={kind === 'blocked_term' ? 'Term' : 'Topic'}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            maxLength={100}
            required
          />
          <TextField label="Legal basis" multiline value={basis} onChange={(e) => setBasis(e.currentTarget.value)} maxLength={1000} required />
          <Button type="submit" size="sm" disabled={country.length !== 2 || !value.trim() || basis.trim().length < 3}>
            Add rule
          </Button>
        </form>
      </Card>
    </div>
  );
}
