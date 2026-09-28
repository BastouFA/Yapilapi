'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

function ResetForm() {
  const { t } = useSession();
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Opened without the link's token: the form could only fail, so say what to do instead.
  if (!token)
    return (
      <div className="stack">
        <h1>{t('auth.reset.title')}</h1>
        <Alert tone="danger">{t('auth.reset.incomplete')}</Alert>
        <Link href="/forgot-password" className="yp-btn yp-btn--primary yp-btn--block">
          {t('auth.reset.newLink')}
        </Link>
      </div>
    );
  if (done)
    return (
      <div className="stack">
        <h1>{t('st.event.password_changed')}</h1>
        <Alert tone="success">{t('auth.reset.signedOut')}</Alert>
        <Link href="/login" className="yp-btn yp-btn--primary yp-btn--block">
          {t('auth.login.submit')}
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
      <h1>{t('auth.reset.title')}</h1>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        label={t('st.password.new')}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        hint={t('auth.password.hint')}
        required
      />
      <Button type="submit" block loading={busy}>
        {t('st.password.change')}
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
