'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, TextField } from '@yapilapi/design-system';
import { LegalLinks } from '@/components/Legal';
import { api, ApiError, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Accounts made before a date of birth was required give it once, here, on their next visit.
 * 13 to 17: the protections for minors apply from now on. Under 13: the API closes the account
 * and signs it out everywhere, and this screen says so.
 */
export function BirthDateGate() {
  const { setMe, t } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const birthDate = String(new FormData(e.currentTarget).get('birthDate') || '');
    setError(null);
    if (!birthDate) return setFields({ birthDate: t('auth.birthDate.required') });
    setFields({});
    setBusy(true);
    try {
      const { user } = await api.auth.setBirthDate(birthDate);
      setMe(user);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'under_minimum_age') setClosed(true);
      else {
        setError(errorMessage(err));
        setFields(fieldErrors(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth" id="main">
      <div className="auth__card">
        <span className="auth__brand">
          <img src="/mark.svg" alt="" width={28} height={28} />
          YAPILAPI
        </span>
        {closed ? (
          <div className="stack">
            <h1>{t('birthDate.closedTitle')}</h1>
            <p>{t('birthDate.closedBody')}</p>
            <Link
              href="/"
              className="yp-btn"
              onClick={() => {
                setMe(null);
              }}
            >
              {t('birthDate.home')}
            </Link>
          </div>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <h1>{t('birthDate.title')}</h1>
            <p>{t('birthDate.body')}</p>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <TextField
              label={t('auth.birthDate')}
              name="birthDate"
              type="date"
              required
              autoComplete="bday"
              max={new Date().toISOString().slice(0, 10)}
              error={fields.birthDate}
            />
            <Button type="submit" block loading={busy}>
              {t('birthDate.save')}
            </Button>
          </form>
        )}
        <LegalLinks className="site-legal" />
      </div>
    </main>
  );
}
