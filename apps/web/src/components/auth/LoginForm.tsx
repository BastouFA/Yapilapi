'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, FormField, Input, PasswordInput, useUI } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { usePageTitle } from '@/lib/hooks';
import { FormError } from '../forms';

export function LoginForm({ next }: { next: string }) {
  const { t } = useI18n();
  const { Link } = useUI();
  const api = useApi();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  usePageTitle(challenge ? t('login.mfaTitle') : t('login.title'), t('app.name'));

  useEffect(() => {
    if (challenge) headingRef.current?.focus();
  }, [challenge]);

  const done = () => {
    router.replace(next);
    router.refresh();
  };

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.login({ email: email.trim(), password });
      if (r.mfaRequired) setChallenge(r.challengeToken);
      else done();
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.mfaVerify(
        useRecovery
          ? { challengeToken: challenge, recoveryCode: code.trim() }
          : { challengeToken: challenge, code: code.trim() },
      );
      done();
    } catch (err) {
      const d = describeError(err, t);
      setError(d.message);
      // An expired/used challenge cannot be retried: restart the sign-in.
      if (d.unauthenticated && /expired/i.test(String((err as Error).message))) {
        setChallenge(null);
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <Card padding="lg" className="auth-card">
        <h1 ref={headingRef} tabIndex={-1} className="auth-card__title">
          {t('login.mfaTitle')}
        </h1>
        <p className="auth-card__lead">
          {useRecovery ? t('login.mfaRecoveryLead') : t('login.mfaLead')}
        </p>
        <form onSubmit={(e) => void submitMfa(e)} className="stack" noValidate>
          <FormError>{error}</FormError>
          <FormField
            label={useRecovery ? t('login.recoveryCode') : t('login.code')}
            description={useRecovery ? t('login.recoveryHelp') : t('login.codeHelp')}
            required
            requiredLabel={t('common.required')}
          >
            {useRecovery ? (
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                data-testid="recovery-input"
              />
            ) : (
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                dir="ltr"
                data-testid="mfa-code"
              />
            )}
          </FormField>
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={busy}
            loadingLabel={t('common.working')}
            disabled={!code.trim()}
          >
            {t('login.verify')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setUseRecovery((r) => !r);
              setCode('');
              setError(null);
            }}
          >
            {useRecovery ? t('login.useAuthenticator') : t('login.useRecovery')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setChallenge(null);
              setCode('');
              setError(null);
            }}
          >
            {t('common.back')}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card padding="lg" className="auth-card">
      <h1 className="auth-card__title">{t('login.title')}</h1>
      <p className="auth-card__lead">{t('login.lead')}</p>
      <form onSubmit={(e) => void submitCredentials(e)} className="stack" noValidate>
        <FormError>{error}</FormError>
        <FormField label={t('field.email')} required requiredLabel={t('common.required')}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            dir="ltr"
            data-testid="login-email"
          />
        </FormField>
        <FormField label={t('field.password')} required requiredLabel={t('common.required')}>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            showLabel={t('field.showPassword')}
            hideLabel={t('field.hidePassword')}
            data-testid="login-password"
          />
        </FormField>
        <Button
          type="submit"
          size="lg"
          fullWidth
          loading={busy}
          loadingLabel={t('common.working')}
          disabled={!email.trim() || !password}
          data-testid="login-submit"
        >
          {t('login.submit')}
        </Button>
      </form>
      <p className="auth-card__links">
        <Link href="/forgot-password">{t('login.forgot')}</Link>
        <span aria-hidden="true">·</span>
        <span>
          {t('login.noAccount')} <Link href="/signup">{t('login.signup')}</Link>
        </span>
      </p>
    </Card>
  );
}
