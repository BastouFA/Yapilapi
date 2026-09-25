/**
 * Rule-based natural-language search intent. Used directly by search and as the
 * dev provider's answer for the search_intent task. A model can refine it, but
 * search always works without one.
 */
export interface SearchIntent {
  types: ('people' | 'posts' | 'communities' | 'events' | 'places' | 'businesses' | 'products' | 'topics')[];
  terms: string;
  when?: { from: string; to: string; label: string };
  placeCategory?: 'restaurant' | 'store' | 'venue' | 'attraction' | 'service';
  groupSize?: number;
  creatorsOnly?: boolean;
}

const STOP = new Set([
  'find',
  'show',
  'me',
  'something',
  'some',
  'a',
  'an',
  'the',
  'to',
  'do',
  'for',
  'of',
  'in',
  'on',
  'at',
  'with',
  'who',
  'that',
  'is',
  'are',
  'interesting',
  'good',
  'best',
  'nearby',
  'near',
  'suitable',
  'people',
  'person',
  'looking',
  'i',
  'want',
  'what',
  'can',
  'tonight',
  'today',
  'tomorrow',
  'weekend',
  'this',
  'next',
  'week',
  'communities',
  'community',
  'groups',
  'group',
  'events',
  'event',
  'restaurants',
  'restaurant',
  'places',
  'place',
  'creators',
  'creator',
  'products',
  'product',
  'teach',
  'teaches',
  'about',
  'on',
  'and',
  'or',
  'go',
  'things',
]);

export function parseSearchIntent(q: string, now = new Date()): SearchIntent {
  const text = q.toLowerCase();
  const intent: SearchIntent = { types: [], terms: '' };
  const day = (offset: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
  };

  if (/\btonight\b/.test(text)) {
    const from = new Date(now);
    const to = day(1);
    to.setHours(4);
    intent.when = { from: from.toISOString(), to: to.toISOString(), label: 'tonight' };
  } else if (/\btoday\b/.test(text)) intent.when = { from: now.toISOString(), to: day(1).toISOString(), label: 'today' };
  else if (/\btomorrow\b/.test(text)) intent.when = { from: day(1).toISOString(), to: day(2).toISOString(), label: 'tomorrow' };
  else if (/\b(this )?weekend\b/.test(text)) {
    const sat = day((6 - now.getDay() + 7) % 7);
    intent.when = { from: sat.toISOString(), to: new Date(sat.getTime() + 2 * 86400_000).toISOString(), label: 'this weekend' };
  } else if (/\bnext week\b/.test(text)) intent.when = { from: day(7).toISOString(), to: day(14).toISOString(), label: 'next week' };

  if (/\b(something|things?) to do\b|\bevents?\b|\bhappening\b|\bgoing on\b/.test(text) || intent.when) intent.types.push('events');
  if (/\bcommunit(y|ies)\b|\bgroups?\b|\bclubs?\b/.test(text)) intent.types.push('communities');
  if (/\brestaurants?\b|\beat\b|\bdinner\b|\blunch\b|\bfood\b/.test(text)) {
    intent.types.push('places');
    if (/\brestaurants?\b|\bdinner\b|\blunch\b|\beat\b/.test(text)) intent.placeCategory = 'restaurant';
  }
  if (/\bstores?\b|\bshops?\b/.test(text)) {
    intent.types.push('places');
    intent.placeCategory = 'store';
  }
  if (/\bvenues?\b/.test(text)) {
    intent.types.push('places');
    intent.placeCategory = 'venue';
  }
  if (/\bcreators?\b|\bwho teach(es)?\b|\binfluencers?\b/.test(text)) {
    intent.types.push('people');
    intent.creatorsOnly = true;
  }
  const groupPhrase = /\b(?:for|of)\s+(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|persons|guests)\b/.test(text);
  if (!groupPhrase && /\bpeople\b|\bfriends\b|\bperson\b/.test(text)) intent.types.push('people');
  if (/\bbuy\b|\bproducts?\b|\bshopping\b/.test(text)) intent.types.push('products');
  if (/\bbusiness(es)?\b|\bcompan(y|ies)\b/.test(text)) intent.types.push('businesses');

  const size = text.match(/\b(?:for|of)\s+(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|persons|guests)?/);
  if (size) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    intent.groupSize = Number(size[1]) || words[size[1]!];
  }

  intent.types = [...new Set(intent.types)];
  intent.terms = text
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && !['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].includes(w))
    .join(' ')
    .trim();
  return intent;
}
