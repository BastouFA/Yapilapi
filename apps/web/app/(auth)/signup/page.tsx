'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { authHref, startAs } from '@/lib/accounts';
import { SignupConsent } from '@/components/Legal';
import { PasswordField } from '@/components/PasswordField';
import { useSession } from '../../providers';

function SignupForm() {
  const { me, setMe, locale, t } = useSession();
  const router = useRouter();
  // From an invite link (/join/<code>): the code comes along, and we show who invited you.
  const params = useSearchParams();
  const invite = params.get('invite') ?? '';
  // Passed along to Log in, so moving between the two keeps where you were going (Log in checks it).
  const next = params.get('next');
  // Add account (from the login page in add-account mode): the accounts already signed in here stay.
  const adding = params.get('add') === '1';
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
    setError(null);
    // Everyone gives a date of birth (the server decides what it means, including who can join).
    const birthDate = String(f.get('birthDate') || '');
    if (!birthDate) return setFields({ birthDate: t('auth.birthDate.required') });
    setBusy(true);
    setFields({});
    try {
      const { user } = await api.auth.register({
        email: String(f.get('email')),
        password: String(f.get('password')),
        username: String(f.get('username')),
        displayName: String(f.get('displayName')),
        birthDate,
        // The language this page is in (the browser's, or the one picked here) becomes the account's.
        locale,
        inviteCode: String(f.get('inviteCode') ?? '').trim() || undefined,
        website: String(f.get('website') ?? '') || undefined,
        ...(adding ? { addAccount: true } : {}),
      });
      // Another account was in use: the page starts again as the new one.
      if (adding && me) return void startAs('/onboarding');
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
        error={fields.username ?? (usernameState === 'taken' ? t('m.auth.usernameTaken') : undefined)}
        hint={usernameState === 'ok' ? t('auth.usernameAvailable') : t('m.auth.usernameRule')}
      />
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required error={fields.email} />
      <PasswordField
        label={t('auth.password')}
        name="password"
        autoComplete="new-password"
        required
        minLength={10}
        hint={t('auth.password.hint')}
        error={fields.password}
      />
      <TextField
        label={t('auth.birthDate')}
        name="birthDate"
        type="date"
        required
        autoComplete="bday"
        max={new Date().toISOString().slice(0, 10)}
        hint={t('auth.birthDate.hint')}
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
      <SignupConsent />
      <Button type="submit" block loading={busy}>
        {t('auth.signup.submit')}
      </Button>
      <p className="auth__foot" style={{ textAlign: 'center' }}>
        {t('auth.haveAccount')} <Link href={authHref('/login', next, adding)}>{t('auth.login.submit')}</Link>
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
