/**
 * Language helpers: BCP-47 normalisation, a small script/stop-word language detector, and the built-in DEV phrasebook.
 * The detector is a heuristic for routing and labelling ("this looks like Spanish"), never a security decision.
 */

const NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  ru: 'Russian',
  ar: 'Arabic',
  he: 'Hebrew',
  hi: 'Hindi',
  th: 'Thai',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  el: 'Greek',
  yo: 'Yoruba',
  sw: 'Swahili',
  tr: 'Turkish',
  pl: 'Polish',
  uk: 'Ukrainian',
  id: 'Indonesian',
  vi: 'Vietnamese',
};
export const languageName = (code: string): string => NAMES[normalizeLanguage(code) ?? ''] ?? code;

const BY_NAME = new Map(Object.entries(NAMES).map(([code, name]) => [name.toLowerCase(), code]));
/** 'Spanish' -> 'es' (also accepts codes). */
export function languageFromName(name: string): string | null {
  const n = name.trim().toLowerCase();
  return BY_NAME.get(n) ?? normalizeLanguage(n.length <= 3 ? n : null);
}

/** 'pt-BR' -> 'pt', 'EN_us' -> 'en'; null when it is not a plausible language tag. */
export function normalizeLanguage(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /^([a-zA-Z]{2,3})(?:[-_][a-zA-Z0-9]{2,8})*$/.exec(input.trim());
  return m ? m[1]!.toLowerCase() : null;
}

const SCRIPTS: Array<{ lang: string; re: RegExp }> = [
  { lang: 'ja', re: /[぀-ヿ]/ },
  { lang: 'ko', re: /[가-힯]/ },
  { lang: 'zh', re: /[一-鿿]/ },
  { lang: 'ru', re: /[Ѐ-ӿ]/ },
  { lang: 'ar', re: /[؀-ۿ]/ },
  { lang: 'he', re: /[֐-׿]/ },
  { lang: 'hi', re: /[ऀ-ॿ]/ },
  { lang: 'th', re: /[฀-๿]/ },
  { lang: 'el', re: /[Ͱ-Ͽ]/ },
];

const STOP: Record<string, string[]> = {
  en: [
    'the',
    'and',
    'is',
    'are',
    'you',
    'to',
    'of',
    'in',
    'that',
    'it',
    'for',
    'with',
    'this',
    'have',
    'what',
    'we',
    'i',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'de',
    'que',
    'y',
    'en',
    'un',
    'una',
    'es',
    'por',
    'con',
    'para',
    'gracias',
    'hola',
    'buenos',
    'días',
  ],
  fr: [
    'le',
    'la',
    'les',
    'des',
    'et',
    'est',
    'une',
    'un',
    'que',
    'pour',
    'dans',
    'avec',
    'merci',
    'bonjour',
    'je',
    'nous',
    'vous',
  ],
  de: [
    'der',
    'die',
    'das',
    'und',
    'ist',
    'nicht',
    'ein',
    'eine',
    'mit',
    'für',
    'ich',
    'wir',
    'danke',
    'guten',
    'morgen',
    'auf',
  ],
  pt: [
    'o',
    'a',
    'os',
    'as',
    'de',
    'que',
    'e',
    'em',
    'um',
    'uma',
    'para',
    'com',
    'obrigado',
    'obrigada',
    'olá',
    'você',
    'não',
  ],
  it: [
    'il',
    'lo',
    'la',
    'gli',
    'di',
    'che',
    'e',
    'un',
    'una',
    'per',
    'con',
    'grazie',
    'ciao',
    'buongiorno',
    'sono',
    'non',
  ],
  nl: [
    'de',
    'het',
    'een',
    'en',
    'is',
    'van',
    'dat',
    'niet',
    'met',
    'voor',
    'dank',
    'goedemorgen',
    'hallo',
    'ik',
    'wij',
  ],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'merhaba', 'teşekkürler', 'çok', 'değil'],
  pl: ['i', 'w', 'nie', 'na', 'to', 'jest', 'się', 'dziękuję', 'cześć', 'dzień'],
};

export interface Detection {
  /** ISO 639-1 code, or 'und' when it cannot be told. */
  language: string;
  confidence: number;
}

