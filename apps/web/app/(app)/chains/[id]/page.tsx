'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import { fullCount, type Chain, type ChainJoin } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { ReelGrid } from '@/components/ReelGrid';
import { FeatureOff } from '@/components/FeatureOff';
import { ChainJoinSelect, chainCounts, PassMicSheet, takeMicHref } from '@/components/PassTheMic';
import { useSession } from '../../../providers';

/**
 * A Pass the Mic chain: the prompt, who started it, how many reels, people and countries, "Take the
 * mic" when you may add the next reel, and its reels in order (each opens in the Reels player).
 * The starter can close it, open it again and choose who can take the mic here too.
 */
export default function ChainPage() {
  const { id } = useParams<{ id: string }>();
  const { t, tp, locale, toast, me, flags } = useSession();
  const [chain, setChain] = useState<Chain | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passing, setPassing] = useState(false);

  const load = useCallback(() => {
    setMissing(null);
    setLoadError(null);
    api.chains.get(id).then(
      (r) => setChain(r.chain),
      (e) => (isGone(e) ? setMissing(errorMessage(e)) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    setChain(null);
    load();
  }, [load]);
  const links = useCallback((cursor?: string) => api.chains.links(id, cursor), [id]);

  if (flags.PASS_THE_MIC === false) return <FeatureOff name={t('mic.title')} />;
  if (missing) return <EmptyState level={1} title={t('mic.title')} body={missing} />;
  if (!chain && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!chain) return <Skeleton height={240} />;

  const num = (n: number) => fullCount(n, locale);
  const setJoin = async (whoCanJoin: ChainJoin) => {
    setBusy(true);
    try {
      const r = await api.chains.edit(chain.id, { whoCanJoin });
      setChain(r.chain);
      toast(t('mic.saved'));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>{t('mic.title')}</h1>
      </div>
      <section className="chain-head" aria-labelledby="chain-prompt">
        <p id="chain-prompt" className="chain-head__prompt" dir="auto">
          <bdi>{chain.prompt}</bdi>
        </p>
        <Link href={`/u/${chain.starter.username}`} className="chain-head__starter">
          <Avatar name={chain.starter.displayName} src={chain.starter.avatarUrl} size="sm" />
          <span>{t('mic.startedBy', { name: chain.starter.displayName })}</span>
        </Link>
        <p className="muted chain-head__counts">{chainCounts(chain, tp, num)}</p>
        <div className="row chain-head__actions">
          {chain.viewer.canJoin ? (
            <Link href={takeMicHref(chain.id, chain.sound?.id)} className="yp-btn yp-btn--primary">
              <Icon name="mic" />
              {t('mic.take')}
            </Link>
          ) : chain.closed ? (
            <p className="chain-head__closed">
              <Icon name="mic-off" size={16} />
              {t('mic.closed')}
            </p>
          ) : null}
          {chain.firstPostId ? (
            <Link href={`/reels?start=${chain.firstPostId}`} className="yp-btn yp-btn--secondary">
              <Icon name="play" />
              {t('mic.playFromStart')}
            </Link>
          ) : null}
          {me ? (
            <Button variant="ghost" icon="send" onClick={() => setPassing(true)}>
              {t('mic.pass')}
            </Button>
          ) : null}
        </div>
        {chain.sound ? (
          <Link href={`/sounds/${chain.sound.id}`} className="chain-head__sound">
            <Icon name="music" size={14} />
            <bdi>{chain.sound.title}</bdi>
          </Link>
        ) : null}
      </section>

      {chain.viewer.isStarter ? (
        <section className="chain-manage stack-sm">
          <ChainJoinSelect value={chain.whoCanJoin} disabled={busy} onChange={(v) => void setJoin(v)} />
          <div className="row">
            <Button
              variant="secondary"
              size="sm"
              icon={chain.closed ? 'mic' : 'mic-off'}
              loading={busy}
              onClick={() => void setJoin(chain.closed ? 'everyone' : 'nobody')}
            >
              {t(chain.closed ? 'mic.reopen' : 'mic.close')}
            </Button>
          </div>
        </section>
      ) : null}

      <ReelGrid load={links} reloadKey={id} empty={t('mic.empty')} />
      <PassMicSheet chainId={passing ? chain.id : null} onClose={() => setPassing(false)} />
    </div>
  );
}
