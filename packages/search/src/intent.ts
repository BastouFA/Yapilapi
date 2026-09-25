import { resolveTimeWindow, type TimeLabel } from './timewindow.js';
import type { PriceHint, SearchType, TimeWindow } from './types.js';

/**
 * Deterministic natural-language intent parser for the universal search box. Rules only, no model calls:
 * the result is reproducible, explainable ("interpretedAs") and cheap. The AI module may later add an LLM router
 * that produces the same `ParsedIntent` shape for queries these rules do not understand.
 *
 * "find technology communities"           -> communities, topic technology
 * "restaurants suitable for six people"   -> places (restaurant), partySize 6
 * "events this weekend near me"           -> events, timeWindow this weekend, nearMe
 * anything unrecognised                   -> plain keyword search across all types
 */

export interface ParsedIntent {
  original: string;
  /** `natural_language` when at least one structural signal was recognised, otherwise plain `keyword`. */
  mode: 'natural_language' | 'keyword';
  /** Result types the query is about. Empty = search everything. */
  entityTypes: SearchType[];
  /** Words to match textually (stop words and structural words removed). */
  keywords: string[];
  /** Canonical topic slugs recognised in the query. */
  topics: string[];
  timeWindow: TimeWindow | null;
  partySize: number | null;
  nearMe: boolean;
  priceHint: PriceHint | null;
  /** Place kinds implied by the query ("restaurants" -> restaurant). */
  placeKinds: string[];
  /** True when the query used search syntax (quotes, -exclusions, @handle) and is passed through verbatim. */
  rawSyntax: boolean;
  /** Human readable one-liner shown to the user as "how we read your search". */
  explanation: string;
}

export interface IntentOptions {
  now?: Date;
  /** Viewer's IANA time zone; falls back to UTC. */
  timeZone?: string;
  /** Extra topic vocabulary (e.g. all rows of `topics`) on top of the built-in aliases. */
  topics?: Array<{ slug: string; name: string }>;
}

// ------------------------------------------------------------------ vocab
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
const PARTY_A = new RegExp(
  `\\b(?:for\\s+|of\\s+)?${NUM}\\s+(?:people|persons?|guests?|pax|adults|friends|of us)\\b`,
);
const PARTY_B = new RegExp(
  `\\b(?:party|group|table|booking|reservation)\\s+(?:of|for)\\s+${NUM}\\b`,
);
const PARTY_C = new RegExp(`\\bfor\\s+(?:a\\s+)?(?:group|party)\\s+of\\s+${NUM}\\b`);

const TIME_PHRASES: Array<[RegExp, TimeLabel]> = [
  [/\bnext\s+weekend\b/, 'next weekend'],
  [/\b(?:this|the|over the|on the)\s+weekend\b/, 'this weekend'],
  [/\bweekend\b/, 'this weekend'],
  [/\bnext\s+week\b/, 'next week'],
  [/\b(?:this|the)\s+week\b/, 'this week'],
  [/\b(?:tonight|this\s+evening|later\s+tonight)\b/, 'tonight'],
  [/\btomorrow\b/, 'tomorrow'],
  [/\b(?:today|later\s+today|right\s+now)\b/, 'today'],
];

const NEAR_ME =
  /\b(?:near\s*me|nearby|near\s*by|near\s+here|around\s+me|around\s+here|close\s+to\s+me|close\s*by|in\s+my\s+area|locally|local)\b/;
const CHEAP =
  /\b(?:cheap(?:ly|est)?|affordable|budget|inexpensive|low[\s-]?cost|bargain|under\s+\$?\s?\d+)\b/;
const PREMIUM =
  /\b(?:premium|luxury|luxurious|high[\s-]?end|upscale|fancy|expensive|fine\s+dining)\b/;

