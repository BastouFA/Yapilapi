'use client';

import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Alert, Button, Card, Dialog, Icon, List, ListItem, Switch, TextField } from '@yapilapi/design-system';
import { formatRelativeTime, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { disableBrowserPush } from '@/lib/push';
import { PasswordField } from '@/components/PasswordField';
import { useSession } from '@/app/providers';
import { Anchor } from './Shell';

/** Where you're signed in: log out any other device, or every device at once (this one too). */
export function SessionsCard() {
  const { toast, locale, t } = useSession();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.auth.sessions>>['items'] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.auth.sessions().then(
      (r) => setSessions(r.items),
      (e) => (setSessions([]), toast(errorMessage(e))),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Anchor id="sessions">
      <Card title={t('settings.sessions.title')} subtitle={t('st.sessions.desc')}>
        <div className="stack-sm">
          {sessions?.length ? (
            <List>
              {sessions.map((s) => (
                <ListItem
                  key={s.id}
                  start={
                    <span className="settings-row__icon" aria-hidden>
                      <Icon name={/phone|iphone|android|mobile/i.test(s.device) ? 'device' : 'globe'} />
                    </span>
                  }
                  primary={s.current ? t('settings.sessions.thisDevice', { device: s.device }) : s.device}
                  secondary={t('settings.sessions.meta', { ip: s.ip ?? t('settings.sessions.unknownIp'), time: formatRelativeTime(s.last_seen_at, locale) })}
                  end={
                    s.current ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          await api.auth.revokeSession(s.id).catch((e) => toast(errorMessage(e)));
                          await load();
                        }}
                      >
                        {t('st.sessions.logout')}
                      </Button>
                    )
                  }
                />
              ))}
            </List>
          ) : null}
          <Button variant="danger" icon="logout" onClick={() => setConfirming(true)}>
            {t('st.logoutAll')}
          </Button>
        </div>
      </Card>
      <Dialog
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        title={t('st.logoutAll.title')}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await Promise.race([disableBrowserPush().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
                try {
                  await api.auth.logoutAll();
                } catch (e) {
                  setBusy(false);
                  return toast(errorMessage(e));
                }
                location.replace('/login?loggedOut=1');
              }}
            >
              {t('st.logoutAll')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('st.logoutAll.body')}</p>
      </Dialog>
    </Anchor>
  );
}

const EVENTS: Record<string, MessageKey> = {
  login: 'st.event.login',
  login_failed: 'st.event.login_failed',
  login_password_ok_mfa_pending: 'st.event.login_pending',
  password_changed: 'st.event.password_changed',
  password_reset: 'st.event.password_reset',
  password_reset_requested: 'st.event.password_reset_requested',
  mfa_enabled: 'st.event.mfa_enabled',
  mfa_disabled: 'st.event.mfa_disabled',
  sessions_revoked: 'st.event.sessions_revoked',
  session_revoked: 'st.event.session_revoked',
  account_created: 'st.event.account_created',
  email_verified: 'st.event.email_verified',
  username_changed: 'st.event.username_changed',
  sign_in_alerts_on: 'st.event.sign_in_alerts_on',
  sign_in_alerts_off: 'st.event.sign_in_alerts_off',
};

/**
 * Opened from "This wasn't me" in a sign-in alert (?review=sign-in): what to do, right above the
 * devices signed in to the account.
 */
export function SignInReview() {
  const { t } = useSession();
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(new URLSearchParams(window.location.search).get('review') === 'sign-in');
  }, []);
  if (!show) return null;
  return (
    <Alert tone="warning" title={t('st.review.title')}>
      <p style={{ margin: '0 0 8px' }}>{t('st.review.body')}</p>
      <a href="#password" className="yp-btn yp-btn--secondary yp-btn--sm">
        {t('st.review.password')}
      </a>
    </Alert>
  );
}

