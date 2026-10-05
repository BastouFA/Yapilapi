'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeadings, Checkbox, Dialog, EmptyState, List, ListItem, Select, Skeleton, TextField } from '@yapilapi/design-system';
import type { DeveloperMiniApp, MiniAppPermission, MiniAppSurface } from '@yapilapi/api-client';
import { formatList, formatRelativeTime, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useSession } from '../../providers';

/** Webhook delivery states from the server; anything else shows as it comes. */
const DELIVERY_STATUS = {
  pending: 'dev.deliveries.pending',
  delivered: 'dev.deliveries.delivered',
  failed: 'dev.deliveries.failed',
} as const satisfies Record<string, MessageKey>;

const MINI_STATUS = {
  review: 'dev.mini.status.review',
  approved: 'dev.mini.status.approved',
  rejected: 'dev.mini.status.rejected',
} as const satisfies Record<string, MessageKey>;

const PERMISSIONS: Record<MiniAppPermission, MessageKey> = {
  profile: 'miniApps.perm.profile',
  members: 'miniApps.perm.members',
  post_message: 'miniApps.perm.postMessage',
};
const SURFACES: Record<MiniAppSurface, MessageKey> = {
  conversation: 'miniApps.surface.conversation',
  community: 'miniApps.surface.community',
  event: 'miniApps.surface.event',
  profile: 'miniApps.surface.profile',
  business: 'miniApps.surface.business',
};

type App = Awaited<ReturnType<typeof api.developer.apps>>['items'][number];

/** Why something couldn't load, with Try again. */
function LoadFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useSession();
  return (
    <div className="row">
      <span role="alert">{error}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('m.common.retry')}
      </Button>
    </div>
  );
}

/** Developer console: apps, API keys, webhooks and delivery logs, Sign in with YAPILAPI and Mini Apps. */
export default function Developers() {
  const { toast, t } = useSession();
  const [apps, setApps] = useState<App[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.developer.apps().then(
      (r) => {
        setError(null);
        setApps(r.items);
        setSelected((s) => (s && r.items.some((a) => a.id === s) ? s : (r.items[0]?.id ?? null)));
      },
      (e) => setError(errorMessage(e)),
    );
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
          setBusy(true);
          setFields({});
          try {
            const { app } = await api.developer.createApp({ name: name.trim(), ...(website.trim() ? { website: website.trim() } : {}) });
            setName('');
            setWebsite('');
            setSelected(app.id);
            await load();
          } catch (err) {
            const f = fieldErrors(err);
            if (Object.keys(f).length) setFields(f);
            else toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={t('dev.newAppName')}
          error={fields.name}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={60}
          style={{ minWidth: 220 }}
        />
        <TextField
          label={t('dev.website')}
          type="url"
          placeholder="https://example.com"
          value={website}
          onChange={(e) => setWebsite(e.currentTarget.value)}
          error={fields.website}
          maxLength={500}
          style={{ minWidth: 220 }}
        />
        <Button type="submit" disabled={!name.trim()} loading={busy} style={{ alignSelf: 'flex-end' }}>
          {t('dev.createApp')}
        </Button>
      </form>
      {error && !apps ? (
        <LoadFailed error={error} onRetry={() => void load()} />
      ) : apps?.length ? (
        <>
          <div className="row" role="group" aria-label={t('dev.yourApps')}>
            {apps.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={a.id === selected ? 'primary' : 'secondary'}
                aria-pressed={a.id === selected}
                onClick={() => setSelected(a.id)}
              >
                {a.name}
              </Button>
            ))}
          </div>
          {selected ? (
            // The app's cards sit straight under the page's h1.
            <CardHeadings level={2}>
              <AppDetail
                key={selected}
                appId={selected}
                appName={apps.find((a) => a.id === selected)?.name ?? ''}
                initialRedirects={apps.find((a) => a.id === selected)?.redirect_uris ?? []}
                onDeleted={() => (setSelected(null), void load())}
              />
            </CardHeadings>
          ) : null}
        </>
      ) : apps ? (
        <EmptyState title={t('dev.noApps.title')} body={t('dev.noApps.body')} />
      ) : (
        <Skeleton height={200} />
      )}
    </div>
  );
}

