'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, FormField, Input, useUI } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { usePageTitle } from '@/lib/hooks';
import { FormError } from '../forms';

export function ForgotPasswordForm() {
  const { t } = useI18n();
  const { Link } = useUI();
  const api = useApi();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePageTitle(t('forgot.title'), t('app.name'));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="lg" className="auth-card">
      <h1 className="auth-card__title">{t('forgot.title')}</h1>
      {sent ? (
        <div className="stack" role="status">
          <p>{t('forgot.sent')}</p>
          <Link href="/login">{t('forgot.backToLogin')}</Link>
        </div>
      ) : (
        <>
          <p className="auth-card__lead">{t('forgot.lead')}</p>
          <form onSubmit={(e) => void submit(e)} className="stack" noValidate>
            <FormError>{error}</FormError>
            <FormField label={t('field.email')} required requiredLabel={t('common.required')}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                dir="ltr"
              />
            </FormField>
            <Button
              type="submit"
              size="lg"
              fullWidth
              loading={busy}
              loadingLabel={t('common.working')}
              disabled={!email.trim()}
            >
              {t('forgot.submit')}
            </Button>
          </form>
          <p className="auth-card__links">
            <Link href="/login">{t('forgot.backToLogin')}</Link>
          </p>
        </>
      )}
    </Card>
  );
}
