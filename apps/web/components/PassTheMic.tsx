'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BottomSheet, Button, Icon, Select, Skeleton, TextField } from '@yapilapi/design-system';
import {
  CHAIN_JOIN,
  CHAIN_RULES,
  chainBarText,
  fairStartLines,
  fullCount,
  videoPoster,
  type Chain,
  type ChainJoin,
  type ChainRef,
  type FairStart,
  type Post,
  type PublicUser,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PeoplePicker } from '@/components/PeoplePicker';
import { useSession } from '@/app/providers';

/**
 * Pass the Mic on the web (docs/product/pass-the-mic.md): the chain bar on a reel, the sheets to
 * start a chain, pass the mic and choose who can take it, the Chains shelf's cards, and a reel's
 * Fair start for its creator. Everything here is hidden when the PASS_THE_MIC (or FAIR_START) flag is off.
 */

/** Where "Take the mic" goes: the reel composer with the chain's prompt, and the starter's sound when there is one. */
export function takeMicHref(chainId: string, soundId?: string | null, base: '/create' | '/camera' = '/create'): string {
  return `${base}?mode=reel&chain=${encodeURIComponent(chainId)}${soundId ? `&sound=${encodeURIComponent(soundId)}` : ''}`;
}

/** Audiences a reel in a chain can have (the server refuses the others, and communities). */
export const CHAIN_VISIBILITIES = ['public', 'followers', 'friends'] as const;
export const chainableAudience = (v: string) => (CHAIN_VISIBILITIES as readonly string[]).includes(v);

/** The starter's choice when they don't make one: people they follow for under-18 accounts (the server also does this for private ones). */
export const guessChainJoin = (under18: boolean | undefined): ChainJoin => (under18 ? 'following' : 'everyone');

/** "Who can take the mic": everyone, people the starter follows, or nobody (closed). */
export function ChainJoinSelect({
  value,
  onChange,
  withNobody = true,
  disabled,
}: {
  value: ChainJoin;
  onChange: (v: ChainJoin) => void;
  /** Starting a chain closed makes little sense: the start forms leave "nobody" out. */
  withNobody?: boolean;
  disabled?: boolean;
}) {
  const { t } = useSession();
  return (
    <Select label={t('mic.who')} value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value as ChainJoin)}>
      {CHAIN_JOIN.filter((j) => withNobody || j !== 'nobody').map((j) => (
        <option key={j} value={j}>
          {t(`mic.who.${j}`)}
        </option>
      ))}
    </Select>
  );
}

/**
 * On a reel in a chain: where it is in the chain and the prompt (a link to the chain's page),
 * previous and next along the chain, and "Take the mic" when the viewer may add the next reel.
 */
export function ChainBar({
  chain,
  onStep,
  onTake,
}: {
  chain: ChainRef;
  /** Move along the chain; resolves false when there is no reel that way. */
  onStep: (dir: 'next' | 'previous') => Promise<boolean>;
  onTake: () => void;
}) {
  const { t, tp, locale } = useSession();
  const num = (n: number) => fullCount(n, locale);
  // The ends, as far as we know: the first and last positions, or a step that found nothing.
  const [ends, setEnds] = useState({ previous: chain.position <= 1, next: chain.position >= chain.total });
  const [busy, setBusy] = useState(false);
  const step = async (dir: 'next' | 'previous') => {
    if (busy || ends[dir]) return;
    setBusy(true);
    const moved = await onStep(dir);
    if (!moved) setEnds((e) => ({ ...e, [dir]: true }));
    setBusy(false);
  };
  return (
    <div className="reel-chain" role="group" aria-label={t('mic.title')}>
      <Link href={`/chains/${chain.id}`} className="reel-chain__head">
        <span className="reel-chain__where">
          <Icon name="mic" size={13} />
          {chainBarText(chain, t, tp, num)}
        </span>
        <bdi className="reel-chain__prompt" dir="auto">
          {chain.prompt}
        </bdi>
        <span className="reel-chain__by">{t('mic.startedBy', { name: chain.starter.displayName })}</span>
        <span className="yp-visually-hidden">, {t('mic.open')}</span>
      </Link>
      <div className="reel-chain__row">
        {/* aria-disabled, not disabled: a button that disables itself would drop the keyboard focus. */}
        <button
          type="button"
          className="reel__icon-btn reel-chain__previous"
          aria-label={t('mic.previous')}
          aria-disabled={ends.previous || undefined}
          onClick={() => void step('previous')}
        >
          <Icon name="chevron-left" size={20} />
        </button>
        {chain.canJoin ? (
          <button type="button" className="reel-chain__take" onClick={onTake}>
            <Icon name="mic" size={16} />
            {t('mic.take')}
          </button>
        ) : chain.closed ? (
          <span className="reel-chain__closed">{t('mic.closed')}</span>
        ) : (
          <span className="reel-chain__spacer" />
        )}
        <button
          type="button"
          className="reel__icon-btn reel-chain__next"
          aria-label={t('mic.next')}
          aria-disabled={ends.next || undefined}
          onClick={() => void step('next')}
        >
          <Icon name="chevron-right" size={20} />
        </button>
      </div>
    </div>
  );
}

