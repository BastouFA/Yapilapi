'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          setSent((await api.auth.forgot(String(new FormData(e.currentTarget).get('email')))).message);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>Reset your password</h1>
      {sent ? <Alert tone="success">{sent}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label="Email address" name="email" type="email" autoComplete="email" required />
      <Button type="submit" block loading={busy}>
        Send reset link
      </Button>
      <p className="auth__foot">
        <Link href="/login">Back to log in</Link>
      </p>
    </form>
  );
}
