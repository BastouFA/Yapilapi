'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, TextField } from '@yapilapi/design-system';
import type { VerificationStatus } from '@yapilapi/api-client';
import type { MessageKey } from '@yapilapi/shared';
import { api, ApiError, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

/** True for the API's "confirm your email or phone first" refusal. */
export const isVerificationError = (e: unknown) => e instanceof ApiError && e.code === 'verification_required';

const WHY = {
  post: 'm.verify.prompt.post',
  message: 'm.verify.prompt.message',
  live: 'verification.prompt.live',
} as const satisfies Record<string, MessageKey>;

/** A calm prompt with a way to confirm, shown before or after the API asks for it. */
export function VerifyPrompt({ action }: { action: keyof typeof WHY }) {
  const { t, locale } = useSession();
  return (
    <Alert tone="info" title={t('m.verify.prompt.title')} locale={locale}>
      <p style={{ margin: '0 0 8px' }}>{t(WHY[action])}</p>
      <Link href="/settings/account#verification" className="yp-btn yp-btn--secondary yp-btn--sm">
        {t('m.verify.prompt.action')}
      </Link>
    </Alert>
  );
}

/**
 * Email and phone confirmation in Settings. A confirmed email or phone number
 * unlocks posting publicly, messaging people who aren't friends and going live.
 */
export function VerificationCard() {
  const { refresh, toast, t } = useSession();
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    api.verification.status().then(
      (s) => {
        setStatus(s);
        if (s.phone && !s.phone.verified) setPhone(s.phone.number);
      },
      (e) => setErr(errorMessage(e)),
    );
  }, []);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setErr(null);
    setFields({});
    try {
      return await fn();
    } catch (e) {
      setErr(errorMessage(e));
      setFields(fieldErrors(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  if (!status) return err ? <Alert tone="danger">{err}</Alert> : null;
  const phoneVerified = !!status.phone?.verified;

  return (
    <Card title={t('m.verify.title')} subtitle={status.verified ? t('m.verify.done') : status.required ? t('m.verify.required') : t('m.verify.optional')}>
      <div className="stack-sm" id="verification">
        {err ? <Alert tone="danger">{err}</Alert> : null}
        <div className="verify-row">
          <div>
            <strong>{t('m.verify.email')}</strong>
            <p className="muted" style={{ margin: 0 }}>
              {status.email.address} · {status.email.verified ? t('m.verify.confirmed') : t('m.verify.notConfirmed')}
            </p>
          </div>
          {!status.email.verified ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => run(async () => (await api.auth.resendVerification(), toast(t('m.verify.emailSent'))))}
            >
              {t('m.verify.resendEmail')}
            </Button>
          ) : null}
        </div>

        <div className="verify-row">
          <div>
            <strong>{t('m.verify.phone')}</strong>
            <p className="muted" style={{ margin: 0 }}>
              {status.phone ? `${status.phone.number} · ${phoneVerified ? t('m.verify.confirmed') : t('m.verify.notConfirmed')}` : t('m.verify.noPhone')}
            </p>
          </div>
          {status.phone ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              onClick={() =>
                run(async () => {
                  setStatus(await api.verification.removePhone());
                  setPhone('');
                  setStep('idle');
                  await refresh();
                  toast(t('verification.phoneRemoved'));
                })
              }
            >
              {t('m.common.remove')}
            </Button>
          ) : null}
        </div>

        {!phoneVerified && step === 'idle' ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setStatus(await api.verification.setPhone(phone));
                await api.verification.sendCode();
                setStep('code');
                setCode('');
              });
            }}
          >
            <TextField
              label={t('m.verify.phoneLabel')}
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
              hint={t('m.verify.phoneHint')}
              error={fields.phone}
              required
            />
            <Button type="submit" size="sm" loading={busy} disabled={phone.trim().length < 6}>
              {t('m.verify.sendCode')}
            </Button>
          </form>
        ) : null}

        {!phoneVerified && step === 'code' ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setStatus(await api.verification.verifyPhone(code.trim()));
                setStep('idle');
                await refresh();
                toast(t('verification.phoneConfirmed'));
              });
            }}
          >
            <p style={{ margin: 0 }}>{t('m.verify.codeSent', { phone: status.phone?.number ?? '' })}</p>
            <TextField
              label={t('m.verify.codeLabel')}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))}
              error={fields.code}
              required
            />
            <div className="row">
              <Button type="submit" size="sm" loading={busy} disabled={code.length < 4}>
                {t('m.verify.confirm')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => run(async () => (await api.verification.sendCode(), toast(t('verification.newCodeSent'))))}
              >
                {t('m.verify.newCode')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep('idle')}>
                {t('m.verify.changeNumber')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
