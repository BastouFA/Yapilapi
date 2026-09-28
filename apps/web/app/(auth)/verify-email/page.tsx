'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Skeleton } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<{ ok?: boolean; error?: string }>({});
  useEffect(() => {
    // Opened without the link's token (typed by hand, or cut short by a mail app): nothing to confirm.
    if (!token) return setState({ error: 'This link is incomplete. Open the link in the email again, or ask for a new one from Settings.' });
    api.auth.verifyEmail(token).then(
      () => setState({ ok: true }),
      (e) => setState({ error: errorMessage(e) }),
    );
  }, [token]);
  return (
    <div className="stack">
      <h1>Confirm your email</h1>
      {state.ok ? <Alert tone="success">Your email is confirmed.</Alert> : state.error ? <Alert tone="danger">{state.error}</Alert> : <Skeleton height={48} />}
      <Link href="/home" className="yp-btn yp-btn--primary yp-btn--block">
        Go to Home
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
