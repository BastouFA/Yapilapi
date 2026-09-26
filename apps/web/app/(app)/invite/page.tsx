'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Card, EmptyState, List, ListItem, PlusBadge, Skeleton, TextField } from '@yapilapi/design-system';
import { formatRelativeTime } from '@yapilapi/shared';
import type { InvitesInfo } from '@yapilapi/api-client';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

/**
 * Invite friends: your link to copy or share, who joined with it, and how
 * close you are to the next free month of Plus.
 */
export default function InvitePage() {
  const { t, locale, toast } = useSession();
  const [info, setInfo] = useState<InvitesInfo | null>(null);
  const [canShare, setCanShare] = useState(false);

  const load = () => api.invites.mine().then(setInfo, (e) => toast(errorMessage(e)));
  useEffect(() => {
    void load();
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!info)
    return (
      <div className="yp-shell__inner">
        <Skeleton height={40} />
        <Skeleton height={200} />
      </div>
    );

  const { reward } = info;
  const done = info.toNextReward === null ? reward.perPeople : reward.perPeople - info.toNextReward;

  async function copy() {
    try {
      await navigator.clipboard.writeText(info!.link);
      toast(t('invite.copied'));
    } catch {
      toast(info!.link);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: 'YAPILAPI', text: t('invite.shareText'), url: info!.link });
    } catch {
      // Closing the share sheet is not an error.
    }
  }

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('invite.title')}</h1>
      </div>
      <p style={{ margin: 0 }}>{t('invite.intro')}</p>

      <Card title={t('invite.yourLink')} subtitle={t('invite.code', { code: info.code })}>
        <div className="stack-sm">
          <TextField label={t('invite.yourLink')} value={info.link} readOnly onFocus={(e) => e.currentTarget.select()} />
          <div className="row">
            <Button onClick={copy} icon="link">
              {t('invite.copy')}
            </Button>
            {canShare ? (
              <Button variant="secondary" onClick={share} icon="send">
                {t('invite.share')}
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title={t('plus.title')} subtitle={t('invite.reward', { count: reward.perPeople, days: reward.days, max: reward.max })}>
        <div className="stack-sm">
          <p style={{ margin: 0 }}>{t('invite.stats', { joined: info.joined, confirmed: info.confirmed })}</p>
          {info.toNextReward === null ? (
            <p style={{ margin: 0 }}>{t('invite.maxed')}</p>
          ) : (
            <label className="stack-sm" style={{ gap: 4 }}>
              <span>{t('invite.progress', { done, total: reward.perPeople })}</span>
              <progress value={done} max={reward.perPeople} style={{ width: '100%' }} />
            </label>
          )}
          {reward.earned ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('invite.earned', { count: reward.earned })} · <Link href="/plus">{t('plus.open')}</Link>
            </p>
          ) : null}
        </div>
      </Card>

      {info.canEnterCode ? <EnterCode days={info.enterCodeDays} onDone={load} /> : null}

      <Card title={t('invite.people')}>
        {info.people.length ? (
          <List>
            {info.people.map((p) => (
              <ListItem
                key={p.user.id}
                href={`/u/${p.user.username}`}
                linkAs={NextLink}
                start={<Avatar name={p.user.displayName} src={p.user.avatarUrl} size="sm" />}
                primary={
                  <>
                    {p.user.displayName}
                    {p.user.plus ? <PlusBadge label={t('plus.badge.label')} /> : null}
                  </>
                }
                secondary={`@${p.user.username} · ${formatRelativeTime(p.joinedAt, locale)}`}
                end={p.confirmed ? <Badge tone="success">{t('invite.confirmed')}</Badge> : <Badge tone="neutral">{t('invite.pending')}</Badge>}
              />
            ))}
          </List>
        ) : (
          <EmptyState title={t('invite.empty')} />
        )}
      </Card>
    </div>
  );
}

/** For a new account that joined without a link: enter the code of the friend who invited you. */
function EnterCode({ days, onDone }: { days: number; onDone: () => void }) {
  const { t, toast } = useSession();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Card title={t('invite.enter.title')} subtitle={t('invite.enter.body', { days })}>
      <form
        className="row"
        style={{ alignItems: 'flex-end' }}
        onSubmit={async (e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
          if (!code) return;
          setBusy(true);
          setError(undefined);
          try {
            const r = await api.invites.accept(code);
            toast(t('invite.enter.done', { name: r.inviter.displayName }));
            onDone();
          } catch (err) {
            setError(fieldErrors(err).code ?? errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label={t('invite.enter.label')} name="code" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} error={error} />
        <Button type="submit" variant="secondary" loading={busy}>
          {t('invite.enter.submit')}
        </Button>
      </form>
    </Card>
  );
}
