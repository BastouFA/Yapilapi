'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Badge, Button, EmptyState, Skeleton, Stat } from '@yapilapi/design-system';
import { dropPhase, formatMoney, type Drop } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { DropBuy, DropCover, dropStatusText, useDrop } from '@/components/Drops';
import { ReportSheet } from '@/components/PostList';
import { JoinNote, NeedsAccount, useSignIn } from '@/components/SignedOut';
import { useSession } from '../../../providers';

/**
 * A drop: what it is, who sells it, when it opens (in plain words), and its products with the
 * real numbers left. Before it opens, "Notify me" puts you on the reminder list; once open, each
 * product is bought through the usual checkout. The seller also sees how many are waiting, the
 * sales and when things sold out, and can edit (before it opens), publish or cancel.
 */
export default function DropPageClient({ isPublic }: { isPublic: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { t, tp, toast, locale, me } = useSession();
  const signIn = useSignIn();
  const router = useRouter();
  const signedOut = !me;
  const { drop, setDrop, missing, reload, now } = useDrop(id, !signedOut || isPublic);
  const [busy, setBusy] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  if (signedOut && !isPublic) return <NeedsAccount title={t('m.drops.signInTitle')} body={t('m.drops.signInBody')} />;
  if (missing) return <EmptyState title={t('m.drops.missing')} body={t('m.drops.missingBody')} />;
  if (!drop) return <Skeleton height={320} />;

  const phase = dropPhase(drop, now);
  const upcoming = phase === 'upcoming' || phase === 'opening';

  async function run(key: string, fn: () => Promise<{ drop: Drop } | void>, done?: string) {
    setBusy(key);
    try {
      const r = await fn();
      if (r) setDrop(r.drop);
      if (done) toast(done);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="yp-shell__inner drop">
      <DropCover drop={drop} className="drop-cover drop-cover--wide" eager />
      <header className="stack-sm">
        <h1 className="profile__name" dir="auto">
          {drop.title}
        </h1>
        <Link href={`/u/${drop.seller.username}`} className="row drop__seller">
          {/* The link says the name once: the picture is decoration here. */}
          <span aria-hidden>
            <Avatar name={drop.seller.displayName} src={drop.seller.avatarUrl} size="sm" />
          </span>{' '}
          {t('m.drops.by', { name: drop.seller.displayName })}
        </Link>
        {/* Not a live region: "in 5 minutes" changes every minute. What's said out loud is when it opens, sells out or ends. */}
        <p className="drop__when">
          <strong>{dropStatusText(t, locale, drop, now)}</strong>
        </p>
        <PhaseNote phase={phase} text={dropStatusText(t, locale, drop, now)} />
        {drop.description ? (
          <p className="drop__description" dir="auto">
            {drop.description}
          </p>
        ) : null}
      </header>

      {phase === 'draft' ? <Alert tone="info">{t('m.drops.draftNote')}</Alert> : null}
      {phase === 'cancelled' ? <Alert tone="info">{t('m.drops.cancelledNote')}</Alert> : null}
      {phase === 'ended' ? <Alert tone="info">{drop.endReason === 'sold_out' ? t('m.drops.soldOutNote') : t('m.drops.endedNote')}</Alert> : null}

      {upcoming && !drop.isSeller ? (
        <section className="stack-sm drop__remind">
          {drop.reminded ? (
            <p style={{ margin: 0 }}>
              <Badge tone="success">{t('m.drops.notifying')}</Badge>
            </p>
          ) : null}
          {/* One button that changes, so focus stays on it (the toast says what happened). */}
          <div>
            <Button
              variant={drop.reminded ? 'secondary' : 'primary'}
              icon={drop.reminded ? undefined : 'bell'}
              loading={busy === 'remind'}
              onClick={() =>
                signedOut
                  ? signIn()
                  : drop.reminded
                    ? run(
                        'remind',
                        async () => {
                          await api.drops.unremind(drop.id);
                          setDrop({ ...drop, reminded: false });
                        },
                        t('m.drops.notifyOff'),
                      )
                    : run(
                        'remind',
                        async () => {
                          await api.drops.remind(drop.id);
                          setDrop({ ...drop, reminded: true });
                        },
                        t('m.drops.notifyOn'),
                      )
              }
            >
              {drop.reminded ? t('m.drops.stopNotifying') : t('m.drops.notifyMe')}
            </Button>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {t('m.drops.notifyNote')}
          </p>
        </section>
      ) : null}

      <section className="stack-sm" aria-labelledby="drop-products">
        <h2 id="drop-products" className="section-title" style={{ margin: 0 }}>
          {tp('m.drops.products', drop.items.length)}
        </h2>
        <ul className="drop__items">
          {drop.items.map((item) => {
            const stat = drop.stats?.items.find((s) => s.productId === item.productId);
            return (
              <li key={item.productId} className="yp-card drop__item">
                <div className="drop__item-head">
                  <h3 className="drop__item-title" dir="auto">
                    {item.title}
                  </h3>
                  <strong>{formatMoney(item.priceCents, item.currency, locale)}</strong>
                </div>
                {item.description ? (
                  <p className="muted drop__item-desc" dir="auto">
                    {item.description}
                  </p>
                ) : null}
                <p className="drop__item-facts">
                  {item.soldOut ? <Badge>{t('m.drops.soldOut')}</Badge> : item.remaining !== null ? <span>{tp('m.drops.left', item.remaining)}</span> : null}
                  {item.perBuyerLimit !== null && item.kind !== 'digital' ? <span>{t('m.drops.limit', { count: item.perBuyerLimit })}</span> : null}
                  {item.yours ? <span>{t('m.drops.yoursCount', { count: item.yours })}</span> : null}
                </p>
                {stat ? (
                  <p className="muted drop__item-facts">
                    <span>{t('m.drops.stats.itemSold', { sold: stat.sold, held: stat.held })}</span>
                    {stat.soldOutAt ? (
                      <span>
                        {t('m.drops.stats.soldOutAt', {
                          when: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(stat.soldOutAt)),
                        })}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {phase === 'open' && !drop.isSeller ? (
                  signedOut ? (
                    <Button onClick={signIn}>{t('m.drops.buy')}</Button>
                  ) : (
                    <DropBuy drop={drop} item={item} onDone={() => void reload()} />
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {drop.isSeller && drop.stats ? (
        <section className="drop__panel stack-sm" aria-labelledby="drop-numbers">
          <h2 id="drop-numbers" className="section-title" style={{ margin: 0 }}>
            {t('m.drops.stats.title')}
          </h2>
          <div className="drop__stats">
            <Stat label={t('m.drops.stats.waiting')} value={drop.stats.waiting} />
            <Stat label={t('m.drops.stats.orders')} value={drop.stats.orders} />
            <Stat label={t('m.drops.stats.sold')} value={drop.stats.unitsSold} />
            <Stat label={t('m.drops.stats.held')} value={drop.stats.unitsHeld} />
            <Stat
              label={t('m.drops.stats.revenue')}
              value={drop.stats.revenue.length ? drop.stats.revenue.map((r) => formatMoney(r.grossCents, r.currency, locale)).join(' · ') : '0'}
            />
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {t('m.drops.stats.note')}
          </p>
        </section>
      ) : null}

      <div className="row drop__actions">
        {drop.isSeller && (phase === 'draft' || phase === 'upcoming') ? (
          <Link href={`/drops/${drop.id}/edit`} className="yp-btn yp-btn--secondary">
            {t('m.drops.edit')}
          </Link>
        ) : null}
        {drop.isSeller && phase === 'draft' ? (
          <Button loading={busy === 'publish'} onClick={() => run('publish', () => api.drops.publish(drop.id), t('m.drops.published'))}>
            {t('m.drops.publish')}
          </Button>
        ) : null}
        {drop.isSeller && (drop.status === 'scheduled' || drop.status === 'open') ? (
          <Button
            variant="danger"
            loading={busy === 'cancel'}
            onClick={() => {
              if (confirm(t('m.drops.cancelConfirm'))) void run('cancel', () => api.drops.cancel(drop.id), t('m.drops.cancelDone'));
            }}
          >
            {t('m.drops.cancel')}
          </Button>
        ) : null}
        {drop.isSeller && drop.status === 'draft' ? (
          <Button
            variant="ghost"
            loading={busy === 'delete'}
            onClick={() => {
              if (!confirm(t('m.drops.deleteConfirm'))) return;
              void run(
                'delete',
                async () => {
                  await api.drops.remove(drop.id);
                  router.push('/drops');
                },
                t('m.drops.deleted'),
              );
            }}
          >
            {t('m.drops.deleteDraft')}
          </Button>
        ) : null}
        {drop.status !== 'draft' ? (
          <Button variant="ghost" icon="link" onClick={async () => toast((await copyText(location.href)) ? t('m.drops.linkCopied') : t('story.copyFailed'))}>
            {t('m.drops.copyLink')}
          </Button>
        ) : null}
        {!drop.isSeller && !signedOut ? (
          <Button variant="ghost" icon="flag" onClick={() => setReporting(true)}>
            {t('m.drops.report')}
          </Button>
        ) : null}
      </div>

      {signedOut ? <JoinNote text={t('m.drops.join')} /> : null}
      <ReportSheet target={reporting ? { type: 'drop', id: drop.id } : null} onClose={() => setReporting(false)} />
    </div>
  );
}

/** Says the drop's status out loud when it opens, sells out or ends while you're here (not on every tick of the clock). */
function PhaseNote({ phase, text }: { phase: string; text: string }) {
  const seen = useRef(phase);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (phase === seen.current) return;
    seen.current = phase;
    setSaid(text);
  }, [phase, text]);
  return (
    <span className="yp-visually-hidden" role="status">
      {said}
    </span>
  );
}
