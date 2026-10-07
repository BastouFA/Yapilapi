'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Avatar, Button, Checkbox, TextField } from '@yapilapi/design-system';
import type { BrowserAccount, Me, MessageKey } from '@yapilapi/shared';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { ApiError } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { authHref, startAs, switchAccount } from '@/lib/accounts';
import { PasswordField } from '@/components/PasswordField';
import { useSession } from '../../providers';

/**
 * What went wrong, in the reader's language where we know the case. `twoStep`: the code step, where
 * a 401 means the sign-in expired (the server's message is already in the reader's language, so it
 * can't be matched on).
 */
function problem(e: unknown, t: (k: MessageKey) => string, twoStep = false): string {
  if (e instanceof ApiError) {
    if (e.code === 'network') return t('error.network');
    // Too many wrong passwords for the account, or wrong codes for this sign-in: the server says what to do.
    if (e.status === 429) return e.code === 'too_many_attempts' ? e.message : t('m.auth.tooMany');
    if (e.status === 401) return twoStep ? t('m.auth.challengeExpired') : t('m.auth.wrongPassword');
    if (e.status === 400 && e.fields?.code) return t('m.auth.codeWrong');
  }
  return errorMessage(e);
}

/**
 * Log in: email and password (show or hide it), "Stay signed in" (on unless you turn it off, for a
 * shared computer), a passkey where the browser has them, and the two-step code for accounts that
 * use it. After logging in you go back to where you were (a same-site `next` only). After logging
 * out, it says so, and accounts still signed in on this browser can be continued with a tap.
 *
 * `?add=1` (Add account, from the account menu): logging in to another account keeps the ones
 * already signed in on this browser, and the page starts again as the new one. Cancel goes back.
 */