/** "things to do"-style discovery phrases. */
const TO_DO =
  /\b(?:things?\s+to\s+do|something\s+(?:\w+\s+)?to\s+do|anything\s+(?:\w+\s+)?to\s+do|what\s+to\s+do|what(?:'|)s\s+on|what\s+is\s+on|places\s+to\s+go|places\s+to\s+visit|somewhere\s+to\s+go|go\s+out|out\s+tonight)\b/;

interface EntityHit {
  types: SearchType[];
  placeKinds?: string[];
}
const ENTITY_PHRASES: Array<[RegExp, EntityHit]> = [
  [/\bcoffee\s+shops?\b/, { types: ['places'], placeKinds: ['restaurant'] }],
  [/\bplaces?\s+to\s+eat\b/, { types: ['places'], placeKinds: ['restaurant'] }],
  [/\bfor\s+sale\b/, { types: ['products'] }],
  [/\bthings?\s+to\s+buy\b/, { types: ['products'] }],
];
const ENTITY_WORDS: Record<string, EntityHit> = {
  people: { types: ['people'] },
  person: { types: ['people'] },
  user: { types: ['people'] },
  account: { types: ['people'] },
  friend: { types: ['people'] },
  member: { types: ['people'] },
  creator: { types: ['creators'] },
  influencer: { types: ['creators'] },
  streamer: { types: ['creators'] },
  vlogger: { types: ['creators'] },
  blogger: { types: ['creators'] },
  teacher: { types: ['creators'] },
  coach: { types: ['creators'] },
  post: { types: ['posts'] },
  thread: { types: ['posts'] },
  discussion: { types: ['posts'] },
  article: { types: ['posts'] },
  video: { types: ['videos'] },
  clip: { types: ['videos'] },
  vlog: { types: ['videos'] },
  community: { types: ['communities'] },
  group: { types: ['communities'] },
  club: { types: ['communities'] },
  forum: { types: ['communities'] },
  event: { types: ['events'] },
  meetup: { types: ['events'] },
  gig: { types: ['events'] },
  concert: { types: ['events'] },
  festival: { types: ['events'] },
  workshop: { types: ['events'] },
  webinar: { types: ['events'] },
  conference: { types: ['events'] },
  party: { types: ['events'] },
  place: { types: ['places'] },
  spot: { types: ['places'] },
  restaurant: { types: ['places'], placeKinds: ['restaurant'] },
  cafe: { types: ['places'], placeKinds: ['restaurant'] },
  bar: { types: ['places'], placeKinds: ['restaurant'] },
  pub: { types: ['places'], placeKinds: ['restaurant'] },
  diner: { types: ['places'], placeKinds: ['restaurant'] },
  eatery: { types: ['places'], placeKinds: ['restaurant'] },
  store: { types: ['places'], placeKinds: ['store'] },
  shop: { types: ['places'], placeKinds: ['store'] },
  venue: { types: ['places'], placeKinds: ['venue'] },
  museum: { types: ['places'], placeKinds: ['attraction'] },
  park: { types: ['places'], placeKinds: ['attraction'] },
  attraction: { types: ['places'], placeKinds: ['attraction'] },
  landmark: { types: ['places'], placeKinds: ['attraction'] },
  gallery: { types: ['places'], placeKinds: ['attraction'] },
  salon: { types: ['places'], placeKinds: ['service'] },
  gym: { types: ['places'], placeKinds: ['service'] },
  spa: { types: ['places'], placeKinds: ['service'] },
  barber: { types: ['places'], placeKinds: ['service'] },
  business: { types: ['businesses'] },
  company: { types: ['businesses'] },
  brand: { types: ['businesses'] },
  agency: { types: ['businesses'] },
  product: { types: ['products'] },
  item: { types: ['products'] },
  merch: { types: ['products'] },
  topic: { types: ['topics'] },
  hashtag: { types: ['topics'] },
  tag: { types: ['topics'] },
};

/** Words that carry no search value once the structure has been extracted. */
const STOP = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'is',
  'are',
  'was',
  'be',
  'it',
  'its',
  'as',
  'by',
  'with',
  'from',
  'into',
  'find',
  'show',
  'search',
  'searching',
  'looking',
  'look',
  'get',
  'want',
  'need',
  'give',
  'list',
  'discover',
  'recommend',
  'suggest',
  'me',
  'my',
  'us',
  'i',
  'we',
  'you',
  'some',
  'any',
  'all',
  'please',
  'can',
  'could',
  'would',
  'who',
  'that',
  'which',
  'what',
  'where',
  'when',
  'whats',
  "what's",
  'there',
  'here',
  'something',
  'anything',
  'someone',
  'somewhere',
  'good',
  'great',
  'best',
  'nice',
  'interesting',
  'fun',
  'cool',
  'awesome',
  'popular',
  'top',
  'suitable',
  'ideal',
  'perfect',
  'do',
  'doing',
  'go',
  'going',
  'about',
  'around',
  'this',
  'these',
  'those',
  'really',
  'very',
  'like',
]);
/** Smaller stop list for plain keyword mode (only glue words). */
const GLUE = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'is', 'are']);

