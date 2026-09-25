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
    api.auth.verifyEmail(token).then(() => setState({ ok: true }), (e) => setState({ error: errorMessage(e) }));
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
