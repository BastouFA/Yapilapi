/**
 * Heuristic plan extractor: turns a group chat into a structured trip/plan draft (destination, dates, budget, transport,
 * accommodation, activities, tasks). Deterministic: the DEV provider uses it for `plan` structured output, and it is the
 * fallback when a live model returns something that does not validate. It only reads the messages it is given (the caller has
 * already authorised them) and invents nothing: fields it cannot find stay empty for the human to fill in.
 */

export interface PlanMessage {
  senderId: string | null;
  senderName?: string | null;
  text: string;
  at?: string | null;
}

export interface PlanDraft {
  title: string;
  destination: string | null;
  startsOn: string | null;
  endsOn: string | null;
  participantIds: string[];
  budget: { amountCents: number; currency: string } | null;
  transport: string[];
  accommodation: string[];
  activities: string[];
  tasks: Array<{ title: string; assigneeId: string | null }>;
  /** Fields nobody mentioned, so the UI can ask. */
  missing: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const CURRENCY: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₦': 'NGN',
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP',
  ngn: 'NGN',
  cad: 'CAD',
  aud: 'AUD',
};

const TRANSPORT = [
  'flight',
  'train',
  'bus',
  'car',
  'rental car',
  'ferry',
  'road trip',
  'carpool',
  'subway',
  'metro',
  'bike',
];
const ACCOMMODATION = [
  'hotel',
  'airbnb',
  'hostel',
  'resort',
  'camping',
  'campsite',
  'cabin',
  'villa',
  'apartment',
  'guesthouse',
  'b&b',
];
const ACTIVITIES = [
  'hike',
  'hiking',
  'museum',
  'beach',
  'snorkeling',
  'snorkelling',
  'diving',
  'concert',
  'festival',
  'dinner',
  'brunch',
  'tour',
  'kayak',
  'kayaking',
  'ski',
  'skiing',
  'party',
  'market',
  'temple',
  'safari',
  'surf',
  'surfing',
  'cycling',
  'spa',
  'shopping',
  'sightseeing',
  'picnic',
  'camping',
  'bbq',
  'karaoke',
  'gallery',
  'zoo',
];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function resolveYear(month: number, day: number, now: Date): number {
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, month - 1, day);
  return candidate < Date.UTC(y, now.getUTCMonth(), now.getUTCDate()) ? y + 1 : y;
}