const TOPIC_ALIASES: Record<string, string[]> = {
  technology: ['technology', 'tech', 'technologies'],
  cybersecurity: ['cybersecurity', 'cyber security', 'infosec', 'security'],
  business: ['business'],
  entrepreneurship: ['entrepreneurship', 'entrepreneur', 'entrepreneurs'],
  finance: ['finance', 'investing', 'investment', 'investments', 'money'],
  education: ['education', 'learning', 'school', 'schools'],
  science: ['science', 'sciences'],
  health: ['health', 'wellness', 'wellbeing'],
  fitness: ['fitness', 'workout', 'workouts', 'exercise', 'yoga'],
  food: ['food', 'cooking', 'recipes', 'recipe', 'foodie', 'foodies', 'baking'],
  travel: ['travel', 'travelling', 'traveling', 'trips'],
  music: ['music', 'songs', 'musicians'],
  'film-tv': ['film', 'films', 'movies', 'movie', 'cinema', 'tv', 'television'],
  gaming: ['gaming', 'games', 'gamers', 'esports'],
  sports: ['sports', 'sport'],
  football: ['football', 'soccer'],
  fashion: ['fashion', 'style'],
  beauty: ['beauty', 'makeup', 'skincare'],
  art: ['art', 'design', 'illustration'],
  photography: ['photography', 'photos', 'photographers'],
  writing: ['writing', 'books', 'reading', 'authors', 'poetry'],
  comedy: ['comedy', 'humor', 'humour', 'standup', 'stand-up'],
  news: ['news', 'current affairs'],
  politics: ['politics', 'political'],
  faith: ['faith', 'spirituality', 'religion'],
  parenting: ['parenting', 'parents', 'family'],
  pets: ['pets', 'animals', 'dogs', 'cats'],
  nature: ['nature', 'outdoors', 'hiking', 'camping'],
  cars: ['cars', 'automotive', 'mobility'],
  'home-garden': ['gardening', 'garden', 'home improvement'],
  careers: ['careers', 'career', 'jobs', 'hiring'],
  startups: ['startups', 'startup'],
  languages: ['languages', 'language learning'],
  'local-events': ['local events'],
  'diy-crafts': ['diy', 'crafts', 'crafting'],
  'mental-health': ['mental health', 'therapy', 'mindfulness'],
};

// ------------------------------------------------------------------ helpers
const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}#@_\s'$-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`; // communities -> community
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2); // businesses -> business
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function numberValue(tok: string): number | null {
  const n = /^\d+$/.test(tok) ? Number(tok) : NUMBER_WORDS[tok];
  return n && n >= 1 && n <= 500 ? n : null;
}

interface TopicIndex {
  phrases: Array<{ phrase: string[]; slug: string }>;
}
function buildTopicIndex(extra: IntentOptions['topics']): TopicIndex {
  const map = new Map<string, string>();
  for (const [slug, aliases] of Object.entries(TOPIC_ALIASES))
    for (const a of aliases) map.set(a, slug);
  for (const t of extra ?? []) {
    map.set(t.slug.toLowerCase().replace(/-/g, ' '), t.slug.toLowerCase());
    map.set(normalise(t.name), t.slug.toLowerCase());
  }
  const phrases = [...map.entries()]
    .map(([p, slug]) => ({ phrase: p.split(' '), slug }))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  return { phrases };
}

/** Find topic phrases in a token stream (longest match first). Tokens are compared raw and singularised. */
function findTopics(tokens: string[], idx: TopicIndex): string[] {
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const { phrase, slug } of idx.phrases) {
      if (i + phrase.length > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < phrase.length; j++) {
        const t = tokens[i + j]!;
        if (t !== phrase[j] && singular(t) !== phrase[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        if (!found.includes(slug)) found.push(slug);
        i += phrase.length - 1;
        break;
      }
    }
  }
  return found;
}

const uniq = <T>(a: T[]) => [...new Set(a)];

function explain(i: Omit<ParsedIntent, 'explanation'>): string {
  if (i.rawSyntax) return 'Searching for exactly what you typed';
  if (i.mode === 'keyword')
    return i.topics.length
      ? `Keyword search (topic: ${i.topics.join(', ')})`
      : 'Keyword search across everything';
  const bits: string[] = [];
  bits.push(
    i.entityTypes.length ? `Looking for ${i.entityTypes.join(' and ')}` : 'Looking for anything',
  );
  if (i.placeKinds.length) bits.push(`of kind ${i.placeKinds.join(' / ')}`);
  if (i.topics.length) bits.push(`about ${i.topics.join(', ')}`);
  if (i.keywords.length) bits.push(`matching "${i.keywords.join(' ')}"`);
  if (i.timeWindow) bits.push(i.timeWindow.label);
  if (i.partySize) bits.push(`for ${i.partySize} people`);
  if (i.nearMe) bits.push('near you');
  if (i.priceHint) bits.push(i.priceHint === 'cheap' ? 'budget-friendly' : 'premium');
  return bits.join(', ');
}

