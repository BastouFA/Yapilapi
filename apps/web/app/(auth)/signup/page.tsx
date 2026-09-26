'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '../../providers';

export default function SignupPage() {
  const { setMe, t } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [usernameState, setUsernameState] = useState<'idle' | 'ok' | 'taken'>('idle');

  async function checkUsername(v: string) {
    if (v.length < 3) return setUsernameState('idle');
    try {
      setUsernameState((await api.auth.checkUsername(v)).available ? 'ok' : 'taken');
    } catch {
      setUsernameState('idle');
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const { user } = await api.auth.register({
        email: String(f.get('email')),
        password: String(f.get('password')),
        username: String(f.get('username')),
        displayName: String(f.get('displayName')),
        birthDate: String(f.get('birthDate') || '') || undefined,
        locale: navigator.language,
      });
      setMe(user);
      router.replace('/onboarding');
    } catch (err) {
      setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <h1>{t('auth.signup.title')}</h1>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('auth.displayName')} name="displayName" autoComplete="name" required maxLength={60} error={fields.displayName} />
      <TextField
        label={t('auth.username')}
        name="username"
        autoComplete="username"
        required
        minLength={3}
        maxLength={30}
        pattern="[A-Za-z0-9_.]+"
        onBlur={(e) => checkUsername(e.currentTarget.value)}
        error={fields.username ?? (usernameState === 'taken' ? 'That username is taken.' : undefined)}
        hint={usernameState === 'ok' ? 'Available.' : 'Letters, numbers, dots and underscores.'}
      />
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required error={fields.email} />
      <TextField
        label={t('auth.password')}
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        hint={t('auth.password.hint')}
        error={fields.password}
      />
      <TextField
        label="Date of birth"
        name="birthDate"
        type="date"
        hint="Used to keep younger people safe. Never shown on your profile."
        error={fields.birthDate}
      />
      <Button type="submit" block loading={busy}>
        {t('auth.signup.submit')}
      </Button>
      <p className="auth__foot">
        {t('auth.haveAccount')} <Link href="/login">{t('auth.login.submit')}</Link>
      </p>
    </form>
  );
}
