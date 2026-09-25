import { z } from 'zod';

export const VISIBILITIES = [
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
  'private',
  'community',
  'subscribers',
] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const visibilitySchema = z.enum(VISIBILITIES);

export const FEATURE_FLAGS = [
  'LIVE',
  'COMMERCE',
  'AI_TRANSLATION',
  'MEMORY',
  'NOW',
  'MINI_APPS',
  'PLAY',
  'REAL',
  'REAL_TOGETHER',
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export const PROFILE_MODES = ['personal', 'creator', 'professional', 'business'] as const;
export const PLATFORM_ROLES = ['user', 'support', 'moderator', 'admin', 'superadmin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/, 'Use 3-30 letters, numbers or underscores');

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'support',
  'help',
  'security',
  'root',
  'system',
  'staff',
  'moderator',
  'yapilapi',
  'yapi',
  'lapi',
  'official',
  'api',
  'www',
  'about',
  'privacy',
  'terms',
  'settings',
  'discover',
  'home',
  'inbox',
  'create',
  'profile',
  'login',
  'logout',
  'signup',
  'register',
]);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);

const COMMON_PASSWORDS = new Set([
  'password123',
  'password1234',
  '1234567890',
  'qwertyuiop',
  'iloveyou12',
  'letmein1234',
  'welcome1234',
  'admin12345',
  'passw0rd123',
  '0123456789',
  'abcdefghij',
  'qwerty12345',
  'yapilapi123',
  'changeme123',
]);

/** Minimal password-quality gate: rejects common passwords and ones containing the identifier. */
export function passwordProblem(password: string, identifiers: string[] = []): string | null {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common';
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character';
  for (const id of identifiers) {
    if (id.length >= 4 && lower.includes(id.toLowerCase()))
      return 'Password must not contain your name, username or email';
  }
  return null;
}

export const MIN_AGE_YEARS = 13;
export const ADULT_AGE_YEARS = 18;

export function ageInYears(birthDate: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const m = now.getUTCMonth() - birthDate.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birthDate.getUTCDate())) age--;
  return age;
}

export const COMMUNITY_PERMISSIONS = [
  'post',
  'comment',
  'invite',
  'moderate',
  'manage_members',
  'manage_settings',
  'manage_channels',
  'manage_roles',
  'pin',
  'manage_events',
  'manage_resources',
] as const;
export type CommunityPermission = (typeof COMMUNITY_PERMISSIONS)[number];

/** System roles created with every community, highest rank first. Custom roles may be added by owners. */
export const SYSTEM_COMMUNITY_ROLES: ReadonlyArray<{
  key: string;
  name: string;
  rank: number;
  permissions: CommunityPermission[];
}> = [
  { key: 'owner', name: 'Owner', rank: 100, permissions: [...COMMUNITY_PERMISSIONS] },
  {
    key: 'admin',
    name: 'Admin',
    rank: 80,
    permissions: COMMUNITY_PERMISSIONS.filter((p) => p !== 'manage_roles'),
  },
  {
    key: 'moderator',
    name: 'Moderator',
    rank: 50,
    permissions: ['post', 'comment', 'invite', 'moderate', 'pin', 'manage_resources'],
  },
  { key: 'member', name: 'Member', rank: 10, permissions: ['post', 'comment'] },
];