function findDates(text: string, now: Date): { startsOn: string | null; endsOn: string | null } {
  const isoDates = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map((m) => m[0]);
  if (isoDates.length) {
    const sorted = [...new Set(isoDates)].sort();
    return { startsOn: sorted[0]!, endsOn: sorted.length > 1 ? sorted[sorted.length - 1]! : null };
  }
  // "June 12-15", "June 12 to 15", "Jun 12 - Jun 15"
  let m = new RegExp(
    `\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|until|through)\\s*(?:${MONTH_RE}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`,
    'i',
  ).exec(text);
  if (m) {
    const m1 = MONTHS[m[1]!.toLowerCase()]!;
    const d1 = Number(m[2]);
    const m2 = m[3] ? MONTHS[m[3].toLowerCase()]! : m1;
    const d2 = Number(m[4]);
    const y = resolveYear(m1, d1, now);
    return { startsOn: iso(y, m1, d1), endsOn: iso(m2 < m1 ? y + 1 : y, m2, d2) };
  }
  // "12-15 June"
  m = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|until)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`,
    'i',
  ).exec(text);
  if (m) {
    const mo = MONTHS[m[3]!.toLowerCase()]!;
    const y = resolveYear(mo, Number(m[1]), now);
    return { startsOn: iso(y, mo, Number(m[1])), endsOn: iso(y, mo, Number(m[2])) };
  }
  // single "June 12" / "12 June"
  m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(text) ?? null;
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase()]!;
    return { startsOn: iso(resolveYear(mo, Number(m[2]), now), mo, Number(m[2])), endsOn: null };
  }
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i').exec(text);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()]!;
    return { startsOn: iso(resolveYear(mo, Number(m[1]), now), mo, Number(m[1])), endsOn: null };
  }
  return { startsOn: null, endsOn: null };
}

function findBudget(text: string): PlanDraft['budget'] {
  const re =
    /(?:budget|spend|spending|cost|total|around|about|max|under|up to)[^.\n]{0,30}?(\$|€|£|₦|usd|eur|gbp|ngn|cad|aud)\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k)?|(\d[\d,]*(?:\.\d{1,2})?)\s?(k)?\s?(usd|eur|gbp|ngn|cad|aud)\b[^.\n]{0,20}budget|(\$|€|£|₦)\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k)?\s*(?:each|per person|pp|total|budget)|budget[^.\n]{0,30}?(\d[\d,]*(?:\.\d{1,2})?)\s?(k)?\s?(usd|eur|gbp|ngn|cad|aud)\b/i;
  const m = re.exec(text);
  if (!m) return null;
  const sym = (m[1] ?? m[6] ?? m[7] ?? m[12])!.toLowerCase();
  const raw = (m[2] ?? m[4] ?? m[8] ?? m[10])!;
  const k = m[3] ?? m[5] ?? m[9] ?? m[11];
  const n = Number(raw.replace(/,/g, '')) * (k ? 1000 : 1);
  const currency = CURRENCY[sym];
  if (!currency || !Number.isFinite(n) || n <= 0) return null;
  return { amountCents: Math.round(n * 100), currency };
}

function findDestination(texts: string[]): string | null {
  const counts = new Map<string, number>();
  const re =
    /\b(?:trip|travel(?:l?ing)?|fly(?:ing)?|flights?|go(?:ing)?|drive|driving|visit(?:ing)?|weekend|holiday|vacation|getaway|road ?trip|head(?:ing)?|heading)\s+(?:back\s+)?(?:to|in)\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2})/gu;
  for (const t of texts) {
    for (const m of t.matchAll(re)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  if (!counts.size) {
    const re2 = /\bto\s+([A-Z][\p{L}'’.-]{2,}(?:\s+[A-Z][\p{L}'’.-]+){0,2})/gu;
    for (const t of texts)
      for (const m of t.matchAll(re2)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

const has = (hay: string, word: string) =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(hay);

export function extractPlan(
  messages: PlanMessage[],
  opts: { now?: Date; conversationTitle?: string | null } = {},
): PlanDraft {
  const now = opts.now ?? new Date();
  const texts = messages.map((m) => m.text);
  const all = texts.join('\n');
  const dates = findDates(all, now);
  const destination = findDestination(texts);
  const budget = findBudget(all);
  const transport = TRANSPORT.filter((w) => has(all, w));
  const accommodation = ACCOMMODATION.filter((w) => has(all, w));
  const activities = [...new Set(ACTIVITIES.filter((w) => has(all, w)))];
  const participantIds = [
    ...new Set(messages.map((m) => m.senderId).filter((x): x is string => Boolean(x))),
  ];

  const tasks: PlanDraft['tasks'] = [];
  const seen = new Set<string>();
  const add = (title: string, assigneeId: string | null) => {
    const t = title
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!,;:]+$/, '');
    if (t.length < 3 || t.length > 120) return;
    const key = t.toLowerCase();
    if (seen.has(key) || tasks.length >= 12) return;
    seen.add(key);
    tasks.push({ title: t.charAt(0).toUpperCase() + t.slice(1), assigneeId });
  };
  for (const m of messages) {
    for (const line of m.text.split(/(?<=[.!?])\s+|\n+/)) {
      const own =
        /\b(?:i'?ll|i will|i can|i'?m going to|i got)\s+((?:book|buy|check|find|reserve|pack|drive|bring|order|arrange|handle|sort|get|plan|rent)\b[^.!?]{2,100})/i.exec(
          line,
        );
      if (own) {
        add(own[1]!, m.senderId);
        continue;
      }
      const todo =
        /\b(?:need to|have to|we should|should we|must|let'?s|don'?t forget to|remember to|todo|to-do|can someone|who(?:'s| is) (?:booking|handling|bringing|driving))\s+([^.!?]{3,110})/i.exec(
          line,
        );
      if (todo) add(todo[1]!, null);
    }
  }

  const missing: string[] = [];
  if (!destination) missing.push('destination');
  if (!dates.startsOn) missing.push('dates');
  if (!budget) missing.push('budget');
  if (!transport.length) missing.push('transport');
  if (!accommodation.length) missing.push('accommodation');

  const title = destination
    ? `Trip to ${destination}`
    : opts.conversationTitle?.trim()
      ? `Plan: ${opts.conversationTitle.trim().slice(0, 100)}`
      : 'Plan from our chat';
  return {
    title,
    destination,
    startsOn: dates.startsOn,
    endsOn: dates.endsOn,
    participantIds,
    budget,
    transport,
    accommodation,
    activities,
    tasks,
    missing,
  };
}
