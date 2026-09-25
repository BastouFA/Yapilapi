'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, Skeleton } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../../providers';

const SCOPE_TEXT: Record<string, string> = {
  read: 'See your profile, feed, posts, communities and events',
  write: 'Post, comment, react and RSVP on your behalf',
};

/** "Sign in with YAPILAPI" consent screen. */
function Consent() {
  const params = useSearchParams();
  const router = useRouter();
  const { me, loading } = useSession();
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
          <Alert tone="danger" title="This sign-in request can't be completed">
            {error}
          </Alert>
        ) : !info ? (
          <Skeleton height={200} />
        ) : (
          <div className="stack">
            <h1 style={{ fontSize: 24, lineHeight: '30px' }}>{info.app.name} wants to connect to your YAPILAPI account</h1>
            <p className="muted" style={{ margin: 0 }}>
              Made by {info.app.ownerName}
              {info.app.website ? ` · ${new URL(info.app.website).host}` : ''}. Signed in as @{me?.username}.
            </p>
            <ul className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
              {info.scopes.map((s) => (
                <li key={s}>{SCOPE_TEXT[s] ?? s}</li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              It will never see your password, messages you haven't shared, or your security settings. You can disconnect it any time in Settings.
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              You'll be sent to <strong>{new URL(info.redirectUri).host}</strong>.
            </p>
            <div className="row">
              <Button onClick={() => decide(true)} loading={busy}>
                Allow
              </Button>
              <Button variant="secondary" onClick={() => decide(false)} disabled={busy}>
                Cancel
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
