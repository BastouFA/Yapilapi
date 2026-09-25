/** Feature flags. Defaults apply when the database has no row for a flag. */
export const FEATURE_FLAGS = {
  LIVE: { default: false, description: 'Live sessions (host, co-hosts, audience).' },
  COMMERCE: { default: true, description: 'Products, orders and checkout.' },
  AI_TRANSLATION: { default: true, description: 'Translate posts, messages and captions.' },
  MEMORY: { default: false, description: 'Personal memory collections and recaps.' },
  NOW: { default: true, description: 'Real-time "happening now" discovery surface.' },
  MINI_APPS: { default: false, description: 'Mini apps inside conversations, communities and events.' },
  PLAY: { default: false, description: 'Games and play experiences.' },
  REAL: { default: false, description: 'Authenticity-focused dual capture.' },
  REAL_TOGETHER: { default: false, description: 'Shared multi-perspective experiences.' },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlag[];