function AppDetail({ appId, appName, initialRedirects, onDeleted }: { appId: string; appName: string; initialRedirects: string[]; onDeleted: () => void }) {
  const { toast, locale, t, tp } = useSession();
  const [keys, setKeys] = useState<Awaited<ReturnType<typeof api.developer.keys>>['items'] | null>(null);
  const [hooks, setHooks] = useState<Awaited<ReturnType<typeof api.developer.webhooks>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [write, setWrite] = useState(false);
  const [expires, setExpires] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['post.created']);
  const [redirects, setRedirects] = useState(initialRedirects.join('\n'));
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: string; run: () => Promise<void> } | null>(null);
  const load = async () => {
    try {
      const [k, h] = await Promise.all([api.developer.keys(appId), api.developer.webhooks(appId)]);
      setKeys(k.items);
      setHooks(h);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);
  /** Run a change; say what went wrong if it didn't work. */
  const attempt = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    }
  };

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
      {loadError ? <LoadFailed error={loadError} onRetry={() => void load()} /> : null}

      <Card title={t('dev.oauth.title')} subtitle={t('dev.oauth.subtitle')}>
        <div className="stack-sm">
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, overflowWrap: 'anywhere' }}>client_id = {appId}</code>
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
          {keys === null && !loadError ? <Skeleton height={60} /> : null}
          {keys?.length ? (
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
                        onClick={() =>
                          setConfirm({
                            title: t('dev.keys.revokeTitle', { name: k.name }),
                            body: t('dev.keys.revokeBody'),
                            action: t('dev.keys.revoke'),
                            run: async () => {
                              if (await attempt(() => api.developer.revokeKey(appId, k.id), t('dev.keys.revokedToast'))) await load();
                            },
                          })
                        }
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
                const r = await api.developer.createKey(appId, {
                  name: keyName.trim(),
                  scopes: write ? ['read', 'write'] : ['read'],
                  ...(expires ? { expiresInDays: Number(expires) } : {}),
                });
                setSecret({ label: t('dev.keys.newSecret'), value: r.secret });
                setKeyName('');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <TextField label={t('dev.keys.name')} value={keyName} onChange={(e) => setKeyName(e.currentTarget.value)} maxLength={60} />
            <Select label={t('dev.keys.expires')} value={expires} onChange={(e) => setExpires(e.currentTarget.value)}>
              <option value="">{t('dev.keys.never')}</option>
              {[30, 90, 365].map((d) => (
                <option key={d} value={d}>
                  {tp('dev.keys.days', d)}
                </option>
              ))}
            </Select>
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
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{h.url}</code> <span className="muted">· {h.events.join(', ')}</span>
                </span>
                <span className="row">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      if (await attempt(() => api.developer.ping(appId, h.id), t('dev.hooks.testQueued'))) setTimeout(() => void load(), 6000);
                    }}
                  >
                    {t('dev.hooks.sendTest')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setConfirm({
                        title: t('dev.hooks.removeTitle'),
                        body: t('dev.hooks.removeBody', { url: h.url }),
                        action: t('m.common.remove'),
                        run: async () => {
                          if (await attempt(() => api.developer.deleteWebhook(appId, h.id))) await load();
                        },
                      })
                    }
                  >
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
                const r = await api.developer.createWebhook(appId, url.trim(), events);
                setSecret({ label: t('dev.hooks.secret'), value: r.secret });
                setUrl('');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <TextField label={t('dev.hooks.url')} placeholder="https://example.com/yapilapi" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
            <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="yp-visually-hidden">{t('dev.hooks.events')}</legend>
              {hooks?.events
                .filter((ev) => ev !== 'ping')
                .map((ev) => (
                  <Checkbox
                    key={ev}
                    label={ev}
                    checked={events.includes(ev)}
                    onChange={(e) => {
                      // Read now: the event is gone by the time the update runs.
                      const on = e.currentTarget.checked;
                      setEvents((cur) => (on ? [...cur, ev] : cur.filter((x) => x !== ev)));
                    }}
                  />
                ))}
            </fieldset>
            <Button type="submit" size="sm" disabled={!url.trim() || !events.length}>
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

      <MiniApps appId={appId} />

      <Button
        variant="danger"
        size="sm"
        onClick={() =>
          setConfirm({
            title: t('dev.deleteTitle', { name: appName }),
            body: t('dev.deleteBody'),
            action: t('dev.deleteApp'),
            run: async () => {
              if (await attempt(() => api.developer.deleteApp(appId), t('dev.appDeleted'))) onDeleted();
            },
          })
        }
      >
        {t('dev.deleteApp')}
      </Button>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const c = confirm;
                setConfirm(null);
                await c?.run();
              }}
            >
              {confirm?.action ?? ''}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{confirm?.body}</p>
      </Dialog>
    </div>
  );
}

