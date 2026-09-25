import { describe, expect, it } from 'vitest';
import { diversify, rank, scoreCandidate, type Candidate } from './index.js';

const base: Candidate = {
  id: 'p',
  authorId: 'a',
  authorUsername: 'alice',
  ageHours: 1,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  saveCount: 0,
  isFollowing: false,
  isFriend: false,
  inMyCommunity: false,
  matchedTopics: [],
  lessLikeThisAuthor: false,
};
const c = (o: Partial<Candidate>): Candidate => ({ ...base, ...o });

describe('scoreCandidate', () => {
  it('ranks friends above followed above strangers, all else equal', () => {
    const f = scoreCandidate(c({ isFriend: true })).score;
    const fo = scoreCandidate(c({ isFollowing: true })).score;
    const s = scoreCandidate(c({})).score;
    expect(f).toBeGreaterThan(fo);
    expect(fo).toBeGreaterThan(s);
  });
  it('decays with age', () => {
    expect(scoreCandidate(c({ ageHours: 1 })).score).toBeGreaterThan(
      scoreCandidate(c({ ageHours: 100 })).score,
    );
  });
  it('rewards topic matches (capped) and engagement (sub-linear)', () => {
    const t3 = scoreCandidate(c({ matchedTopics: ['a', 'b', 'c'] })).score;
    const t9 = scoreCandidate(c({ matchedTopics: ['a', 'b', 'c', 'd', 'e', 'f'] })).score;
    expect(t9).toBeCloseTo(t3, 6);
    const e10 = scoreCandidate(c({ likeCount: 10 })).score;
    const e1000 = scoreCandidate(c({ likeCount: 1000 })).score;
    expect(e1000 - e10).toBeLessThan(e10 * 3);
  });
  it('penalizes "less like this" authors and explains itself', () => {
    const r = scoreCandidate(c({ isFollowing: true, lessLikeThisAuthor: true }));
    expect(r.score).toBeLessThan(scoreCandidate(c({ isFollowing: true })).score);
    expect(r.reasons.some((x) => x.includes('less like this'))).toBe(true);
    expect(scoreCandidate(c({ isFriend: true })).reasons[0]).toContain('@alice');
  });
});

describe('diversify / rank', () => {
  it('never shows more than 2 in a row from one author when alternatives exist', () => {
    const items = ['a', 'a', 'a', 'a', 'b', 'c'].map((authorId, i) => ({
      authorId,
      id: String(i),
    }));
    const out = diversify(items, 2);
    for (let i = 2; i < out.length; i++) {
      expect(
        out[i]!.authorId === out[i - 1]!.authorId && out[i]!.authorId === out[i - 2]!.authorId,
      ).toBe(false);
    }
    expect(out.map((x) => x.id).sort()).toEqual(items.map((x) => x.id).sort());
  });
  it('is deterministic and keeps every candidate', () => {
    const cands = Array.from({ length: 30 }, (_, i) =>
      c({ id: `p${i}`, authorId: `a${i % 4}`, likeCount: i, ageHours: i }),
    );
    const r1 = rank(cands).map((x) => x.id);
    const r2 = rank([...cands].reverse()).map((x) => x.id);
    expect(r1).toEqual(r2);
    expect(r1.length).toBe(30);
  });
});
