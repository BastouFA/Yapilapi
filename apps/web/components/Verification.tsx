'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, TextField } from '@yapilapi/design-system';
import type { VerificationStatus } from '@yapilapi/api-client';
import { api, ApiError, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

/** True for the API's "confirm your email or phone first" refusal. */
export const isVerificationError = (e: unknown) => e instanceof ApiError && e.code === 'verification_required';

const WHY = {
  post: 'To post for everyone, confirm your email address or a phone number first. Posts for friends or only you work now.',
  message: 'To message people you aren’t friends with yet, confirm your email address or a phone number first.',
  live: 'To go live, confirm your email address or a phone number first.',
} as const;

/** A calm prompt with a way to confirm, shown before or after the API asks for it. */
export function VerifyPrompt({ action }: { action: keyof typeof WHY }) {
  return (
    <Alert tone="info" title="Confirm your account">
      <p style={{ margin: '0 0 8px' }}>{WHY[action]}</p>
      <Link href="/settings#verification" className="yp-btn yp-btn--secondary yp-btn--sm">
        Confirm email or phone
      </Link>
    </Alert>
  );
}

/**
 * Email and phone confirmation in Settings. A confirmed email or phone number
 * unlocks posting publicly, messaging people who aren't friends and going live.
 */
export function VerificationCard() {
  const { refresh, toast } = useSession();
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
    <Card
      title="Email and phone"
      subtitle={
        status.verified
          ? 'Your account is confirmed.'
          : status.required
            ? 'Confirm your email address or a phone number to post publicly, message people you aren’t friends with yet, and go live.'
            : 'Confirming your email or a phone number helps keep your account and YAPILAPI safe.'
      }
    >
      <div className="stack-sm" id="verification">
        {err ? <Alert tone="danger">{err}</Alert> : null}
        <div className="verify-row">
          <div>
            <strong>Email</strong>
            <p className="muted" style={{ margin: 0 }}>
              {status.email.address} · {status.email.verified ? 'Confirmed' : 'Not confirmed yet'}
            </p>
          </div>
          {!status.email.verified ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => run(async () => (await api.auth.resendVerification(), toast('We sent a new link. Check your inbox.')))}
            >
              Send the link again
            </Button>
          ) : null}
        </div>

        <div className="verify-row">
          <div>
            <strong>Phone</strong>
            <p className="muted" style={{ margin: 0 }}>
              {status.phone ? `${status.phone.number} · ${phoneVerified ? 'Confirmed' : 'Not confirmed yet'}` : 'No phone number added.'}
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
                  toast('Phone number removed');
                })
              }
            >
              Remove
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
              label="Phone number"
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
              hint="Include the country code, for example +44 7700 900123. We only use it to confirm your account and keep it safe."
              error={fields.phone}
              required
            />
            <Button type="submit" size="sm" loading={busy} disabled={phone.trim().length < 6}>
              Text me a code
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
                toast('Phone number confirmed');
              });
            }}
          >
            <p style={{ margin: 0 }}>We texted a 6-digit code to {status.phone?.number}. It works for 10 minutes.</p>
            <TextField
              label="Code"
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
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => run(async () => (await api.verification.sendCode(), toast('We sent a new code')))}
              >
                Send a new code
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep('idle')}>
                Change number
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
