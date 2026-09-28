'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, List, ListItem, TextField } from '@yapilapi/design-system';
import { formatRelativeTime, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useSession } from '../../providers';

/** Webhook delivery states from the server; anything else shows as it comes. */
const DELIVERY_STATUS = {
  pending: 'dev.deliveries.pending',
  delivered: 'dev.deliveries.delivered',
  failed: 'dev.deliveries.failed',
} as const satisfies Record<string, MessageKey>;

type App = Awaited<ReturnType<typeof api.developer.apps>>['items'][number];

/** Developer console: apps, API keys, webhooks and delivery logs. */
export default function Developers() {
  const { toast, t } = useSession();
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
        <h1>{t('settings.dev.title')}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('dev.intro')}
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
        <TextField label={t('dev.newAppName')} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={60} style={{ minWidth: 240 }} />
        <Button type="submit" disabled={!name.trim()} style={{ alignSelf: 'flex-end' }}>
          {t('dev.createApp')}
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
        <EmptyState title={t('dev.noApps.title')} body={t('dev.noApps.body')} />
      ) : null}
    </div>
  );
}

function AppDetail({ appId, initialRedirects, onDeleted }: { appId: string; initialRedirects: string[]; onDeleted: () => void }) {
  const { toast, locale, t } = useSession();
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
        <Alert tone="warning" title={secret.label} onDismiss={() => setSecret(null)} locale={locale}>
          {t('dev.secret.copyNow')}
          <pre style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '8px 0' }}>{secret.value}</pre>
          <Button size="sm" variant="secondary" onClick={async () => toast((await copyText(secret.value)) ? t('dev.copied') : t('common.copyFailed'))}>
            {t('dev.copy')}
          </Button>
        </Alert>
      ) : null}

      <Card title={t('dev.oauth.title')} subtitle={t('dev.oauth.subtitle')}>
        <div className="stack-sm">
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>client_id = {appId}</code>
          <TextField label={t('dev.oauth.redirects')} multiline value={redirects} onChange={(e) => setRedirects(e.currentTarget.value)} />
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
                toast(t('dev.oauth.saved'));
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            {t('dev.oauth.save')}
          </Button>
        </div>
      </Card>
      <Card title={t('dev.keys.title')} subtitle={t('dev.keys.subtitle', { header: 'Authorization: Bearer <key>' })}>
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
                  secondary={`${k.scopes.join(' + ')} · ${k.last_used_at ? t('settings.passkeys.used', { time: formatRelativeTime(k.last_used_at, locale) }) : t('dev.keys.neverUsed')}`}
                  end={
                    k.revoked_at ? (
                      <Badge tone="neutral">{t('dev.keys.revoked')}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => (await api.developer.revokeKey(appId, k.id), await load(), toast(t('dev.keys.revokedToast')))}
                      >
                        {t('dev.keys.revoke')}
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
                setSecret({ label: t('dev.keys.newSecret'), value: r.secret });
                setKeyName('');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <TextField label={t('dev.keys.name')} value={keyName} onChange={(e) => setKeyName(e.currentTarget.value)} maxLength={60} />
            <Checkbox label={t('dev.keys.allowWrites')} checked={write} onChange={(e) => setWrite(e.currentTarget.checked)} />
            <Button type="submit" size="sm" disabled={!keyName.trim()}>
              {t('dev.keys.create')}
            </Button>
          </form>
        </div>
      </Card>

      <Card
        title={t('dev.hooks.title')}
        subtitle={t('dev.hooks.subtitle', { header: "x-yapilapi-signature: t=<time>,v1=HMAC-SHA256(secret, t + '.' + body)" })}
      >
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
                    onClick={async () => (await api.developer.ping(appId, h.id), toast(t('dev.hooks.testQueued')), setTimeout(load, 6000))}
                  >
                    {t('dev.hooks.sendTest')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={async () => (await api.developer.deleteWebhook(appId, h.id), await load())}>
                    {t('m.common.remove')}
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
                setSecret({ label: t('dev.hooks.secret'), value: r.secret });
                setUrl('');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <TextField label={t('dev.hooks.url')} placeholder="https://example.com/yapilapi" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
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
              {t('dev.hooks.add')}
            </Button>
          </form>
          {hooks?.deliveries.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('dev.deliveries.event')}</th>
                    <th>{t('dev.deliveries.status')}</th>
                    <th>{t('dev.deliveries.attempts')}</th>
                    <th>{t('dev.deliveries.response')}</th>
                    <th>{t('dev.deliveries.when')}</th>
                  </tr>
                </thead>
                <tbody>
                  {hooks.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>{d.event}</td>
                      <td>
                        <Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>
                          {d.status in DELIVERY_STATUS ? t(DELIVERY_STATUS[d.status as keyof typeof DELIVERY_STATUS]) : d.status}
                        </Badge>
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
          toast(t('dev.appDeleted'));
          onDeleted();
        }}
      >
        {t('dev.deleteApp')}
      </Button>
    </div>
  );
}
