/**
 * Reactions on chat messages: six favourites always in reach, and every emoji people reach for in
 * a panel grouped by kind. Each person can add several to a message.
 */
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '🙏'] as const;

export type ReactionGroup = 'faces' | 'hearts' | 'people' | 'celebrate' | 'food' | 'signs';

/** The panel's groups, in order, each with its emojis. */
export const REACTION_GROUPS: { id: ReactionGroup; emojis: string[] }[] = [
  {
    id: 'faces',
    emojis: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '🤣',
      '😂',
      '🙂',
      '🙃',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
      '🤩',
      '😘',
      '😗',
      '😚',
      '😋',
      '😛',
      '😜',
      '🤪',
      '😝',
      '🤑',
      '🤗',
      '🤭',
      '🫢',
      '🤫',
      '🤔',
      '🫡',
      '🤐',
      '🤨',
      '😐',
      '😑',
      '😶',
      '🫠',
      '😏',
      '😒',
      '🙄',
      '😬',
      '😌',
      '😔',
      '😪',
      '🤤',
      '😴',
      '😷',
      '🤒',
      '🤕',
      '🤢',
      '🤮',
      '🥵',
      '🥶',
      '🥴',
      '😵',
      '🤯',
      '🤠',
      '🥳',
      '🥸',
      '😎',
      '🤓',
      '🧐',
      '😕',
      '🫤',
      '😟',
      '🙁',
      '😮',
      '😯',
      '😲',
      '😳',
      '🥺',
      '🥹',
      '😦',
      '😧',
      '😨',
      '😰',
      '😥',
      '😢',
      '😭',
      '😱',
      '😖',
      '😣',
      '😞',
      '😓',
      '😩',
      '😫',
      '🥱',
      '😤',
      '😡',
      '😠',
      '🤬',
      '😈',
      '💀',
      '💩',
      '🤡',
      '👻',
      '👽',
      '🤖',
      '😺',
      '😹',
      '😻',
      '🙈',
      '🙉',
      '🙊',
    ],
  },
  {
    id: 'hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '💢', '💥', '💫'],
  },
  {
    id: 'people',
    emojis: [
      '👋',
      '🤚',
      '✋',
      '🖖',
      '👌',
      '🤌',
      '🤏',
      '✌️',
      '🤞',
      '🫰',
      '🤟',
      '🤘',
      '🤙',
      '👈',
      '👉',
      '👆',
      '👇',
      '☝️',
      '👍',
      '👎',
      '✊',
      '👊',
      '🤛',
      '🤜',
      '👏',
      '🙌',
      '🫶',
      '👐',
      '🤲',
      '🤝',
      '🙏',
      '✍️',
      '💪',
      '🦾',
      '👀',
      '🧠',
      '🫂',
      '💃',
      '🕺',
      '🏃',
      '🤷',
      '🤦',
    ],
  },
  {
    id: 'celebrate',
    emojis: [
      '🔥',
      '✨',
      '⭐',
      '🌟',
      '⚡',
      '🌈',
      '☀️',
      '🌙',
      '❄️',
      '🌸',
      '🌹',
      '🌻',
      '🍀',
      '🌍',
      '🎉',
      '🎊',
      '🎈',
      '🎁',
      '🏆',
      '🥇',
      '⚽',
      '🏀',
      '🎶',
      '🎵',
      '🎤',
      '🎧',
      '🎬',
      '📸',
      '💡',
      '💰',
      '💸',
      '📍',
      '🚀',
      '✈️',
      '🚗',
      '🏠',
      '⏰',
      '📚',
      '💻',
    ],
  },
  { id: 'food', emojis: ['🍕', '🍔', '🍟', '🌮', '🍜', '🍣', '🍫', '🍩', '🍰', '🎂', '🍿', '☕', '🍺', '🥂', '🍷', '🍉', '🍌', '🥑', '🌶️', '🍗'] },
  { id: 'signs', emojis: ['✅', '❌', '❓', '❗', '‼️', '⁉️', '💬', '💭', '👑', '💎', '🎯', '🔔', '🆗', '🆒', '🔝', '♻️', '🇳🇬', '🇹🇬', '🇫🇷'] },
];

/** How many emojis you used lately are kept, most recent first. */
export const RECENT_REACTIONS_MAX = 18;

/** The skin colours you can choose: the usual yellow first, then light to dark. */
export const SKIN_TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'] as const;
export type SkinTone = (typeof SKIN_TONES)[number];

/** Hands and people that come in every skin colour. */
const TAKES_TONE = new Set([...'👋🤚✋🖖👌🤌🤏✌🤞🫰🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌🫶👐🤲🤝🙏✍💪💃🕺🏃🤷🤦']);

const withoutTone = (emoji: string) => emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');

/** The same emoji whatever its colour: ✌️ and ✌🏽 are one. */
const sameEmoji = (emoji: string) => withoutTone(emoji).replace(/\ufe0f/g, '');

/** An emoji in your skin colour, when it comes in colours. */
export function withTone(emoji: string, tone: SkinTone): string {
  const base = sameEmoji(emoji);
  if (!TAKES_TONE.has(base)) return emoji;
  return tone ? base + tone : withoutTone(emoji);
}

/** Emojis in your skin colour, once each. */
export function inTone(emojis: readonly string[], tone: SkinTone): string[] {
  return [...new Set(emojis.map((e) => withTone(e, tone)))];
}

/** A saved skin colour, or the usual yellow when there is none. */
export function readTone(saved: unknown): SkinTone {
  return SKIN_TONES.find((tone) => tone === saved) ?? '';
}

/** The reactions bar: the emojis you used lately first, filled up with the usual six, in your skin colour. */
export function favouriteReactions(recent: readonly string[], tone: SkinTone = ''): string[] {
  return inTone([...recent, ...QUICK_REACTIONS], tone).slice(0, QUICK_REACTIONS.length);
}

/** Your recent emojis after reacting with one. */
export function rememberReaction(recent: readonly string[], emoji: string): string[] {
  return [emoji, ...recent.filter((e) => sameEmoji(e) !== sameEmoji(emoji))].slice(0, RECENT_REACTIONS_MAX);
}
