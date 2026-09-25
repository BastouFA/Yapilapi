'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Spinner, useUI } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { usePageTitle } from '@/lib/hooks';

type State =
  | { status: 'pending' }
  | { status: 'ok' }
  | { status: 'error'; message: string }
  | { status: 'missing' };

export function VerifyEmail({ token }: { token: string }) {
  const { t } = useI18n();
  const { Link } = useUI();
  const api = useApi();
  const [state, setState] = useState<State>(token ? { status: 'pending' } : { status: 'missing' });
  const started = useRef(false);
  usePageTitle(t('verify.title'), t('app.name'));

  useEffect(() => {
    if (!token || started.current) return; // tokens are single-use: never submit twice (React strict mode re-runs effects)
    started.current = true;
    api.auth.verifyEmail(token).then(
      () => setState({ status: 'ok' }),
      (e: unknown) => setState({ status: 'error', message: describeError(e, t).message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Card padding="lg" className="auth-card">
      <h1 className="auth-card__title">{t('verify.title')}</h1>
      <div className="stack" aria-live="polite">
        {state.status === 'pending' ? (
          <p>
            <Spinner label={t('verify.checking')} size="sm" /> {t('verify.checking')}
          </p>
        ) : null}
        {state.status === 'ok' ? (
          <>
            <p role="status">{t('verify.success')}</p>
            <Link href="/" className="yl-btn yl-btn--primary yl-btn--lg">
              {t('verify.continue')}
            </Link>
          </>
        ) : null}
        {state.status === 'error' ? (
          <>
            <p role="alert">
              {t('verify.failed')} {state.message}
            </p>
            <p>{t('verify.failedHelp')}</p>
            <Link href="/login">{t('verify.toLogin')}</Link>
          </>
        ) : null}
        {state.status === 'missing' ? (
          <>
            <p>{t('verify.missing')}</p>
            <Link href="/login">{t('verify.toLogin')}</Link>
          </>
        ) : null}
      </div>
    </Card>
  );
}
