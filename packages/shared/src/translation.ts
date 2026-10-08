/**
 * "See translation" and automatic translation: which languages people can say they
 * understand, how a language is named, and whether a piece of text needs translating
 * for a reader. docs/product/speak-any-language.md explains the whole of it.
 * No zod and no Unicode property escapes here: the mobile app imports this file
 * directly. Request schemas are in schemas.ts; the detector, and keeping #tags,
 * @names and links out of the model's reach, are in language-detect.ts.
 */

/**
 * What can be translated: a post, a comment, the text on a story, a chat message, what was said in a
 * voice message (by the message's id), or what was said in a Yap, a voice reply or a voice intro
 * ('voice', by the clip's id: packages/shared/src/voice.ts).
 */
export const TRANSLATABLE_KINDS = ['post', 'comment', 'story', 'message', 'transcript', 'voice'] as const;
export type TranslatableKind = (typeof TRANSLATABLE_KINDS)[number];

export interface LanguageInfo {
  /** ISO 639-1 code. */
  code: string;
  /** The language's name in itself, used when the reader's language has no name for it. */
  autonym: string;
}

/**
 * Languages the detector recognises and translation can target: the app's own
 * languages first (every one has a catalog in locales/), then others widely used
 * by people on YAPILAPI.
 */
export const TRANSLATION_LANGUAGES: readonly LanguageInfo[] = [
  { code: 'en', autonym: 'English' },
  { code: 'fr', autonym: 'Français' },
  { code: 'ar', autonym: 'العربية' },
  { code: 'es', autonym: 'Español' },
  { code: 'pt', autonym: 'Português' },
  { code: 'sw', autonym: 'Kiswahili' },
  { code: 'yo', autonym: 'Yorùbá' },
  { code: 'ha', autonym: 'Hausa' },
  { code: 'ig', autonym: 'Igbo' },
  { code: 'am', autonym: 'አማርኛ' },
  { code: 'zu', autonym: 'isiZulu' },
  { code: 'de', autonym: 'Deutsch' },
  { code: 'nl', autonym: 'Nederlands' },
  { code: 'it', autonym: 'Italiano' },
  { code: 'tr', autonym: 'Türkçe' },
  { code: 'ru', autonym: 'Русский' },
  { code: 'ur', autonym: 'اردو' },
  { code: 'hi', autonym: 'हिन्दी' },
  { code: 'bn', autonym: 'বাংলা' },
  { code: 'zh', autonym: '中文' },
  { code: 'ja', autonym: '日本語' },
  { code: 'ko', autonym: '한국어' },
  { code: 'vi', autonym: 'Tiếng Việt' },
  { code: 'id', autonym: 'Bahasa Indonesia' },
  { code: 'pl', autonym: 'Polski' },
  { code: 'uk', autonym: 'Українська' },
  { code: 'el', autonym: 'Ελληνικά' },
  { code: 'he', autonym: 'עברית' },
  { code: 'fa', autonym: 'فارسی' },
  { code: 'th', autonym: 'ไทย' },
];

export const TRANSLATION_LANGUAGE_CODES: readonly string[] = TRANSLATION_LANGUAGES.map((l) => l.code);

/** A language's name in itself ("Français", "日本語", "isiZulu"), the same on every platform; the code when it isn't listed. */
export function autonym(code: string): string {
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.autonym ?? code;
}

/** For sorting: lower case, accents off ("Español" → "espanol"), where the platform can take them off. */
function sortKey(name: string): string {
  const lower = name.toLowerCase();
  try {
    // Hangul syllables come apart under NFD too, and go back together under NFC.
    return lower
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFC');
  } catch {
    return lower;
  }
}

/**
 * Language codes in the order a language picker lists them: by their own names, Latin letters
 * first (Bahasa Indonesia, Deutsch, English… Yorùbá), then the other scripts (Русский, اردو,
 * हिन्दी… 한국어). The order is by character, not the platform's collation, so the server, every
 * browser and the phone agree.
 */
