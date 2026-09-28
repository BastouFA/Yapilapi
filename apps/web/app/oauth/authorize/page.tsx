'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, Skeleton } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

const SCOPE_TEXT: Record<string, MessageKey> = {
  read: 'oauth.scope.read',
  write: 'oauth.scope.write',
};

/** "Sign in with YAPILAPI" consent screen. */
function Consent() {
  const params = useSearchParams();
  const router = useRouter();
  const { me, loading, t } = useSession();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.oauth.consent>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = params.toString();

  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
      return;
    }
    api.oauth.consent(query).then(setInfo, (e) => setError(errorMessage(e)));
  }, [loading, me, query, router]);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      const { redirectTo } = await api.oauth.decide(Object.fromEntries(params.entries()), approve);
      window.location.assign(redirectTo);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <main className="auth" id="main">
      <div className="auth__card">
        {error ? (
          <Alert tone="danger" title={t('oauth.error.title')}>
            {error}
          </Alert>
        ) : !info ? (
          <Skeleton height={200} />
        ) : (
          <div className="stack">
            <h1 style={{ fontSize: 24, lineHeight: '30px' }}>{t('oauth.title', { app: info.app.name })}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {info.app.website
                ? t('oauth.madeByWithSite', { owner: info.app.ownerName, site: new URL(info.app.website).host, username: me?.username ?? '' })
                : t('oauth.madeBy', { owner: info.app.ownerName, username: me?.username ?? '' })}
            </p>
            <ul className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
              {info.scopes.map((s) => (
                <li key={s}>{SCOPE_TEXT[s] ? t(SCOPE_TEXT[s]) : s}</li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('oauth.never')}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('oauth.redirect')
                .split('{host}')
                .flatMap((part, i) => (i ? [<strong key={i}>{new URL(info.redirectUri).host}</strong>, part] : [part]))}
            </p>
            <div className="row">
              <Button onClick={() => decide(true)} loading={busy}>
                {t('oauth.allow')}
              </Button>
              <Button variant="secondary" onClick={() => decide(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense>
      <Consent />
    </Suspense>
  );
}
