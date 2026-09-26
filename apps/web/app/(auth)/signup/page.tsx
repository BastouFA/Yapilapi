'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '../../providers';

function SignupForm() {
  const { setMe, t } = useSession();
  const router = useRouter();
  // From an invite link (/join/<code>): the code comes along, and we show who invited you.
  const invite = useSearchParams().get('invite') ?? '';
  const [invitedBy, setInvitedBy] = useState<string | null>(null);
  useEffect(() => {
    if (invite)
      api.invites.preview(invite).then(
        (r) => setInvitedBy(r.inviter.displayName),
        () => setInvitedBy(null),
      );
  }, [invite]);
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
        inviteCode: String(f.get('inviteCode') ?? '').trim() || undefined,
        website: String(f.get('website') ?? '') || undefined,
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
      {invitedBy ? <p style={{ margin: 0 }}>{t('auth.invitedBy', { name: invitedBy })}</p> : null}
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
      <TextField
        label={t('auth.inviteCode')}
        name="inviteCode"
        defaultValue={invite}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={32}
        error={fields.inviteCode}
      />
      {/* Left empty by people (it's hidden from view and from screen readers); forms that fill it in are refused. */}
      <div className="hp-field" aria-hidden="true">
        <label htmlFor="signup-website">Website</label>
        <input id="signup-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <Button type="submit" block loading={busy}>
        {t('auth.signup.submit')}
      </Button>
      <p className="auth__foot">
        {t('auth.haveAccount')} <Link href="/login">{t('auth.login.submit')}</Link>
      </p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