/** Submit a Mini App for review, and see where each one is. */
function MiniApps({ appId }: { appId: string }) {
  const { toast, locale, t, tp } = useSession();
  const [items, setItems] = useState<DeveloperMiniApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [entryUrl, setEntryUrl] = useState('');
  const [permissions, setPermissions] = useState<MiniAppPermission[]>([]);
  const [surfaces, setSurfaces] = useState<MiniAppSurface[]>(['conversation']);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.developer.miniApps(appId).then(
      (r) => {
        setItems(r.items);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  return (
    <Card title={t('dev.mini.title')} subtitle={t('dev.mini.subtitle')}>
      <div className="stack">
        {error && !items ? <LoadFailed error={error} onRetry={() => void load()} /> : null}
        {items?.length ? (
          <List>
            {items.map((m) => (
              <ListItem
                key={m.id}
                primary={m.name}
                secondary={[
                  formatList(
                    m.surfaces.map((s) => (SURFACES[s] ? t(SURFACES[s]) : s)),
                    locale,
                  ),
                  tp('dev.mini.installs', m.installs),
                  formatRelativeTime(m.createdAt, locale),
                ].join(' · ')}
                end={<Badge tone={m.status === 'approved' ? 'success' : m.status === 'rejected' ? 'danger' : 'warning'}>{t(MINI_STATUS[m.status])}</Badge>}
              />
            ))}
          </List>
        ) : null}
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.developer.submitMiniApp(appId, {
                name: name.trim(),
                description: description.trim(),
                entryUrl: entryUrl.trim(),
                permissions,
                surfaces,
              });
              toast(t('dev.mini.submitted'));
              setName('');
              setDescription('');
              setEntryUrl('');
              setPermissions([]);
              await load();
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label={t('dev.mini.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={60} required />
          <TextField label={t('dev.mini.description')} multiline value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={500} />
          <TextField
            label={t('dev.mini.entryUrl')}
            hint={t('dev.mini.entryUrlHint')}
            type="url"
            placeholder="https://example.com/mini"
            value={entryUrl}
            onChange={(e) => setEntryUrl(e.currentTarget.value)}
            maxLength={500}
            required
          />
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="yp-field__label">{t('dev.mini.permissions')}</legend>
            {(Object.keys(PERMISSIONS) as MiniAppPermission[]).map((p) => (
              <Checkbox
                key={p}
                label={t(PERMISSIONS[p])}
                checked={permissions.includes(p)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setPermissions((cur) => toggle(cur, p, on));
                }}
              />
            ))}
          </fieldset>
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="yp-field__label">{t('dev.mini.surfaces')}</legend>
            {(Object.keys(SURFACES) as MiniAppSurface[]).map((s) => (
              <Checkbox
                key={s}
                label={t(SURFACES[s])}
                checked={surfaces.includes(s)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setSurfaces((cur) => toggle(cur, s, on));
                }}
              />
            ))}
          </fieldset>
          <Button type="submit" size="sm" loading={busy} disabled={!name.trim() || !entryUrl.trim() || !surfaces.length}>
            {t('dev.mini.submit')}
          </Button>
        </form>
      </div>
    </Card>
  );
}
