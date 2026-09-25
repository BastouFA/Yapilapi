'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, EmptyState, Stat, Switch, Tabs } from '@yapilapi/design-system';
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
                { id: 'audit', label: 'Audit log' },
              ]
            : []),
        ]}
      />
      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tabs-${tab}`}>
        {tab === 'moderation' ? <Moderation /> : tab === 'overview' ? <Overview /> : tab === 'flags' ? <Flags /> : <Audit />}
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
  const decide = async (id: string, decision: string) => {
    try {
      await api.admin.decide(id, decision);
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
            title={`${c.target_type} · ${c.risk}`}
            subtitle={`${c.source} · @${c.subject_username ?? 'unknown'} · ${formatRelativeTime(c.created_at, locale)}`}
            footer={
              ['open', 'appealed'].includes(c.status) ? (
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
