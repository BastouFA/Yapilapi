'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, List, ListItem, TextField } from '@yapilapi/design-system';
import { formatRelativeTime } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

type App = Awaited<ReturnType<typeof api.developer.apps>>['items'][number];

/** Developer console: apps, API keys, webhooks and delivery logs. */
export default function Developers() {
  const { toast } = useSession();
  const [apps, setApps] = useState<App[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = () =>
    api.developer.apps().then((r) => {
      setApps(r.items);
      setSelected((s) => s ?? r.items[0]?.id ?? null);
    });
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="yp-shell__inner yp-shell__inner--wide">
      <div className="yp-topbar">
        <h1>Developers</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        API keys act as you. Read keys can only fetch; write keys can post and change things. Keys can never manage your account, other keys, exports or
        payouts.
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const { app } = await api.developer.createApp({ name });
            setName('');
            setSelected(app.id);
            await load();
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <TextField label="New app name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={60} style={{ minWidth: 240 }} />
        <Button type="submit" disabled={!name.trim()} style={{ alignSelf: 'flex-end' }}>
          Create app
        </Button>
      </form>
      {apps?.length ? (
        <>
          <div className="row">
            {apps.map((a) => (
              <Button key={a.id} size="sm" variant={a.id === selected ? 'primary' : 'secondary'} onClick={() => setSelected(a.id)}>
                {a.name}
              </Button>
            ))}
          </div>
          {selected ? (
            <AppDetail
              key={selected}
              appId={selected}
              initialRedirects={apps.find((a) => a.id === selected)?.redirect_uris ?? []}
              onDeleted={() => (setSelected(null), void load())}
            />
          ) : null}
        </>
      ) : apps ? (
        <EmptyState title="No apps yet" body="Create an app to get API keys and webhooks." />
      ) : null}
    </div>
  );
}

function AppDetail({ appId, initialRedirects, onDeleted }: { appId: string; initialRedirects: string[]; onDeleted: () => void }) {
  const { toast, locale } = useSession();
  const [keys, setKeys] = useState<Awaited<ReturnType<typeof api.developer.keys>>['items']>([]);
  const [hooks, setHooks] = useState<Awaited<ReturnType<typeof api.developer.webhooks>> | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [write, setWrite] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['post.created']);
  const [redirects, setRedirects] = useState(initialRedirects.join('\n'));
  const load = async () => {
    setKeys((await api.developer.keys(appId)).items);
    setHooks(await api.developer.webhooks(appId));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  return (
    <div className="stack">
      {secret ? (
        <Alert tone="warning" title={secret.label} onDismiss={() => setSecret(null)}>
          Copy it now. It won't be shown again.
          <pre style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '8px 0' }}>{secret.value}</pre>
          <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(secret.value).then(() => toast('Copied'))}>
            Copy
          </Button>
        </Alert>
      ) : null}

      <Card
        title="Sign in with YAPILAPI (OAuth)"
        subtitle="Authorization code flow with PKCE. Client ID is the app ID below. Redirect addresses must match exactly."
      >
        <div className="stack-sm">
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>client_id = {appId}</code>
          <TextField label="Redirect addresses (one per line)" multiline value={redirects} onChange={(e) => setRedirects(e.currentTarget.value)} />
          <Button
            size="sm"
            onClick={async () => {
              try {
                const r = await api.oauth.setRedirectUris(
                  appId,
                  redirects
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean),
                );
                setRedirects(r.redirectUris.join('\n'));
                toast('Redirect addresses saved');
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            Save redirect addresses
          </Button>
        </div>
      </Card>
      <Card title="API keys" subtitle="Send as: Authorization: Bearer <key>">
        <div className="stack-sm">
          {keys.length ? (
            <List>
              {keys.map((k) => (
                <ListItem
                  key={k.id}
                  primary={
                    <>
                      {k.name} <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{k.prefix}_…</code>
                    </>
                  }
                  secondary={`${k.scopes.join(' + ')} · ${k.last_used_at ? `used ${formatRelativeTime(k.last_used_at, locale)}` : 'never used'}`}
                  end={
                    k.revoked_at ? (
                      <Badge tone="neutral">Revoked</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={async () => (await api.developer.revokeKey(appId, k.id), await load(), toast('Key revoked'))}>
                        Revoke
                      </Button>
                    )
                  }
                />
              ))}
            </List>
          ) : null}
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api.developer.createKey(appId, { name: keyName, scopes: write ? ['read', 'write'] : ['read'] });
                setSecret({ label: 'Your new API key', value: r.secret });
                setKeyName('');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <TextField label="Key name" value={keyName} onChange={(e) => setKeyName(e.currentTarget.value)} maxLength={60} />
            <Checkbox label="Allow writes" checked={write} onChange={(e) => setWrite(e.currentTarget.checked)} />
            <Button type="submit" size="sm" disabled={!keyName.trim()}>
              Create key
            </Button>
          </form>
        </div>
      </Card>

      <Card title="Webhooks" subtitle="We POST signed JSON. Verify x-yapilapi-signature: t=<time>,v1=HMAC-SHA256(secret, t + '.' + body).">
        <div className="stack-sm">
          {hooks?.items
            .filter((h) => h.active)
            .map((h) => (
              <div key={h.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{h.url}</code> <span className="muted">· {h.events.join(', ')}</span>
                </span>
                <span className="row">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => (await api.developer.ping(appId, h.id), toast('Test event queued'), setTimeout(load, 6000))}
                  >
                    Send test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={async () => (await api.developer.deleteWebhook(appId, h.id), await load())}>
                    Remove
                  </Button>
                </span>
              </div>
            ))}
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api.developer.createWebhook(appId, url, events);
                setSecret({ label: 'Webhook signing secret', value: r.secret });
                setUrl('');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <TextField label="Endpoint URL" placeholder="https://example.com/yapilapi" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
            <div className="row">
              {hooks?.events
                .filter((ev) => ev !== 'ping')
                .map((ev) => (
                  <Checkbox
                    key={ev}
                    label={ev}
                    checked={events.includes(ev)}
                    onChange={(e) => setEvents((cur) => (e.currentTarget.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))}
                  />
                ))}
            </div>
            <Button type="submit" size="sm" disabled={!url || !events.length}>
              Add webhook
            </Button>
          </form>
          {hooks?.deliveries.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Response</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {hooks.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>{d.event}</td>
                      <td>
                        <Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>{d.status}</Badge>
                      </td>
                      <td>{d.attempts}</td>
                      <td>{d.response_code ?? '—'}</td>
                      <td>{formatRelativeTime(d.created_at, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </Card>

      <Button
        variant="danger"
        size="sm"
        onClick={async () => {
          await api.developer.deleteApp(appId);
          toast('App deleted and its keys revoked');
          onDeleted();
        }}
      >
        Delete app
      </Button>
    </div>
  );
}
