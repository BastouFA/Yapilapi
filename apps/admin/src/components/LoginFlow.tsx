'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, FormField, Input, Logo, PasswordInput } from '@yapilapi/ui';
import type { MfaSetup } from '@yapilapi/api-client';
import { useT } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { usePageTitle } from '@/lib/hooks';
import { ErrorNotice } from './common';
import { LocaleSwitch } from './LocaleSwitch';
import { QrCode } from './QrCode';

type Step =
  | { kind: 'credentials' }
  | { kind: 'mfa'; challenge: string }
  | { kind: 'enroll'; setup: MfaSetup }
  | { kind: 'recovery'; codes: string[] };

/**
 * Staff sign-in: password, then a mandatory second factor. Staff whose account has no authenticator yet must enrol one before
 * they get in (the API refuses every staff endpoint for a session that has not passed MFA), and everyone else's account is
 * refused here with a clear message.
 */
export function LoginFlow({ next, reason }: { next: string; reason?: string | undefined }) {
  const t = useT();
  const api = useApi();
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const title =
    step.kind === 'mfa'
      ? t('login.mfaTitle')
      : step.kind === 'enroll'
        ? t('login.enrollTitle')
        : step.kind === 'recovery'
          ? t('login.recoveryTitle')
          : t('login.title');
  usePageTitle(title, t('app.name'));

  useEffect(() => {
    if (step.kind !== 'credentials') headingRef.current?.focus();
  }, [step.kind]);

  const finish = async () => {
    // The definitive check: the API answers /v1/admin/me only for a staff account on an MFA-verified session.
    await api.admin.me({ skipUnauthorizedHook: true });
    router.replace(next);
    router.refresh();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.auth.login({
        email: email.trim(),
        password,
        deviceLabel: 'Staff console',
      });
      if (r.mfaRequired) {
        setCode('');
        setStep({ kind: 'mfa', challenge: r.challengeToken });
        return;
      }
      if (r.user.platformRole === 'user') {
        // Not a staff account: do not leave a session behind.
        try {
          await api.auth.logout();
        } catch {
          /* ignore */
        }
        setNotice(t('login.notStaff'));
        setPassword('');
        return;
      }
      // Staff without an authenticator: enrol one now. Enabling it also marks this session as MFA-verified.
      setCode('');
      setStep({ kind: 'enroll', setup: await api.auth.mfaSetup() });
    });
  };

  const submitMfa = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'mfa') return;
    const challenge = step.challenge;
    void run(async () => {
      try {
        await api.auth.mfaVerify(
          useRecovery
            ? { challengeToken: challenge, recoveryCode: code.trim() }
            : { challengeToken: challenge, code: code.trim() },
        );
      } catch (err) {
        // The challenge is single-use and short lived: an expired one means starting over.
        if (describeError(err, t).status === 401 && /expired/i.test((err as Error).message)) {
          setStep({ kind: 'credentials' });
          setNotice(t('login.challengeExpired'));
          setCode('');
          return;
        }
        throw err;
      }
      try {
        await finish();
      } catch (err) {
        setNotice(describeError(err, t).status === 403 ? t('login.notStaff') : null);
        throw err;
      }
    });
  };

  const submitEnroll = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.auth.mfaEnable(code.trim());
      setCode('');
      setStep({ kind: 'recovery', codes: r.recoveryCodes });
    });
  };

  const reasonNote =
    reason === 'mfa'
      ? t('login.reasonMfa')
      : reason === 'expired'
        ? t('login.reasonExpired')
        : null;

  return (
    <main id="main" className="auth-page">
      <Card padding="lg" className="auth-card">
        <div className="auth-card__brand row row--between">
          <Logo name={t('app.name')} size={32} />
          <LocaleSwitch />
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="auth-card__title">
          {title}
        </h1>
        {step.kind === 'credentials' ? (
          <>
            <p className="auth-card__lead">{t('login.lead')}</p>
            {reasonNote ? (
              <p className="yl-notice yl-notice--info" role="status">
                {reasonNote}
              </p>
            ) : null}
            {notice ? (
              <p className="yl-notice yl-notice--danger" role="alert">
                {notice}
              </p>
            ) : null}
            <form onSubmit={submitCredentials} className="stack" noValidate>
              <FormField label={t('login.email')} required requiredLabel={t('common.required')}>
                <Input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </FormField>
              <FormField label={t('login.password')} required requiredLabel={t('common.required')}>
                <PasswordInput
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  showLabel={t('login.showPassword')}
                  hideLabel={t('login.hidePassword')}
                />
              </FormField>
              {error ? <ErrorNotice error={error} /> : null}
              <Button
                type="submit"
                fullWidth
                loading={busy}
                loadingLabel={t('common.working')}
                disabled={!email.trim() || !password}
              >
                {t('login.submit')}
              </Button>
            </form>
          </>
        ) : null}

        {step.kind === 'mfa' ? (
          <>
            <p className="auth-card__lead">
              {useRecovery ? t('login.mfaRecoveryLead') : t('login.mfaLead')}
            </p>
            {notice ? (
              <p className="yl-notice yl-notice--danger" role="alert">
                {notice}
              </p>
            ) : null}
            <form onSubmit={submitMfa} className="stack" noValidate>
              <FormField
                label={useRecovery ? t('login.recoveryCode') : t('login.code')}
                required
                requiredLabel={t('common.required')}
              >
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoCapitalize="none"
                  spellCheck={false}
                  {...(useRecovery ? {} : { maxLength: 6, pattern: '[0-9]*' })}
                />
              </FormField>
              {error ? <ErrorNotice error={error} /> : null}
              <Button
                type="submit"
                fullWidth
                loading={busy}
                loadingLabel={t('common.working')}
                disabled={!code.trim()}
              >
                {t('login.verify')}
              </Button>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setUseRecovery((u) => !u);
                  setCode('');
                  setError(undefined);
                }}
              >
                {useRecovery ? t('login.useAuthenticator') : t('login.useRecovery')}
              </button>
            </form>
          </>
        ) : null}

        {step.kind === 'enroll' ? (
          <>
            <p className="auth-card__lead">{t('login.enrollLead')}</p>
            <div className="qr-wrap">
              <QrCode value={step.setup.otpauthUri} label={t('login.qrLabel')} />
            </div>
            <p className="muted">{t('login.enrollSecret')}</p>
            <code className="secret" data-testid="mfa-secret">
              {step.setup.secret}
            </code>
            <form onSubmit={submitEnroll} className="stack" noValidate>
              <FormField label={t('login.code')} required requiredLabel={t('common.required')}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  pattern="[0-9]*"
                />
              </FormField>
              {error ? <ErrorNotice error={error} /> : null}
              <Button
                type="submit"
                fullWidth
                loading={busy}
                loadingLabel={t('common.working')}
                disabled={code.trim().length < 6}
              >
                {t('login.enable')}
              </Button>
            </form>
          </>
        ) : null}

        {step.kind === 'recovery' ? (
          <>
            <p className="auth-card__lead">{t('login.recoveryLead')}</p>
            <ul className="recovery-codes" aria-label={t('login.recoveryCodes')}>
              {step.codes.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
            {error ? <ErrorNotice error={error} /> : null}
            <Button
              fullWidth
              loading={busy}
              loadingLabel={t('common.working')}
              onClick={() => void run(finish)}
            >
              {t('login.continue')}
            </Button>
          </>
        ) : null}
      </Card>
    </main>
  );
}