export function detectLanguage(text: string): Detection {
  const sample = text.slice(0, 2000);
  const letters = sample.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length < 2) return { language: 'und', confidence: 0 };
  for (const s of SCRIPTS) {
    const hits = (sample.match(new RegExp(s.re.source, 'g')) ?? []).length;
    if (hits / letters.length > 0.3)
      return { language: s.lang, confidence: Math.min(0.99, 0.6 + hits / letters.length / 2) };
  }
  const words = sample.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length === 0) return { language: 'und', confidence: 0 };
  const scores = Object.entries(STOP).map(([lang, list]) => {
    const set = new Set(list);
    return { lang, hits: words.filter((w) => set.has(w)).length };
  });
  scores.sort((a, b) => b.hits - a.hits);
  const best = scores[0]!;
  const second = scores[1]!;
  if (best.hits === 0) return { language: 'und', confidence: 0 };
  const confidence = Math.min(
    0.95,
    0.35 + (best.hits / words.length) * 1.5 + (best.hits - second.hits) * 0.05,
  );
  return { language: best.lang, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * DEV phrasebook: a few everyday phrases, for demonstrations ONLY. Anything outside it is refused by the dev provider
 * (a real provider is required for real translation). Keys are lower-case English phrases.
 */
export const DEV_PHRASEBOOK: Record<string, Record<string, string>> = {
  hello: { es: 'hola', fr: 'bonjour', de: 'hallo', pt: 'olá', it: 'ciao', nl: 'hallo', yo: 'Báwo' },
  'good morning': {
    es: 'buenos días',
    fr: 'bonjour',
    de: 'guten Morgen',
    pt: 'bom dia',
    it: 'buongiorno',
    nl: 'goedemorgen',
    yo: 'Ẹ kú àárọ̀',
  },
  'good night': {
    es: 'buenas noches',
    fr: 'bonne nuit',
    de: 'gute Nacht',
    pt: 'boa noite',
    it: 'buonanotte',
    nl: 'goedenacht',
  },
  'thank you': {
    es: 'gracias',
    fr: 'merci',
    de: 'danke',
    pt: 'obrigado',
    it: 'grazie',
    nl: 'dank je',
    yo: 'Ẹ ṣé',
  },
  'thank you very much': {
    es: 'muchas gracias',
    fr: 'merci beaucoup',
    de: 'vielen Dank',
    pt: 'muito obrigado',
    it: 'grazie mille',
    nl: 'hartelijk bedankt',
  },
  'see you soon': {
    es: 'hasta pronto',
    fr: 'à bientôt',
    de: 'bis bald',
    pt: 'até breve',
    it: 'a presto',
    nl: 'tot snel',
  },
  'see you tomorrow': {
    es: 'hasta mañana',
    fr: 'à demain',
    de: 'bis morgen',
    pt: 'até amanhã',
    it: 'a domani',
    nl: 'tot morgen',
  },
  'how are you': {
    es: '¿cómo estás?',
    fr: 'comment allez-vous ?',
    de: 'wie geht es dir?',
    pt: 'como você está?',
    it: 'come stai?',
    nl: 'hoe gaat het?',
  },
  welcome: {
    es: 'bienvenido',
    fr: 'bienvenue',
    de: 'willkommen',
    pt: 'bem-vindo',
    it: 'benvenuto',
    nl: 'welkom',
  },
  'i love this place': {
    es: 'me encanta este lugar',
    fr: "j'adore cet endroit",
    de: 'ich liebe diesen Ort',
    pt: 'eu amo este lugar',
    it: 'amo questo posto',
    nl: 'ik hou van deze plek',
  },
  'the event starts at noon': {
    es: 'el evento empieza al mediodía',
    fr: "l'événement commence à midi",
    de: 'die Veranstaltung beginnt um zwölf Uhr',
    pt: 'o evento começa ao meio-dia',
    it: "l'evento inizia a mezzogiorno",
  },
};

const REVERSE: Record<string, Record<string, string>> = (() => {
  const out: Record<string, Record<string, string>> = {};
  for (const [en, langs] of Object.entries(DEV_PHRASEBOOK)) {
    for (const [lang, phrase] of Object.entries(langs)) {
      (out[lang] ??= {})[phrase.toLowerCase()] = en;
    }
  }
  return out;
})();

const canon = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.!?¿¡]+$/g, '')
    .replace(/\s+/g, ' ');

/** Phrasebook lookup: en -> X, X -> en, X -> Y via English. Returns null when the phrase is not in the demo book. */
export function phrasebookTranslate(
  text: string,
  source: string | null,
  target: string,
): string | null {
  const t = normalizeLanguage(target);
  if (!t) return null;
  const src = normalizeLanguage(source) ?? detectLanguage(text).language;
  const key = canon(text);
  let en: string | null = null;
  if (src === 'en' || (src === 'und' && DEV_PHRASEBOOK[key])) en = DEV_PHRASEBOOK[key] ? key : null;
  else en = REVERSE[src]?.[key] ?? REVERSE[src]?.[canon(text).replace(/^¿/, '')] ?? null;
  if (!en) {
    // Detection can be wrong for very short phrases: try every language's reverse table.
    for (const table of Object.values(REVERSE))
      if (table[key]) {
        en = table[key]!;
        break;
      }
  }
  if (!en) return null;
  if (t === 'en') return en.charAt(0).toUpperCase() + en.slice(1);
  const out = DEV_PHRASEBOOK[en]?.[t];
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : null;
}
