import type { ChainJoin } from './constants.ts';
import type { MessageKey, PluralKey } from './i18n-core.ts';
import type { MediaItem, PublicUser } from './types.ts';

/**
 * Pass the Mic and Fair start (docs/product/pass-the-mic.md), the parts both apps and the API
 * share. No zod here: the phone imports this file directly (the request schemas are in
 * pass-the-mic-schemas.ts). The numbers are CHAIN_RULES and FAIR_START in constants.ts.
 *
 * A chain is a prompt someone starts with one of their reels ("Show your city's best street food");
 * anyone allowed takes the mic and posts the next reel, and the chain plays in order. Counts
 * include every reel up in the chain, also ones a viewer can't see, which are never shown to them.
 */

/** On a reel that is in a chain (Post.chain). */
export interface ChainRef {
  id: string;
  prompt: string;
  /** This reel's place in the chain and how many reels are in it now (1-based). */
  position: number;
  total: number;
  /** Different people with a reel in it, and the countries they're in (0 when nobody said where). */
  people: number;
  countries: number;
  starter: PublicUser;
  /** Whether the viewer may add the next reel now. */
  canJoin: boolean;
  /** The viewer started this chain (and may close it, or remove reels from it). */
  isStarter: boolean;
  closed: boolean;
}

/** Why someone can't take the mic: closed, only people the starter follows, minor protection, too many reels, signed out. */
export type ChainBlock = 'closed' | 'following' | 'not_allowed' | 'limit' | 'signed_out';

/** A chain, for its page and the Chains shelf. */
export interface Chain {
  id: string;
  prompt: string;
  starter: PublicUser;
  whoCanJoin: ChainJoin;
  closed: boolean;
  createdAt: string;
  lastLinkAt: string;
  counts: { links: number; people: number; countries: number };
  /** The starter's sound, offered when you take the mic (only while you may use it). */
  sound: { id: string; title: string } | null;
  /** The first reel's video the viewer can see, for the shelf and the page. */
  cover: MediaItem | null;
  /** The first reel of the chain the viewer can see: where "Play" starts. */
  firstPostId: string | null;
  viewer: { canJoin: boolean; isStarter: boolean; why: ChainBlock | null };
}

/** What a finished fair start says to the creator. */
export interface FairStartReport {
  /** Different real people who saw it. */
  reached: number;
  /** Of them, people who watched it to the end, shared it, and followed the creator after seeing it. */
  finished: number;
  shared: number;
  followed: number;
}

/** A reel's fair start, for its creator (GET /v1/posts/:id/fair-start, and the reel's insights). */
export interface FairStart {
  status: 'active' | 'done' | 'stopped';
  target: number;
  reached: number;
  /** Early viewers mostly moved on at once, or it was reported: it goes to fewer people (at least FAIR_START.minimum). */
  slowed: boolean;
  startedAt: string;
  endsAt: string;
  finishedAt: string | null;
  /** Once it's done; while it runs, the numbers so far. */
  report: FairStartReport;
}

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;
type TrPlural = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

/** "Link 3 of 47 · 12 countries", with the people when there are no countries to say. */
export function chainBarText(
  c: Pick<ChainRef, 'position' | 'total' | 'countries' | 'people'>,
  t: Tr,
  tp: TrPlural,
  number: (n: number) => string = String,
): string {
  const where = t('mic.bar', { position: number(c.position), total: number(c.total) });
  return c.countries > 0 ? `${where} · ${tp('mic.countries', c.countries, { count: number(c.countries) })}` : where;
}

/** The report's parts: "1,000 people saw your reel", "630 watched to the end", "24 shared", "12 followed you". */
export function fairStartLines(r: FairStartReport, tp: TrPlural, number: (n: number) => string = String): string[] {
  return [
    tp('fair.seen', r.reached, { count: number(r.reached) }),
    tp('fair.finished', r.finished, { count: number(r.finished) }),
    tp('fair.shared', r.shared, { count: number(r.shared) }),
    tp('fair.followed', r.followed, { count: number(r.followed) }),
  ];
}

/** Notifications about chains and fair starts, in the reader's language, or null for other kinds. */
export function micNoticeText(n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> }, t: Tr, tp: TrPlural): string | null {
  const name = n.actor?.displayName ?? '';
  const others = Math.max(0, (Number(n.data.count ?? 1) || 1) - 1);
  switch (n.type) {
    case 'chain_link':
      return others ? tp('mic.notif.link.others', others, { name }) : t('mic.notif.link', { name });
    case 'chain_next':
      return others ? tp('mic.notif.next.others', others, { name }) : t('mic.notif.next', { name });
    case 'chain_pass':
      return t('mic.notif.pass', { name, prompt: String(n.data.prompt ?? '') });
    case 'fair_start_done': {
      const reached = Number(n.data.reached ?? 0) || 0;
      return tp('fair.notif', reached, { count: reached });
    }
    default:
      return null;
  }
}

/** Where a chain or fair-start notification opens: the chain's page, or the reel. */
export function micNoticeHref(n: { type: string; entityId?: string | null; data: Record<string, unknown> }): { chain: string } | { reel: string } | null {
  if (n.type === 'fair_start_done') return n.entityId ? { reel: n.entityId } : null;
  if (n.type !== 'chain_link' && n.type !== 'chain_next' && n.type !== 'chain_pass') return null;
  const chain = typeof n.data.chainId === 'string' ? n.data.chainId : null;
  // One person: their reel. Several (grouped), or a pass: the chain.
  if (n.type !== 'chain_pass' && n.entityId && Number(n.data.count ?? 1) <= 1) return { reel: n.entityId };
  return chain ? { chain } : n.entityId ? { reel: n.entityId } : null;
}
