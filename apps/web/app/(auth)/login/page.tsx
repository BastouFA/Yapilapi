'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

function LoginForm() {
  const { setMe, t } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.auth.login({ email: String(f.get('email')), password: String(f.get('password')) });
      setMe(user);
      router.replace(!user.onboarded ? '/onboarding' : next?.startsWith('/') ? next : '/home');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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
