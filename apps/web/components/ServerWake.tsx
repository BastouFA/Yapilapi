'use client';

import { useEffect, useState } from 'react';
import { apiWaking, onApiWaking, setApiWaking } from '@/lib/api';
import { useSession } from '@/app/providers';

/** How often to ask whether the API is up again, and how long "ready" stays on screen. */
const POLL_MS = 3000;
const READY_MS = 4000;

/**
 * While the API is waking up (lib/api.ts noticed it asleep), says so at the top of every page and
 * asks /health/live every few seconds. Once it answers: "ready" for a moment, and the account loads
 * again if it couldn't before, so nobody has to reload.
 */
export function ServerWake() {
  const { t, sessionError, refresh } = useSession();
  const [state, setState] = useState<'waking' | 'ready' | null>(() => (apiWaking() ? 'waking' : null));

  useEffect(() => onApiWaking(() => setState((s) => (apiWaking() ? 'waking' : s))), []);

  useEffect(() => {
    if (state !== 'waking') return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const res = await fetch('/api/health/live', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
          if (stop) return;
          setApiWaking(false);
          setState('ready');
          return;
        }
      } catch {
        // Still asleep: ask again.
      }
      if (!stop) timer = setTimeout(check, POLL_MS);
    };
    timer = setTimeout(check, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [state]);

  useEffect(() => {
    if (state !== 'ready') return;
    if (sessionError) void refresh();
    const timer = setTimeout(() => setState(null), READY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div className="server-wake" role="status" aria-live="polite">
      {state ? (
        <p className={`server-wake__note server-wake__note--${state}`}>
          {state === 'waking' ? <span className="server-wake__dot" aria-hidden="true" /> : null}
          {t(state === 'waking' ? 'wake.waking' : 'wake.ready')}
        </p>
      ) : null}
    </div>
  );
}
