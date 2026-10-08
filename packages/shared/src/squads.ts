import type { SquadColor, SquadRole } from './constants.ts';
import type { MessageKey, PluralKey } from './i18n-core.ts';
import type { MediaItem, Post, PublicUser } from './types.ts';

/**
 * Squads (docs/product/squads.md), the parts both apps and the API share. No zod here: the phone
 * imports this file directly (the request schemas are in squad-schemas.ts). The numbers are
 * MAX_SQUAD_MEMBERS and SQUAD_RULES in constants.ts.
 *
 * A squad is a small private group of friends: posts, reels and stories shared "to the squad" reach
 * its members only, it has a group chat that follows who is in it, and once a week it gets a
 * "Your squad's week" memory. Nobody outside it sees that it exists.
 */

/** What a post or chain shared with a squad says about it, for members only (Post.squad). */
export interface SquadRef {
  id: string;
  name: string;
  color: SquadColor;
}

/** A squad's story ring (StoryGroup.squad): its cover photo's small size, or its colour. */
export interface StorySquad extends SquadRef {
  coverUrl: string | null;
}

/** A squad's cover: a photo, or its colour. */
export interface SquadCover {
  color: SquadColor;
  photo: MediaItem | null;
}

export interface SquadMember {
  user: PublicUser;
  role: SquadRole;
  /** Invited and not answered yet (shown to members as "Invited"). */
  invited: boolean;
  joinedAt: string | null;
}

/** A squad, for its members (GET /v1/squads/:id). */
export interface Squad extends SquadRef {
  cover: SquadCover;
  /** People in it now, and invited ones, owner first. */
  members: SquadMember[];
  memberCount: number;
  /** The squad's chat (an ordinary group chat), once you're in. */
  conversationId: string | null;
  createdAt: string;
  /** This week's memory, pinned on the squad page until the next one. */
  memory: SquadMemory | null;
  viewer: { role: SquadRole | null; invited: boolean; invitedBy: PublicUser | null };
}

/** One of your squads, or an invite to one, for the Squads list (GET /v1/squads). */
export interface SquadCard extends SquadRef {
  cover: SquadCover;
  memberCount: number;
  /** A few faces for the card. */
  faces: PublicUser[];
  role: SquadRole | null;
  /** You were invited and haven't answered yet, by this person. */
  invitedBy: PublicUser | null;
}

/** "Your squad's week": what the squad shared, read back through the usual visibility rules. */
export interface SquadMemory {
  id: string;
  weekStart: string;
  weekEnd: string;
  counts: { posts: number; reels: number; stories: number; people: number };
  /** People who shared that week. */
  people: PublicUser[];
  /** Up to SQUAD_RULES.memoryTop of the week's most liked and commented posts and reels. */
  top: Post[];
}

/**
 * Colours for squad covers and story rings: white text on each is at least 4.5:1 (squads.test.ts),
 * in light and dark themes alike (the cover carries its own background). Their names are the
 * profile accents' (`ps.accent.<colour>`).
 */
export const SQUAD_COLOR_HEX: Record<SquadColor, string> = {
  coral: '#B93A2B',
  saffron: '#8A5A00',
  leaf: '#2F7D32',
  teal: '#00737A',
  ocean: '#1D5FB4',
  indigo: '#3F4FB8',
  violet: '#6B3FB0',
  orchid: '#9A2F92',
  graphite: '#475569',
};
export const SQUAD_INK = '#FFFFFF';
export const squadColor = (c: string | null | undefined): string => SQUAD_COLOR_HEX[c as SquadColor] ?? SQUAD_COLOR_HEX.coral;

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;
type TrPlural = (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;

const SQUAD_NOTICES = ['squad_invite', 'squad_joined', 'squad_post', 'squad_memory'] as const;

/** Notifications about squads, in the reader's language, or null for other kinds. */
export function squadNoticeText(
  n: { type: string; actor?: { displayName: string } | null; data: Record<string, unknown> },
  t: Tr,
  tp: TrPlural,
): string | null {
  const name = n.actor?.displayName ?? '';
  const squad = String(n.data.name ?? '');
  switch (n.type) {
    case 'squad_invite':
      return t('squads.notif.invite', { name, squad });
    case 'squad_joined':
      return t('squads.notif.joined', { name, squad });
    case 'squad_post': {
      const others = Math.max(0, (Number(n.data.count ?? 1) || 1) - 1);
      return others ? tp('squads.notif.postOthers', others, { name, squad }) : t('squads.notif.post', { name, squad });
    }
    case 'squad_memory':
      return t('squads.notif.memory', { squad });
    default:
      return null;
  }
}

/** The squad a squad notification opens, or null for other kinds. */
export function squadNoticeHref(n: { type: string; entityId?: string | null }): string | null {
  return (SQUAD_NOTICES as readonly string[]).includes(n.type) && n.entityId ? n.entityId : null;
}

/** "4 of 10": how full a squad is (invites count). */
export const squadSpaceLeft = (memberCount: number, max: number): number => Math.max(0, max - memberCount);