/** Sign-in alerts: always a notification in the app for a new device; the email can be turned off. */
export function SignInAlertsCard() {
  const { t, toast } = useSession();
  const [email, setEmail] = useState<boolean | null>(null);
  useEffect(() => {
    api.me.signInAlerts().then(
      (r) => setEmail(r.email),
      () => setEmail(true),
    );
  }, []);
  return (
    <Anchor id="alerts">
      <Card title={t('st.alerts.title')} subtitle={t('st.alerts.desc')}>
        <div className="stack-sm">
          <Switch
            label={t('st.alerts.email')}
            checked={email ?? true}
            disabled={email === null}
            onChange={async (on) => {
              const before = email;
              setEmail(on);
              try {
                setEmail((await api.me.setSignInAlerts(on)).email);
              } catch (e) {
                setEmail(before);
                toast(errorMessage(e));
              }
            }}
          />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('st.alerts.emailHint')}
          </p>
        </div>
      </Card>
    </Anchor>
  );
}

/** Login alerts and activity: recent sign-ins and changes to the account, newest first. */
export function ActivityCard() {
  const { t, locale } = useSession();
  const [items, setItems] = useState<{ type: string; ip: string | null; created_at: string }[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api.auth.securityEvents().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, []);
  if (!items) return null;
  const shown = all ? items : items.slice(0, 6);
  return (
    <Anchor id="activity">
      <Card title={t('st.activity.title')} subtitle={t('st.activity.desc')}>
        {items.length ? (
          <div className="stack-sm">
            <List>
              {shown.map((e, i) => (
                <ListItem
                  key={`${e.created_at}-${i}`}
                  start={
                    <span className={`settings-row__icon${e.type === 'login_failed' ? ' settings-row__icon--warn' : ''}`} aria-hidden>
                      <Icon name={e.type === 'login_failed' ? 'alert' : e.type.startsWith('login') ? 'key' : 'shield'} />
                    </span>
                  }
                  primary={t(EVENTS[e.type] ?? 'st.event.other')}
                  secondary={[formatRelativeTime(e.created_at, locale), e.ip].filter(Boolean).join(' · ')}
                />
              ))}
            </List>
            {items.length > 6 && !all ? (
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                {t('st.activity.more')}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('st.activity.none')}
          </p>
        )}
      </Card>
    </Anchor>
  );
}

export function TwoStepCard() {
  const { toast, t, tp } = useSession();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.mfa.status().then(setStatus);
  useEffect(() => {
    void load();
  }, []);
  if (!status) return null;

  return (
    <Anchor id="two-step">
      <Card title={t('settings.twoStep.title')} subtitle={status.enabled ? tp('settings.twoStep.on', status.recoveryCodesLeft) : t('settings.twoStep.offHint')}>
        <div className="stack-sm">
          {err ? <Alert tone="danger">{err}</Alert> : null}
          {codes ? (
            <Alert tone="warning" title={t('settings.twoStep.saveCodes')}>
              {t('settings.twoStep.codesHint')}
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 14, lineHeight: '22px', margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
                {codes.join('\n')}
              </pre>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => toast((await copyText(codes.join('\n'))) ? t('settings.twoStep.copied') : t('common.copyFailed'))}
              >
                {t('settings.twoStep.copy')}
              </Button>
            </Alert>
          ) : null}
          {!status.enabled && !setup ? (
            <Button
              icon="shield"
              onClick={async () => {
                setErr(null);
                try {
                  setSetup(await api.mfa.setup());
                } catch (e) {
                  setErr(errorMessage(e));
                }
              }}
            >
              {t('settings.twoStep.turnOn')}
            </Button>
          ) : null}
          {setup ? (
            <form
              className="stack-sm"
              onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                try {
                  setCodes((await api.mfa.confirm(code)).recoveryCodes);
                  setSetup(null);
                  setCode('');
                  await load();
                } catch (e2) {
                  setErr(errorMessage(e2));
                }
              }}
            >
              <p style={{ margin: 0 }}>{t('settings.twoStep.addKey')}</p>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 15, letterSpacing: '.08em', wordBreak: 'break-all' }}>
                {setup.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
              <a href={setup.otpauthUri}>{t('settings.twoStep.openApp')}</a>
              <TextField
                label={t('settings.twoStep.code')}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
              />
              <div className="row">
                <Button type="submit" disabled={code.length !== 6}>
                  {t('settings.twoStep.verify')}
                </Button>
                <Button variant="ghost" onClick={() => setSetup(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : null}
          {status.enabled && !disabling ? (
            <Button variant="secondary" onClick={() => setDisabling(true)}>
              {t('settings.twoStep.turnOff')}
            </Button>
          ) : null}
          {disabling ? (
            <form
              className="stack-sm"
              onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                try {
                  await api.mfa.disable(password, code);
                  setDisabling(false);
                  setPassword('');
                  setCode('');
                  setCodes(null);
                  toast(t('settings.twoStep.isOff'));
                  await load();
                } catch (e2) {
                  setErr(errorMessage(e2));
                }
              }}
            >
              <PasswordField label={t('auth.password')} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
              <TextField
                label={t('settings.twoStep.codeOrRecovery')}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
                autoComplete="one-time-code"
                maxLength={12}
              />
              <div className="row">
                <Button type="submit" variant="danger" disabled={!password || code.length < 6}>
                  {t('settings.twoStep.turnOffFull')}
                </Button>
                <Button variant="ghost" onClick={() => setDisabling(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </Card>
    </Anchor>
  );
}

export function PasskeysCard() {
  const { toast, locale, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.passkeys.list>>['items']>([]);
  const load = () => api.passkeys.list().then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Anchor id="passkeys">
      <Card title={t('settings.passkeys.title')} subtitle={t('settings.passkeys.subtitle')}>
        <div className="stack-sm">
          {items.length ? (
            <List>
              {items.map((p) => (
                <ListItem
                  key={p.id}
                  primary={p.label}
                  secondary={
                    p.last_used_at ? t('settings.passkeys.used', { time: formatRelativeTime(p.last_used_at, locale) }) : t('settings.passkeys.notUsed')
                  }
                  end={
                    <Button size="sm" variant="ghost" onClick={async () => (await api.passkeys.remove(p.id), await load())}>
                      {t('dataSaver.remove')}
                    </Button>
                  }
                />
              ))}
            </List>
          ) : null}
          <Button
            icon="shield"
            variant="secondary"
            onClick={async () => {
              try {
                const { options, challengeId } = await api.passkeys.registerOptions();
                const response = await startRegistration({ optionsJSON: options });
                await api.passkeys.registerVerify(challengeId, response, navigator.platform ? `Passkey on ${navigator.platform}` : 'Passkey');
                toast(t('settings.passkeys.added'));
                await load();
              } catch (e) {
                if ((e as Error).name !== 'NotAllowedError') toast(errorMessage(e));
              }
            }}
          >
            {t('settings.passkeys.add')}
          </Button>
        </div>
      </Card>
    </Anchor>
  );
}

export function ConnectedAppsCard() {
  const { toast, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.oauth.connectedApps>>['items']>([]);
  const load = () => api.oauth.connectedApps().then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Anchor id="apps">
      <Card title={t('settings.apps.title')} subtitle={t('settings.apps.subtitle')}>
        {items.length ? (
          <List>
            {items.map((a) => (
              <ListItem
                key={a.id}
                primary={a.name}
                secondary={a.scopes.includes('write') ? t('settings.apps.readPost') : t('settings.apps.read')}
                end={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => (await api.oauth.disconnect(a.id), toast(t('settings.apps.disconnected', { name: a.name })), await load())}
                  >
                    {t('settings.apps.disconnect')}
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('settings.apps.none')}
          </p>
        )}
      </Card>
    </Anchor>
  );
}
