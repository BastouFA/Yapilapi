'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import type { TogetherInvitePreview } from '@yapilapi/shared';
import { FeatureOff } from '@/components/FeatureOff';
import { api, errorMessage, isGone } from '@/lib/api';
import { useSession } from '../../../../providers';

/**
 * An invite link (or its QR code at the event): what the album is and who hosts it, and a way to
 * ask to join. Nothing in it shows until a host lets you in.
 */
export default function JoinTogether() {
  const { code } = useParams<{ code: string }>();
  const { flags, me, t, tp, toast } = useSession();
  const [invite, setInvite] = useState<TogetherInvitePreview | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api.together.invite(code).then(
      (r) => setInvite(r.invite),
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [code]);
  useEffect(() => {
    if (!flags.REAL_TOGETHER || !me) return;
    load();
  }, [load, flags.REAL_TOGETHER, me]);

  if (!flags.REAL_TOGETHER) return <FeatureOff name="Together" />;
  if (missing)
    return (
      <div className="yp-shell__inner">
        <EmptyState title={t('together.join.missing')} body={t('together.join.missingBody')} />
      </div>
    );
  if (!invite && loadError)
    return (
      <div className="yp-shell__inner">
        <EmptyState title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />
      </div>
    );
  if (!invite)
    return (
      <div className="yp-shell__inner">
        <Skeleton height={200} />
      </div>
    );

  return (
    <div className="yp-shell__inner tg-page">
      <section className="tg-join" aria-labelledby="tg-join-title">
        <span className="tg-cover tg-cover--join" aria-hidden>
          <Icon name="image" size={36} />
        </span>
        <p className="tg-muted">{t('together.join.title')}</p>
        <h1 id="tg-join-title">
          <bdi>{invite.title}</bdi>
        </h1>
        {invite.description ? (
          <p dir="auto" className="tg-join__desc">
            {invite.description}
          </p>
        ) : null}
        <p className="tg-join__host">
          <Avatar name={invite.host.displayName} src={invite.host.avatarUrl} size="sm" />
          {t('together.join.by', { name: invite.host.displayName })}
        </p>
        <p className="tg-muted">
          {tp('together.people', invite.memberCount)} · {tp('together.items', invite.itemCount)}
        </p>
        {invite.state === 'member' ? (
          <Link href={`/together/${invite.id}`} className="yp-btn yp-btn--primary">
            {t('together.join.open')}
          </Link>
        ) : invite.state === 'requested' ? (
          <p className="tg-join__state" role="status">
            {t('together.join.requested')}
          </p>
        ) : invite.state === 'declined' ? (
          <p className="tg-join__state" role="status">
            {t('together.join.declined')}
          </p>
        ) : (
          <>
            <Button
              size="lg"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setInvite((await api.together.requestToJoin(code)).invite);
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('together.join.ask')}
            </Button>
            <p className="tg-muted">{t('together.join.privacy')}</p>
          </>
        )}
      </section>
    </div>
  );
}
