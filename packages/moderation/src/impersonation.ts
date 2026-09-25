/**
 * Impersonation check: how confusable is a candidate username / display name with an identity that deserves
 * protection (verified businesses, staff, verified creators, reserved brand terms)?
 *
 * Pure and unit tested. It only produces a similarity assessment; what to do with it (block a registration, open a
 * moderation case) is the caller's decision.
 */

export interface ProtectedIdentity {
  id: string;
  /** What the identity is, for the explanation only. */
  kind: 'business' | 'staff' | 'creator' | 'reserved';
  username?: string | null;
  displayName?: string | null;
}

export interface ImpersonationMatch {
  identityId: string;
  kind: ProtectedIdentity['kind'];
  field: 'username' | 'displayName';
  score: number;
  reason: 'exact_after_normalization' | 'lookalike' | 'contains_protected_name' | 'edit_distance';
}

export interface ImpersonationResult {
  risk: 'none' | 'low' | 'high';
  best: ImpersonationMatch | null;
  matches: ImpersonationMatch[];
}

/** Characters that are commonly swapped to fake a name. Applied after lowercasing. */
const HOMOGLYPHS: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  $: 's',
  '@': 'a',
  '!': 'i',
  // Cyrillic / Greek lookalikes
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ѕ: 's',
  ο: 'o',
  α: 'a',
};

/** Canonical "skeleton" of a name: lowercase, homoglyphs folded, separators removed, repeated letters collapsed. */
export function skeleton(input: string): string {
  let s = input.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = [...s].map((ch) => HOMOGLYPHS[ch] ?? ch).join('');
  s = s.replace(/rn/g, 'm').replace(/vv/g, 'w');
  s = s.replace(/[^a-z]/g, '');
  return s.replace(/(.)\1+/g, '$1');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 0..1, where 1 is identical. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

const MIN_LEN = 4; // very short names collide by chance

function compare(
  candidate: string,
  protectedName: string,
  field: ImpersonationMatch['field'],
  id: ProtectedIdentity,
): ImpersonationMatch | null {
  const cs = skeleton(candidate);
  const ps = skeleton(protectedName);
  if (cs.length < MIN_LEN || ps.length < MIN_LEN) return null;
  const rawEqual = candidate.trim().toLowerCase() === protectedName.trim().toLowerCase();
  if (rawEqual) return null; // the identity itself (or an identical claim that uniqueness rules already handle)
  if (cs === ps) {
    const literal =
      candidate.toLowerCase().replace(/[^a-z]/g, '') ===
      protectedName.toLowerCase().replace(/[^a-z]/g, '');
    return {
      identityId: id.id,
      kind: id.kind,
      field,
      score: 1,
      reason: literal ? 'exact_after_normalization' : 'lookalike',
    };
  }
  if (ps.length >= 6 && cs.includes(ps) && cs.length <= ps.length + 14) {
    return {
      identityId: id.id,
      kind: id.kind,
      field,
      score: 0.9,
      reason: 'contains_protected_name',
    };
  }
  const sim = similarity(cs, ps);
  if (sim >= 0.85 && Math.min(cs.length, ps.length) >= 6) {
    return {
      identityId: id.id,
      kind: id.kind,
      field,
      score: Number(sim.toFixed(3)),
      reason: 'edit_distance',
    };
  }
  return null;
}

export function checkImpersonation(
  candidate: { username?: string | null; displayName?: string | null },
  protectedIdentities: readonly ProtectedIdentity[],
  opts: { exclude?: ReadonlySet<string> } = {},
): ImpersonationResult {
  const matches: ImpersonationMatch[] = [];
  for (const id of protectedIdentities) {
    if (opts.exclude?.has(id.id)) continue;
    const pairs: Array<
      [string | null | undefined, string | null | undefined, ImpersonationMatch['field']]
    > = [
      [candidate.username, id.username, 'username'],
      [candidate.displayName, id.displayName, 'displayName'],
      [candidate.username, id.displayName, 'username'],
      [candidate.displayName, id.username, 'displayName'],
    ];
    for (const [c, p, field] of pairs) {
      if (!c || !p) continue;
      const m = compare(c, p, field, id);
      if (m) matches.push(m);
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0] ?? null;
  const risk = !best ? 'none' : best.score >= 0.9 ? 'high' : 'low';
  return { risk, best, matches: matches.slice(0, 5) };
}
