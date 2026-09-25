/**
 * Grounded answering for Community and Business AI.
 *
 * Rule: these assistants answer ONLY from human-authored, approved knowledge. Retrieval is lexical and deterministic
 * (so "nothing documented" is decided by code, not by a model), the answer is checked for groundedness afterwards, and
 * when nothing relevant exists we say so instead of guessing. A model can phrase an answer; it can never widen it.
 */

export type KnowledgeKind =
  'community_rule' | 'community_resource' | 'community_decision' | 'business_knowledge';

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  title: string;
  text: string;
  url?: string | null;
  /** community decisions: the question it answered */
  question?: string | null;
  createdAt?: string | null;
}

const STOP = new Set(
  (
    'a an the and or but if then else of to in on at by for with from into over under about as is are was were be been being am do does did done can could ' +
    'should would will shall may might must have has had having i me my we us our you your he she it its they them their this that these those there here ' +
    'what which who whom whose when where why how not no yes so than too very just also please tell know need want get got any some any all more most ' +
    'community group page business shop store rule rules policy policies allowed allow anyone someone something anything decided decision decisions ' +
    'say says said document documented documents docs regarding whether like one ok okay hi hello thanks thank'
  ).split(/\s+/),
);

/** Lower-case content words with light stemming (plural/-ing/-ed) so "posting" matches "post". */
export function contentWords(text: string): string[] {
  const words =
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|x|z|ch|sh|o)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export interface RankedKnowledge {
  item: KnowledgeItem;
  score: number;
  matched: string[];
}

export interface RankOptions {
  max?: number;
  minScore?: number;
}

/**
 * Score = weighted share of the question's content words found in the entry (title and question count double).
 * A question with three or more content words must match at least two of them: one shared word ("moderator") is not an answer.
 */
export function rankKnowledge(
  question: string,
  items: KnowledgeItem[],
  opts: RankOptions = {},
): RankedKnowledge[] {
  const q = [...new Set(contentWords(question))];
  if (q.length === 0) return [];
  const need = q.length >= 3 ? 2 : 1;
  const ranked: RankedKnowledge[] = [];
  for (const item of items) {
    const head = new Set(contentWords(`${item.title} ${item.question ?? ''}`));
    const body = new Set(contentWords(item.text));
    const matched: string[] = [];
    let weight = 0;
    for (const w of q) {
      const inHead = head.has(w);
      const inBody = body.has(w);
      if (inHead || inBody) {
        matched.push(w);
        weight += inHead ? 1 : 0.85;
      }
    }
    if (matched.length < need) continue;
    const score = weight / q.length;
    if (score >= (opts.minScore ?? 0.4)) ranked.push({ item, score, matched });
  }
  ranked.sort(
    (a, b) => b.score - a.score || (b.item.createdAt ?? '').localeCompare(a.item.createdAt ?? ''),
  );
  return ranked.slice(0, opts.max ?? 4);
}

export const NOT_DOCUMENTED = {
  community:
    "Nothing is documented about that in this community's rules, resources or recorded decisions, so I can't answer it. A moderator can tell you, and they may want to document the answer.",
  business:
    "I don't have approved information about that. Please contact the business directly for an answer.",
} as const;

const KIND_LABEL: Record<KnowledgeKind, string> = {
  community_rule: 'community rule',
  community_resource: 'community resource',
  community_decision: 'recorded community decision',
  business_knowledge: 'business information',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Extractive answer: quotes the best entries verbatim. Used by the dev provider and as the fallback when a model strays. */
export function extractiveAnswer(
  ranked: RankedKnowledge[],
  scope: 'community' | 'business',
): string {
  if (!ranked.length) return NOT_DOCUMENTED[scope];
  const lines = ranked.slice(0, 2).map((r) => {
    const head = r.item.question ? `${r.item.question} ` : '';
    return `From the ${KIND_LABEL[r.item.kind]} "${clip(r.item.title, 80)}": ${head}${clip(r.item.text.replace(/\s+/g, ' ').trim(), 500)}`;
  });
  return lines.join('\n\n');
}

const SCAFFOLD = new Set(
  'according based documented recorded following states stated says listed mentioned above below answer details information'.split(
    ' ',
  ),
);

/**
 * Share of the answer's content words that appear in the sources (or the question). Real models get checked against this:
 * a low score means the answer contains claims the knowledge does not support.
 */
export function groundedness(answer: string, question: string, sources: KnowledgeItem[]): number {
  const known = new Set<string>();
  for (const s of sources)
    for (const w of contentWords(`${s.title} ${s.question ?? ''} ${s.text}`)) known.add(w);
  for (const w of contentWords(question)) known.add(w);
  const words = contentWords(answer).filter((w) => w.length >= 4 && !SCAFFOLD.has(w));
  if (words.length === 0) return 1;
  const ok = words.filter((w) => known.has(w)).length;
  return ok / words.length;
}

export const GROUNDEDNESS_MIN = 0.6;
