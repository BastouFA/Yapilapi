'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import type { Me } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

function LoginForm() {
  const { setMe, t } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);

  function done(user: Me) {
    setMe(user);
    router.replace(!user.onboarded ? '/onboarding' : next?.startsWith('/') ? next : '/home');
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        done((await api.mfa.verify(challenge, String(f.get('code')).trim())).user);
        return;
      }
      const r = await api.auth.login({ email: String(f.get('email')), password: String(f.get('password')) });
      if (r.mfaRequired && r.challengeToken) setChallenge(r.challengeToken);
      else if (r.user) done(r.user);
    } catch (err) {
      setError(errorMessage(err));
      if (challenge && /expired|Sign in again/.test(errorMessage(err))) setChallenge(null);
    } finally {
      setBusy(false);
    }
  }

  if (challenge)
    return (
      <form className="stack" onSubmit={submit} noValidate>
        <h1>Two-step verification</h1>
        <p className="muted" style={{ margin: 0 }}>
          Enter the 6-digit code from your authenticator app, or one of your recovery codes.
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField label="Code" name="code" autoComplete="one-time-code" inputMode="text" autoFocus required maxLength={12} />
        <Button type="submit" block loading={busy}>
          Verify
        </Button>
        <Button variant="ghost" onClick={() => (setChallenge(null), setError(null))}>
          Use a different account
        </Button>
      </form>
    );

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <h1>{t('auth.login.title')}</h1>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required />
      <TextField label={t('auth.password')} name="password" type="password" autoComplete="current-password" required />
      <Button type="submit" block loading={busy}>
        {t('auth.login.submit')}
      </Button>
      <div className="auth__foot row" style={{ justifyContent: 'space-between' }}>
        <Link href="/forgot-password">{t('auth.forgot')}</Link>
        <span>
          {t('auth.noAccount')} <Link href="/signup">{t('auth.signup.submit')}</Link>
        </span>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
