import { COMMUNITY_ROLE_RANK, type CommunityRole } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import type { Translate } from './i18n';

export const ROLE_LABEL: Record<CommunityRole, MessageKey> = {
  owner: 'm.role.owner',
  admin: 'm.role.admin',
  moderator: 'm.role.moderator',
  organizer: 'm.role.organizer',
  member: 'm.role.member',
  guest: 'm.role.guest',
};

/** A community role in the app's language. */
export const roleName = (role: string, t: Translate) => (role in ROLE_LABEL ? t(ROLE_LABEL[role as CommunityRole]) : role);

/** How much say a role has (higher is more); -1 for no role. */
export const roleRank = (role: string | null | undefined) => (role && role in COMMUNITY_ROLE_RANK ? COMMUNITY_ROLE_RANK[role as CommunityRole] : -1);

/** Owners, admins and moderators run the community: its settings screen is theirs. */
export const canManage = (role: string | null | undefined) => roleRank(role) >= COMMUNITY_ROLE_RANK.moderator;
/** Organizers and up can make events for the community (the API checks the same). */
export const canOrganize = (role: string | null | undefined) => roleRank(role) >= COMMUNITY_ROLE_RANK.organizer;
