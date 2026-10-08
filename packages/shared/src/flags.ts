/** Feature flags. Defaults apply when the database has no row for a flag. */
export const FEATURE_FLAGS = {
  LIVE: { default: false, description: 'Live sessions (host, co-hosts, audience).' },
  COMMERCE: { default: true, description: 'Products, orders and checkout.' },
  AI_TRANSLATION: { default: true, description: 'Translate posts, messages and captions.' },
  AUTO_TRANSLATE: {
    default: true,
    description: 'Show posts, comments, stories and messages in each reader’s language without a tap (needs AI_TRANSLATION and a translation model).',
  },
  AI_CATCH_UP: { default: true, description: 'Catch me up on Pulse: a short summary of what your people shared while you were away.' },
  AI_SMART_REPLIES: { default: true, description: 'Suggested short replies under the last message you received in a chat.' },
  AI_ALT_TEXT: { default: true, description: 'Suggest a description of a photo for people using screen readers.' },
  AI_CAPTIONS: { default: true, description: 'Caption ideas and relevant hashtags in the composer.' },
  MEMORY: { default: false, description: 'Personal memory collections and recaps.' },
  NOW: { default: true, description: 'Real-time "happening now" discovery surface.' },
  MINI_APPS: { default: false, description: 'Mini apps inside conversations, communities and events.' },
  PLAY: { default: false, description: 'Games and play experiences.' },
  REAL: { default: false, description: 'Authenticity-focused dual capture.' },
  REAL_TOGETHER: { default: false, description: 'Shared multi-perspective experiences.' },
  PASS_THE_MIC: { default: true, description: 'Pass the Mic: reels made together, one after another, from a prompt (chains).' },
  FAIR_START: { default: true, description: "Fair start: a new creator's first reels are shown to up to 1,000 people." },
  ADS: { default: false, description: 'Sponsored posts: paid campaigns shown only to adults who opted in to advertising.' },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlag[];