function LoginForm() {
  const { me, loading, setMe, t } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const loggedOut = params.get('loggedOut') === '1';
  const adding = params.get('add') === '1';
  // The accounts signed in on this browser: to continue as one (signed out), or to know the browser is full (adding).
  const [accounts, setAccounts] = useState<{ items: BrowserAccount[]; max: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [passkeys, setPasskeys] = useState(false);
  // A suspended account signed in with the right password: it can appeal from here (it can't reach Settings).
  const [appealToken, setAppealToken] = useState<string | null>(null);
  useEffect(() => setPasskeys(browserSupportsWebAuthn()), []);
  useEffect(() => {
    if (loading || (me && !adding)) return;
    api.auth.accounts().then(setAccounts, () => {});
  }, [loading, me, adding]);

  // Already signed in (another tab logged in): carry on to where you were going. Not when adding an account.
  useEffect(() => {
    if (!loading && me && !busy && !adding) router.replace(!me.onboarded ? '/onboarding' : (next ?? '/home'));
  }, [loading, me, busy, next, router, adding]);

  function done(user: Me) {
    const dest = !user.onboarded ? '/onboarding' : (next ?? '/home');
    // Another account was in use: the page starts again as this one, so nothing of the other stays.
    if (adding && me) return void startAs(dest);
    setMe(user);
    router.replace(dest);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setAppealToken(null);
    try {
      if (challenge) {
        done((await api.mfa.verify(challenge, String(f.get('code')).replace(/\s+/g, ''), remember, adding)).user);
        return;
      }
      const r = await api.auth.login({
        email: String(f.get('email')).trim(),
        password: String(f.get('password')),
        ...(remember ? {} : { remember: false }),
        ...(adding ? { addAccount: true } : {}),
      });
      if (r.mfaRequired && r.challengeToken) {
        setChallenge(r.challengeToken);
        setBusy(false);
      } else if (r.user) done(r.user);
    } catch (err) {
      const message = problem(err, t, !!challenge);
      setError(message);
      const appeal = err instanceof ApiError && err.code === 'account_suspended' ? (err.details?.appeal as { token?: string } | undefined) : undefined;
      if (appeal?.token) setAppealToken(appeal.token);
      // An expired two-step sign-in (or one with too many wrong codes) starts again from the password.
      if (challenge && err instanceof ApiError && (err.status === 401 || err.code === 'too_many_attempts')) setChallenge(null);
      setBusy(false);
    }
  }

  if (challenge)
    return (
      <form className="stack" onSubmit={submit} noValidate>
        <h1>{t('m.auth.twoStep.title')}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {t('m.auth.twoStep.body')}
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label={t('m.auth.twoStep.code')}
          name="code"
          autoComplete="one-time-code"
          inputMode="text"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          maxLength={14}
        />
        <Button type="submit" block loading={busy}>
          {t('m.auth.twoStep.submit')}
        </Button>
        <Button variant="ghost" block onClick={() => (setChallenge(null), setError(null))}>
          {t('auth.otherAccount')}
        </Button>
      </form>
    );

  // Signed out with other accounts still signed in on this browser: one tap continues as one of them.
  const waiting = !adding && !me ? (accounts?.items ?? []) : [];
  const full = adding && !!accounts && accounts.items.length >= accounts.max;

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="stack-sm" style={{ gap: 4 }}>
        <h1>{adding ? t('acct.addTitle') : t('auth.login.title')}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {adding ? t('acct.addHint') : t('m.auth.login.body')}
        </p>
      </div>
      {loggedOut && !error ? <Alert tone="success">{t('acct.loggedOut')}</Alert> : null}
      {full && !error ? <Alert tone="warning">{t('acct.maxBrowser', { count: accounts!.max })}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {waiting.length ? (
        <ul className="auth__accounts">
          {waiting.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="auth__account"
                aria-label={t('acct.switchTo', { username: a.username })}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await switchAccount(a.id, next ?? '/home');
                  } catch (err) {
                    // Its session ended since: it has left the list.
                    setError(problem(err, t));
                    setAccounts((l) => (l ? { ...l, items: l.items.filter((x) => x.id !== a.id) } : l));
                    setBusy(false);
                  }
                }}
              >
                <Avatar name={a.displayName} src={a.avatarUrl} size="md" />
                <span className="account-menu__names">
                  <bdi className="account-menu__name">{a.displayName}</bdi>
                  <span className="account-menu__handle">@{a.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {appealToken ? <SuspensionAppeal token={appealToken} onDone={() => setAppealToken(null)} /> : null}
      <TextField
        label={t('auth.email')}
        name="email"
        type="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
      />
      {/* 14px: the password field's show button and the link under it each keep a 44px touch target. */}
      <div className="stack-sm" style={{ gap: 14 }}>
        <PasswordField label={t('auth.password')} name="password" autoComplete="current-password" required />
        <Link href="/forgot-password" className="auth__forgot">
          {t('auth.forgot')}
        </Link>
      </div>
      <Checkbox label={t('auth.remember')} description={t('auth.rememberHint')} checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
      <Button type="submit" block loading={busy}>
        {t('auth.login.submit')}
      </Button>
      {passkeys ? (
        <>
          <div className="auth__or" role="separator">
            <span>{t('auth.or')}</span>
          </div>
          <Button
            variant="secondary"
            block
            icon="key"
            onClick={async () => {
              setError(null);
              try {
                const { options, challengeId } = await api.passkeys.loginOptions();
                const response = await startAuthentication({ optionsJSON: options });
                done((await api.passkeys.loginVerify(challengeId, response, remember, adding)).user);
              } catch (err) {
                if ((err as Error).name !== 'NotAllowedError') setError(problem(err, t));
              }
            }}
          >
            {t('auth.passkey')}
          </Button>
        </>
      ) : null}
      <p className="auth__foot" style={{ textAlign: 'center' }}>
        {t('auth.noAccount')} <Link href={authHref('/signup', next, adding)}>{t('auth.signup.submit')}</Link>
      </p>
      {adding ? (
        <p className="auth__foot" style={{ textAlign: 'center' }}>
          <Link href={next ?? '/home'}>{t('common.cancel')}</Link>
        </p>
      ) : null}
    </form>
  );
}

/**
 * Appealing a suspension from the sign-in page, with the one-time token signing in gave. The form
 * is a region of its own inside the sign-in form, so it sends with its own button.
 */
function SuspensionAppeal({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useSession();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sent) return <Alert tone="success">{t('settings.appeal.sent')}</Alert>;
  if (!open)
    return (
      <Button variant="secondary" block onClick={() => setOpen(true)}>
        {t('settings.appeal.title')}
      </Button>
    );
  return (
    <section className="stack-sm" aria-label={t('settings.appeal.title')}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        label={t('settings.appeal.why')}
        multiline
        value={statement}
        onChange={(e) => setStatement(e.currentTarget.value)}
        maxLength={2000}
        autoFocus
      />
      <div className="row">
        <Button
          loading={busy}
          disabled={!statement.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.auth.appealSuspension(token, statement.trim());
              setSent(true);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('settings.appeal.send')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </section>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

/** Only same-site paths: "/p/123" yes; "//evil.com", "/\\evil.com" and full URLs no. */
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  try {
    const u = new URL(next, 'https://yapilapi.invalid');
    if (u.origin !== 'https://yapilapi.invalid') return null;
    // Never back to the login or sign-up pages themselves.
    if (/^\/(login|signup)(\/|$)/.test(u.pathname)) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}