/** Start a chain with one of your reels already posted: a prompt and who can take the mic. */
export function StartChainSheet({ post, onClose, onStarted }: { post: Post | null; onClose: () => void; onStarted: (p: Post) => void }) {
  const { t, toast, me } = useSession();
  const [prompt, setPrompt] = useState('');
  const [join, setJoin] = useState<ChainJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPrompt('');
    setJoin(null);
    setError(null);
  }, [post?.id]);
  if (!post) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await api.chains.start(post.id, text, join ?? undefined);
      const r = await api.posts.get(post.id);
      onStarted(r.post);
      toast(t('mic.started'));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={t('mic.start')}>
      <form className="reel-sheet" onSubmit={submit}>
        <p className="muted reel-sheet__note">{t('mic.start.hint')}</p>
        <TextField
          label={t('mic.prompt')}
          placeholder={t('mic.prompt.placeholder')}
          value={prompt}
          maxLength={CHAIN_RULES.promptMax}
          required
          dir="auto"
          error={error ?? undefined}
          onChange={(e) => setPrompt(e.currentTarget.value)}
        />
        <ChainJoinSelect value={join ?? guessChainJoin(me?.under18)} onChange={setJoin} withNobody={false} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" icon="mic" loading={busy} disabled={!prompt.trim()}>
            {t('mic.start')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

/** Pass the mic: invite up to CHAIN_RULES.passesAtOnce people to add the next reel. */
export function PassMicSheet({ chainId, onClose }: { chainId: string | null; onClose: () => void }) {
  const { t, tp, toast } = useSession();
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPeople([]), [chainId]);
  if (!chainId) return null;
  const send = async () => {
    if (!people.length) return;
    setBusy(true);
    try {
      const r = await api.chains.pass(
        chainId,
        people.map((p) => p.id),
      );
      toast(tp('mic.pass.sent', r.passed, { count: r.passed }));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={t('mic.pass')}>
      <div className="reel-sheet">
        {/* The server skips anyone who can't take the mic, without saying who: the count tells how many it reached. */}
        <PeoplePicker
          label={t('mic.pass')}
          hint={t('mic.pass.hint')}
          max={CHAIN_RULES.passesAtOnce}
          canPick={() => true}
          picked={people}
          onChange={setPeople}
        />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon="send" loading={busy} disabled={!people.length} onClick={() => void send()}>
            {t('mic.pass')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

/**
 * For the starter: who can take the mic, read from the chain itself (a reel only says whether it's
 * closed). Changing it saves at once.
 */
export function ChainJoinField({ chainId, onSaved }: { chainId: string; onSaved: (c: Chain) => void }) {
  const { t, toast } = useSession();
  const [value, setValue] = useState<ChainJoin | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.chains.get(chainId).then(
      (r) => live && setValue(r.chain.whoCanJoin),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [chainId]);
  if (!value) return <Skeleton height={64} />;
  return (
    <ChainJoinSelect
      value={value}
      disabled={busy}
      onChange={async (v) => {
        const before = value;
        setValue(v);
        setBusy(true);
        try {
          const r = await api.chains.edit(chainId, { whoCanJoin: v });
          onSaved(r.chain);
          toast(t('mic.saved'));
        } catch (e) {
          setValue(before);
          toast(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** A chain on the Chains shelf: its first reel's poster, the prompt and the counts. */
export function ChainCard({ chain }: { chain: Chain }) {
  const { t, tp, locale, dataSaver } = useSession();
  const num = (n: number) => fullCount(n, locale);
  const poster = chain.cover ? videoPoster(chain.cover, dataSaver.active) : undefined;
  const counts = chainCounts(chain, tp, num);
  return (
    <li>
      <Link href={`/chains/${chain.id}`} className="chain-card">
        <span className="chain-card__cover">
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" />
          ) : chain.cover && !dataSaver.active ? (
            <video
              src={(chain.cover.variants as Record<string, string> | undefined)?.mp4 ?? chain.cover.url}
              muted
              playsInline
              preload="metadata"
              aria-hidden
            />
          ) : null}
          <span className="chain-card__badge" aria-hidden>
            <Icon name="mic" size={12} />
            {tp('mic.links', chain.counts.links, { count: num(chain.counts.links) })}
          </span>
        </span>
        <span className="chain-card__text">
          <bdi className="chain-card__prompt" dir="auto">
            {chain.prompt}
          </bdi>
          <span className="chain-card__meta">{t('mic.startedBy', { name: chain.starter.displayName })}</span>
          <span className="chain-card__meta">{counts}</span>
        </span>
      </Link>
    </li>
  );
}

/** "47 reels · 30 people · 12 countries" (no countries when nobody said where they are). */
export function chainCounts(
  chain: Pick<Chain, 'counts'>,
  tp: (key: 'mic.links' | 'mic.people' | 'mic.countries', n: number, vars?: Record<string, string | number>) => string,
  num: (n: number) => string,
): string {
  const { links, people, countries } = chain.counts;
  return [
    tp('mic.links', links, { count: num(links) }),
    tp('mic.people', people, { count: num(people) }),
    countries > 0 ? tp('mic.countries', countries, { count: num(countries) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A reel's Fair start, for its creator: how far it got while it runs, and the report once it's
 * done. Nothing when the reel has none (or the FAIR_START flag is off).
 */
export function FairStartCard({ postId }: { postId: string }) {
  const { t, tp, locale, flags } = useSession();
  const [fair, setFair] = useState<FairStart | null>(null);
  const on = !!flags.FAIR_START;
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.fairStart.forPost(postId).then(
      (r) => live && setFair(r.fairStart),
      () => live && setFair(null),
    );
    return () => {
      live = false;
    };
  }, [postId, on]);
  if (!on || !fair) return null;
  const num = (n: number) => fullCount(n, locale);
  const progress = t('fair.progress', { reached: num(fair.reached), target: num(fair.target) });
  return (
    <section className="fair-card" aria-labelledby={`fair-${postId}`}>
      <h3 id={`fair-${postId}`} className="fair-card__title">
        <Icon name="sparkle" size={16} />
        {t('fair.title')}
      </h3>
      {fair.status === 'active' ? (
        <>
          <div
            className="fair-card__bar"
            role="progressbar"
            aria-label={t('fair.title')}
            aria-valuemin={0}
            aria-valuemax={fair.target}
            aria-valuenow={Math.min(fair.reached, fair.target)}
            aria-valuetext={progress}
          >
            <span style={{ width: `${Math.min(100, (fair.reached / Math.max(1, fair.target)) * 100)}%` }} />
          </div>
          <p className="fair-card__line">{progress}</p>
          <p className="fair-card__note">{t('fair.promise', { target: num(fair.target) })}</p>
          {fair.slowed ? <p className="fair-card__note">{t('fair.slowed')}</p> : null}
        </>
      ) : (
        <p className="fair-card__line">{fairStartLines(fair.report, tp, num).join(' · ')}</p>
      )}
    </section>
  );
}
