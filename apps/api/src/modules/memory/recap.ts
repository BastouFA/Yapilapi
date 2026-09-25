/** Deterministic, non-AI recap of a memory (pure, unit tested): counts, date span, places and people. Same input, same output. */
export interface RecapItem {
  type: string;
  at: Date | null;
  placeId?: string | null | undefined;
}
export interface Recap {
  total: number;
  counts: Record<string, number>;
  dateStart: string | null;
  dateEnd: string | null;
  /** Inclusive number of calendar days from first to last item (UTC), 0 when no dates. */
  spanDays: number;
  places: number;
  people: number;
}

const LABEL: Record<string, [string, string]> = {
  post: ['post', 'posts'],
  moment: ['moment', 'moments'],
  media: ['file', 'files'],
  event: ['event', 'events'],
  real_capture: ['Real', 'Reals'],
  experience: ['shared experience', 'shared experiences'],
  message: ['message', 'messages'],
};
const ORDER = ['post', 'moment', 'real_capture', 'media', 'event', 'experience', 'message'];
const day = (d: Date) => d.toISOString().slice(0, 10);

export function buildRecap(
  items: RecapItem[],
  opts: { extraPlaceIds?: string[]; peopleCount?: number } = {},
): Recap {
  const counts: Record<string, number> = {};
  const places = new Set<string>(opts.extraPlaceIds ?? []);
  let min: number | null = null;
  let max: number | null = null;
  for (const it of items) {
    counts[it.type] = (counts[it.type] ?? 0) + 1;
    if (it.placeId) places.add(it.placeId);
    if (it.at && !Number.isNaN(it.at.getTime())) {
      const t = it.at.getTime();
      if (min === null || t < min) min = t;
      if (max === null || t > max) max = t;
    }
  }
  const dateStart = min === null ? null : day(new Date(min));
  const dateEnd = max === null ? null : day(new Date(max));
  const spanDays =
    min === null || max === null
      ? 0
      : Math.round((Date.UTC(...ymd(dateEnd!)) - Date.UTC(...ymd(dateStart!))) / 86_400_000) + 1;
  return {
    total: items.length,
    counts,
    dateStart,
    dateEnd,
    spanDays,
    places: places.size,
    people: opts.peopleCount ?? 0,
  };
}

function ymd(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** One plain sentence. Clients may render their own text from the structure; this is the default the "apply" action saves. */
export function recapText(r: Recap): string {
  if (r.total === 0) return 'An empty memory.';
  const parts = ORDER.filter((t) => r.counts[t]).map(
    (t) => `${r.counts[t]} ${LABEL[t]![r.counts[t] === 1 ? 0 : 1]}`,
  );
  const span =
    r.dateStart === null
      ? ''
      : r.dateStart === r.dateEnd
        ? ` on ${r.dateStart}`
        : ` from ${r.dateStart} to ${r.dateEnd} (${r.spanDays} days)`;
  const extra = [
    r.places ? `${r.places} ${r.places === 1 ? 'place' : 'places'}` : '',
    r.people ? `${r.people} ${r.people === 1 ? 'person' : 'people'}` : '',
  ].filter(Boolean);
  return `${r.total} ${r.total === 1 ? 'item' : 'items'}${span}: ${parts.join(', ')}.${extra.length ? ` ${extra.join(' and ')}.` : ''}`;
}