export function byAutonym(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => {
    const x = sortKey(autonym(a));
    const y = sortKey(autonym(b));
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** How many languages someone can list under "Languages I understand". */
export const MAX_UNDERSTOOD_LANGUAGES = 12;

/** "pt-BR" → "pt". */
export function baseLanguage(tag: string | null | undefined): string {
  return (tag ?? '').replace(/_/g, '-').split('-')[0]!.toLowerCase();
}

export function isTranslationLanguage(code: string | null | undefined): boolean {
  return !!code && TRANSLATION_LANGUAGE_CODES.includes(code);
}

/**
 * A language's name in the reader's language ("French" for an English reader,
 * "français" for a French one), or its autonym when the platform has no name for it.
 */
export function languageName(code: string, displayLocale = 'en'): string {
  try {
    const Names = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of(c: string): string | undefined } }).DisplayNames;
    if (Names) {
      const name = new Names([displayLocale], { type: 'language' }).of(code);
      if (name && name.toLowerCase() !== code.toLowerCase()) return name;
    }
  } catch {
    // An unknown locale, or no Intl.DisplayNames on this platform.
  }
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.autonym ?? code;
}

/** The languages a reader understands: the app's language always, plus the ones they listed. */
export function understoodLanguages(appLanguage: string, listed: readonly string[] | null | undefined): string[] {
  const out = [baseLanguage(appLanguage) || 'en'];
  for (const l of listed ?? []) {
    const b = baseLanguage(l);
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
}

/**
 * Whether to offer "See translation": the text's language is known, it can be
 * translated, and the reader hasn't said they understand it.
 */
export function needsTranslation(textLanguage: string | null | undefined, appLanguage: string, listed?: readonly string[] | null): boolean {
  if (!textLanguage || !isTranslationLanguage(textLanguage)) return false;
  if (!isTranslationLanguage(baseLanguage(appLanguage))) return false;
  return !understoodLanguages(appLanguage, listed).includes(textLanguage);
}

/**
 * Whether text is worth translating automatically: not only emoji, #tags, @names, links
 * or numbers, and not a single capitalised word (most often a name: "Lagos", "Ada").
 * Such text still gets "See translation" when its language is known.
 */
export function worthTranslating(text: string | null | undefined): boolean {
  const words = (text ?? '')
    // Links, email addresses, @names and #tags are never translated.
    .replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|[@#]\S+/g, ' ')
    // Emoji (with their joiners and variation selectors), digits and ASCII punctuation.
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[☀-➿‍️⃣]|[0-9!-/:-@[-`{-~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.join('').length < 2) return false;
  if (words.length === 1) {
    const first = words[0]!.charAt(0);
    // One word starting with a capital letter (scripts without capitals never match).
    if (first !== first.toLowerCase()) return false;
  }
  return true;
}

/** How many items one POST /v1/translations asks about. */
export const TRANSLATION_BATCH_MAX = 50;

/** A translation as POST /v1/translate returns it. */
export interface Translation {
  kind: TranslatableKind;
  id: string;
  /** Detected language of the original. */
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  /** Always true: every translation is made by a machine and says so. */
  machine: true;
  /** 'dev' marks the offline pseudo-translation used in development and tests. */
  provider: string;
  /** Served from the cache (same text, same target) rather than translated again. */
  cached: boolean;
}

/**
 * POST /v1/translations: automatic translation of what's on screen. `items` has the
 * translations ready now (made earlier for anyone, or just made); `pending` the ones still
 * being made, to ask about again shortly. Anything else (not visible, in a language the
 * reader understands, too short, or past a limit) is left out and keeps "See translation".
 * `auto` is false when automatic translation is off or paused (the reader's setting, the
 * AUTO_TRANSLATE flag, no translation model, or a limit): stop asking for a while.
 */
export interface TranslationBatch {
  items: Translation[];
  pending: { kind: TranslatableKind; id: string }[];
  auto: boolean;
}

/** The reader's translation settings (Me.translation, PUT /v1/me/translation). */
export interface TranslationSettings {
  /** Languages they understand besides the app's language. Empty means just the app's language. */
  languages: string[];
  /** Show translations straight away instead of "See translation". On by default. */
  auto: boolean;
}
