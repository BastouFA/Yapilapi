'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (done)
    return (
      <div className="stack">
        <h1>Password changed</h1>
        <Alert tone="success">You were signed out everywhere else. Log in with your new password.</Alert>
        <Link href="/login" className="yp-btn yp-btn--primary yp-btn--block">
          Log in
        </Link>
      </div>
    );
  return (
    <form
      className="stack"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.auth.reset(token, String(new FormData(e.currentTarget).get('password')));
          setDone(true);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>Choose a new password</h1>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label="New password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." required />
      <Button type="submit" block loading={busy}>
        Change password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
