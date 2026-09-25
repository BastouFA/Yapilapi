'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, FormField, PasswordInput, useUI } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { usePageTitle } from '@/lib/hooks';
import { FormError } from '../forms';

export function ResetPasswordForm({ token }: { token: string }) {
  const { t } = useI18n();
  const { Link } = useUI();
  const api = useApi();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ password?: string; confirm?: string }>({});
  usePageTitle(t('reset.title'), t('app.name'));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldError = {};
    if (password.length < 10) fe.password = t('password.tooShort');
    if (confirm !== password) fe.confirm = t('password.mismatch');
    setFieldError(fe);
    if (fe.password || fe.confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Card padding="lg" className="auth-card">
        <h1 className="auth-card__title">{t('reset.title')}</h1>
        <p role="alert">{t('reset.noToken')}</p>
        <Link href="/forgot-password">{t('reset.requestNew')}</Link>
      </Card>
    );
  }
  return (
    <Card padding="lg" className="auth-card">
      <h1 className="auth-card__title">{t('reset.title')}</h1>
      {done ? (
        <div className="stack" role="status">
          <p>{t('reset.done')}</p>
          <Link href="/login" className="yl-btn yl-btn--primary yl-btn--lg">
            {t('reset.signIn')}
          </Link>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="stack" noValidate>
          <FormError>{error}</FormError>
          <FormField
            label={t('field.newPassword')}
            description={t('password.rules')}
            error={fieldError.password}
            required
            requiredLabel={t('common.required')}
          >
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              showLabel={t('field.showPassword')}
              hideLabel={t('field.hidePassword')}
            />
          </FormField>
          <FormField
            label={t('field.confirmPassword')}
            error={fieldError.confirm}
            required
            requiredLabel={t('common.required')}
          >
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              showLabel={t('field.showPassword')}
              hideLabel={t('field.hidePassword')}
            />
          </FormField>
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={busy}
            loadingLabel={t('common.working')}
          >
            {t('reset.submit')}
          </Button>
        </form>
      )}
    </Card>
  );
}
