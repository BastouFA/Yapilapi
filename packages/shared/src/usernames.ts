// No zod here: the phone app imports this file directly (zod stays out of its bundle). The
// schemas built on these rules are in schemas.ts.

/** A username can change once in this many days. */
export const USERNAME_CHANGE_DAYS = 14;
/** After a change, the old username stays yours (nobody else can take it, and old links lead to you) this long. */
export const USERNAME_HOLD_DAYS = 14;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Names nobody can take: they could pass for the service or its staff, or clash with pages.
 * Compared without regard to case. Any name containing "yapilapi" is reserved too.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'about',
  'account',
  'accounts',
  'admin',
  'administrator',
  'admins',
  'api',
  'app',
  'apps',
  'billing',
  'blog',
  'careers',
  'communities',
  'contact',
  'developer',
  'developers',
  'discover',
  'email',
  'everyone',
  'events',
  'explore',
  'help',
  'helpdesk',
  'home',
  'inbox',
  'info',
  'invite',
  'jobs',
  'legal',
  'live',
  'login',
  'logout',
  'mail',
  'me',
  'messages',
  'mod',
  'moderator',
  'moderators',
  'music',
  'news',
  'noreply',
  'no_reply',
  'notifications',
  'null',
  'oauth',
  'official',
  'password',
  'payments',
  'places',
  'plus',
  'press',
  'privacy',
  'reels',
  'register',
  'root',
  'rooms',
  'safety',
  'search',
  'security',
  'settings',
  'signin',
  'signup',
  'sounds',
  'staff',
  'status',
  'studio',
  'support',
  'system',
  'team',
  'terms',
  'together',
  'trust',
  'undefined',
  'verified',
  'verify',
  'www',
  'yapi',
];

const RESERVED = new Set(RESERVED_USERNAMES);

/** Why a new username can't be used, or null when it follows the rules (whether it's free is a separate question). */
export type UsernameProblem = 'length' | 'characters' | 'reserved';

/** The rules for a new username: 3 to 30 letters, numbers or underscores, and not a reserved name. */
export function usernameProblem(name: string): UsernameProblem | null {
  const n = name.trim();
  if (n.length < USERNAME_MIN || n.length > USERNAME_MAX) return 'length';
  if (!/^[a-z0-9_]+$/i.test(n)) return 'characters';
  const lower = n.toLowerCase();
  if (RESERVED.has(lower) || lower.includes('yapilapi')) return 'reserved';
  return null;
}

export const USERNAME_PROBLEM_MESSAGES: Record<UsernameProblem, string> = {
  length: `Use ${USERNAME_MIN} to ${USERNAME_MAX} characters.`,
  characters: 'Use letters, numbers and underscores only.',
  reserved: 'That username is reserved. Try another.',
};

/** The next moment a username can change, given when it last did (null: it never did, so now). */
export function nextUsernameChange(lastChangedAt: Date | string | null | undefined): Date | null {
  if (!lastChangedAt) return null;
  const at = new Date(new Date(lastChangedAt).getTime() + USERNAME_CHANGE_DAYS * 86_400_000);
  return at;
}
