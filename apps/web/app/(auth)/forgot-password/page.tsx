'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

export default function ForgotPasswordPage() {
  const { t } = useSession();
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
          const email = String(new FormData(e.currentTarget).get('email')).trim();
          await api.auth.forgot(email);
          // The same answer whether or not the address has an account, in the reader's language.
          setSent(t('m.auth.reset.sent', { email }));
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{t('m.auth.reset.title')}</h1>
      {sent ? <Alert tone="success">{sent}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required />
      <Button type="submit" block loading={busy}>
        {t('m.auth.reset.submit')}
      </Button>
      <p className="auth__foot">
        <Link href="/login">{t('m.auth.reset.back')}</Link>
      </p>
    </form>
  );
}