// ------------------------------------------------------------------ parser
export function parseIntent(query: string, opts: IntentOptions = {}): ParsedIntent {
  const original = query;
  const base = {
    original,
    mode: 'keyword' as ParsedIntent['mode'],
    entityTypes: [] as SearchType[],
    keywords: [] as string[],
    topics: [] as string[],
    timeWindow: null as TimeWindow | null,
    partySize: null as number | null,
    nearMe: false,
    priceHint: null as PriceHint | null,
    placeKinds: [] as string[],
    rawSyntax: false,
  };
  const finish = (i: typeof base): ParsedIntent => ({ ...i, explanation: explain(i) });

  const trimmed = query.trim();
  if (!trimmed) return finish(base);

  // Search syntax is passed through untouched: "exact phrase", -excluded, @handle, #topic.
  if (/["]/.test(trimmed) || /(^|\s)-\w/.test(trimmed))
    return finish({ ...base, keywords: [trimmed], rawSyntax: true });
  if (trimmed.startsWith('@')) {
    const handle = normalise(trimmed.slice(1)).replace(/[^a-z0-9_]/g, '');
    return finish({
      ...base,
      entityTypes: ['people', 'creators'],
      keywords: handle ? [handle] : [],
      rawSyntax: true,
    });
  }
  if (trimmed.startsWith('#')) {
    const tag = normalise(trimmed.slice(1)).replace(/[^a-z0-9]/g, '');
    const idx = buildTopicIndex(opts.topics);
    const topics = tag ? findTopics([tag], idx) : [];
    return finish({
      ...base,
      entityTypes: ['posts', 'videos', 'topics', 'communities'],
      keywords: tag ? [tag] : [],
      topics,
      rawSyntax: true,
    });
  }

  let text = ` ${normalise(trimmed)} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(text);
    if (m) text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
    return m;
  };

  // 1. party size
  let partySize: number | null = null;
  const pm = take(PARTY_C) ?? take(PARTY_B) ?? take(PARTY_A);
  if (pm) partySize = numberValue(pm[1]!);

  // 2. time
  let timeWindow: TimeWindow | null = null;
  for (const [re, label] of TIME_PHRASES) {
    if (take(re)) {
      timeWindow = resolveTimeWindow(label, opts.now ?? new Date(), opts.timeZone ?? 'UTC');
      break;
    }
  }

  // 3. near me, price
  const nearMe = Boolean(take(NEAR_ME));
  let priceHint: PriceHint | null = null;
  if (take(CHEAP)) priceHint = 'cheap';
  else if (take(PREMIUM)) priceHint = 'premium';

  // 4. entities
  const entityTypes: SearchType[] = [];
  const placeKinds: string[] = [];
  const addEntity = (h: EntityHit) => {
    for (const t of h.types) if (!entityTypes.includes(t)) entityTypes.push(t);
    for (const k of h.placeKinds ?? []) if (!placeKinds.includes(k)) placeKinds.push(k);
  };
  if (take(TO_DO)) {
    addEntity({ types: ['events', 'places'] });
    for (const k of ['venue', 'attraction', 'restaurant']) placeKinds.push(k);
  }
  for (const [re, hit] of ENTITY_PHRASES) if (take(re)) addEntity(hit);

  const rest = text.split(' ').filter(Boolean);
  const leftover: string[] = [];
  for (const tok of rest) {
    const hit = ENTITY_WORDS[tok] ?? ENTITY_WORDS[singular(tok)];
    if (hit) addEntity(hit);
    else leftover.push(tok);
  }

  // 5. topics (matched on what remains, but topic words stay in the keywords so text matching still works)
  const idx = buildTopicIndex(opts.topics);
  const topics = findTopics(leftover, idx);

  const structural =
    entityTypes.length > 0 ||
    timeWindow !== null ||
    partySize !== null ||
    nearMe ||
    priceHint !== null ||
    placeKinds.length > 0;

  // 6. keywords
  const clean = (tok: string) => tok.replace(/^[#@'$-]+|['-]+$/g, '');
  let keywords: string[];
  if (structural) {
    keywords = leftover
      .map(clean)
      .filter(
        (t) => t && !STOP.has(t) && !/^\d+$/.test(t) && !(t in NUMBER_WORDS && partySize !== null),
      );
  } else {
    // Plain keyword search keeps everything the user typed except glue words.
    const all = normalise(trimmed).split(' ').map(clean).filter(Boolean);
    const noGlue = all.filter((t) => !GLUE.has(t));
    keywords = noGlue.length ? noGlue : all;
  }
  keywords = uniq(keywords).slice(0, 12);

  return finish({
    ...base,
    mode: structural ? 'natural_language' : 'keyword',
    entityTypes,
    keywords,
    topics,
    timeWindow,
    partySize,
    nearMe,
    priceHint,
    placeKinds: uniq(placeKinds),
  });
}

/** Type of a pluggable parser (a future LLM router only has to satisfy this). */
export type IntentParser = (
  query: string,
  opts?: IntentOptions,
) => ParsedIntent | Promise<ParsedIntent>;
