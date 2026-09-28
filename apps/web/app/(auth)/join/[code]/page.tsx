'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, PlusBadge, Skeleton } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, ApiError, errorMessage, isGone } from '@/lib/api';
import { useSession } from '../../../providers';

/** An invite link: shows who invited you and carries their code into sign up. */
export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const { t, me } = useSession();
  const [inviter, setInviter] = useState<PublicUser | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Why it couldn't load, when that isn't because the code is wrong.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api.invites.preview(code).then(
      (r) => setInviter(r.inviter),
      (e) => (isGone(e) || (e instanceof ApiError && e.status === 400) ? setInvalid(true) : setLoadError(errorMessage(e))),
    );
  }, [code]);
  useEffect(() => {
    load();
  }, [load]);

  if (invalid)
    return (
      <div className="stack">
        <h1>{t('join.invalid.title')}</h1>
        <p style={{ margin: 0 }}>{t('join.invalid.body')}</p>
        <Link href="/signup" className="yp-btn yp-btn--primary yp-btn--block">
          {t('join.withoutCode')}
        </Link>
        <p className="auth__foot">
          {t('auth.haveAccount')} <Link href="/login">{t('auth.login.submit')}</Link>
        </p>
      </div>
    );

  if (!inviter && loadError) return <EmptyState title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!inviter) return <Skeleton height={200} />;

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Avatar name={inviter.displayName} src={inviter.avatarUrl} size="lg" />
        <div className="stack-sm" style={{ gap: 2 }}>
          <strong>
            {inviter.displayName}
            {inviter.plus ? <PlusBadge label={t('plus.badge.label')} /> : null}
          </strong>
          <span className="muted">@{inviter.username}</span>
        </div>
      </div>
      <h1>{t('join.title', { name: inviter.displayName })}</h1>
      <p style={{ margin: 0 }}>{t('join.body')}</p>
      {me ? (
        <Link href={`/u/${inviter.username}`} className="yp-btn yp-btn--primary yp-btn--block">
          @{inviter.username}
        </Link>
      ) : (
        <>
          <Link href={`/signup?invite=${encodeURIComponent(code)}`} className="yp-btn yp-btn--primary yp-btn--block">
            {t('join.cta')}
          </Link>
          <p className="auth__foot">
            {t('auth.haveAccount')} <Link href="/login">{t('auth.login.submit')}</Link>
          </p>
        </>
      )}
    </div>
  );
}
