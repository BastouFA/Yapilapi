import { describe, expect, it } from 'vitest';
import {
  GROUNDEDNESS_MIN,
  NOT_DOCUMENTED,
  contentWords,
  extractiveAnswer,
  groundedness,
  rankKnowledge,
  type KnowledgeItem,
} from './knowledge.js';
import { extractiveSummary } from './summarize.js';

const items: KnowledgeItem[] = [
  {
    id: 'r1',
    kind: 'community_rule',
    title: 'Rule 1: Be kind',
    text: 'Treat every member with respect. No harassment.',
  },
  { id: 'r2', kind: 'community_rule', title: 'Memes', text: 'Memes are allowed on Fridays only.' },
  {
    id: 'd1',
    kind: 'community_decision',
    title: 'Meetup venue',
    question: 'Where do we hold the monthly meetup?',
    text: 'The monthly meetup is held at the Riverside Library, first Saturday of the month.',
  },
  {
    id: 'x1',
    kind: 'community_resource',
    title: 'Starter guide',
    text: 'Read the pinned welcome post and introduce yourself.',
  },
];

describe('knowledge ranking', () => {
  it('stems and drops stop words', () => {
    expect(contentWords('Are people posting memes allowed?')).toEqual(['people', 'post', 'meme']);
  });
  it('finds the documented answer', () => {
    const r = rankKnowledge('Can I post memes on Friday?', items);
    expect(r[0]?.item.id).toBe('r2');
    const m = rankKnowledge('Where is the monthly meetup held?', items);
    expect(m[0]?.item.id).toBe('d1');
  });
  it('returns nothing when the knowledge does not cover the question', () => {
    expect(
      rankKnowledge('What did the moderators decide about the sponsorship budget for 2026?', items),
    ).toEqual([]);
    expect(rankKnowledge('Who is the moderator cat?', items)).toEqual([]);
    expect(rankKnowledge('', items)).toEqual([]);
    expect(rankKnowledge('anything about pizza', [])).toEqual([]);
  });
  it('requires two shared words for longer questions', () => {
    expect(rankKnowledge('respect tomatoes gardening schedule', items)).toEqual([]);
  });
  it('extractive answers quote the source and say when nothing is documented', () => {
    const r = rankKnowledge('Where is the monthly meetup?', items);
    const a = extractiveAnswer(r, 'community');
    expect(a).toContain('Riverside Library');
    expect(a).toContain('recorded community decision');
    expect(extractiveAnswer([], 'community')).toBe(NOT_DOCUMENTED.community);
    expect(extractiveAnswer([], 'business')).toBe(NOT_DOCUMENTED.business);
  });
  it('scores groundedness of answers against sources', () => {
    const q = 'Where is the meetup?';
    const good = 'According to the decision, the monthly meetup is held at the Riverside Library.';
    const bad =
      'The moderators approved a sponsorship budget of ten thousand dollars with Acme Corporation last spring.';
    expect(groundedness(good, q, items)).toBeGreaterThanOrEqual(GROUNDEDNESS_MIN);
    expect(groundedness(bad, q, items)).toBeLessThan(GROUNDEDNESS_MIN);
  });
});

describe('extractive summary', () => {
  it('only uses sentences from the source, in order', () => {
    const text =
      'The market opens at nine. Bring cash because cards are slow. Parking is limited near the market. The market closes at four. Dogs are welcome on leads.';
    const s = extractiveSummary(text, { maxSentences: 2 });
    for (const part of s.split(/(?<=\.)\s+/)) expect(text).toContain(part);
    expect(s.length).toBeLessThan(text.length);
  });
  it('handles empty input', () => {
    expect(extractiveSummary('')).toBe('');
  });
});
