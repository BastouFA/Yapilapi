import { describe, expect, it } from 'vitest';
import { AGENTS, AGENT_IDS, getAgent, renderSystemPrompt } from './agents.js';
import { ContextBundle, renderContext } from './context.js';
import {
  detectLanguage,
  languageFromName,
  normalizeLanguage,
  phrasebookTranslate,
} from './language.js';
import { extractMemoryCandidates } from './memory-extract.js';
import { extractPlan } from './plan-extract.js';
import {
  PlanPayloadSchema,
  TOOL_NAMES,
  TOOL_SPECS,
  assertNoMutatingTools,
  toolDescriptor,
} from './tools.js';
import { estimateCostMicros, estimateTokens } from './tokens.js';

describe('language helpers', () => {
  it('detects common languages and scripts', () => {
    expect(
      detectLanguage('Hello, how are you? This is what we have for the weekend.').language,
    ).toBe('en');
    expect(
      detectLanguage('Hola, gracias por la invitación para el evento de los amigos').language,
    ).toBe('es');
    expect(
      detectLanguage('Bonjour, merci pour votre message et pour les photos dans le groupe')
        .language,
    ).toBe('fr');
    expect(
      detectLanguage('Guten Morgen, ich danke euch für die Einladung und das Essen').language,
    ).toBe('de');
    expect(detectLanguage('Привет, как дела у вас сегодня').language).toBe('ru');
    expect(detectLanguage('今日はいい天気ですね、ひらがなも使います').language).toBe('ja');
    expect(detectLanguage('12345 !!!').language).toBe('und');
  });
  it('normalises tags and names', () => {
    expect(normalizeLanguage('pt-BR')).toBe('pt');
    expect(normalizeLanguage('EN_us')).toBe('en');
    expect(normalizeLanguage('not a tag!')).toBeNull();
    expect(languageFromName('Spanish')).toBe('es');
    expect(languageFromName('fr')).toBe('fr');
  });
  it('phrasebook is demonstration-only', () => {
    expect(phrasebookTranslate('Good morning', 'en', 'fr')).toBe('Bonjour');
    expect(phrasebookTranslate('gracias', 'es', 'fr')).toBe('Merci');
    expect(phrasebookTranslate('Quantum chromodynamics', 'en', 'fr')).toBeNull();
  });
});

describe('plan extraction', () => {
  const now = new Date('2026-05-01T00:00:00Z');
  const msgs = [
    { senderId: 'u1', text: "Let's do a trip to Lisbon! Maybe June 12-15?" },
    {
      senderId: 'u2',
      text: 'Budget is around $600 each. We could take the train and stay in an Airbnb.',
    },
    {
      senderId: 'u3',
      text: "I'll book the airbnb. We should rent bikes and go hiking, also a museum day.",
    },
    { senderId: 'u1', text: "Don't forget to renew passports." },
  ];
  it('extracts a structured draft and invents nothing', () => {
    const p = extractPlan(msgs, { now });
    expect(p.destination).toBe('Lisbon');
    expect(p.startsOn).toBe('2026-06-12');
    expect(p.endsOn).toBe('2026-06-15');
    expect(p.budget).toEqual({ amountCents: 60000, currency: 'USD' });
    expect(p.transport).toContain('train');
    expect(p.accommodation).toContain('airbnb');
    expect(p.activities).toEqual(expect.arrayContaining(['hiking', 'museum']));
    expect(p.participantIds.sort()).toEqual(['u1', 'u2', 'u3']);
    expect(p.tasks.find((t) => t.assigneeId === 'u3')?.title).toMatch(/^Book the airbnb/i);
    expect(p.tasks.map((t) => t.title.toLowerCase())).toContain('renew passports');
    expect(p.title).toBe('Trip to Lisbon');
    expect(p.missing).toEqual([]);
    expect(
      PlanPayloadSchema.safeParse({
        conversationId: null,
        plan: { ...p, participantIds: ['11111111-1111-4111-8111-111111111111'], tasks: [] },
      }).success,
    ).toBe(true);
  });
  it('reports what is missing instead of guessing', () => {
    const p = extractPlan([{ senderId: 'u1', text: 'we should hang out sometime' }], { now });
    expect(p.destination).toBeNull();
    expect(p.startsOn).toBeNull();
    expect(p.budget).toBeNull();
    expect(p.missing).toEqual(expect.arrayContaining(['destination', 'dates', 'budget']));
  });
  it('parses ISO dates and rolls past dates into next year', () => {
    expect(
      extractPlan([{ senderId: null, text: 'we fly 2026-08-01 and return 2026-08-09' }], { now }),
    ).toMatchObject({ startsOn: '2026-08-01', endsOn: '2026-08-09' });
    expect(extractPlan([{ senderId: null, text: 'how about March 3-5' }], { now }).startsOn).toBe(
      '2027-03-03',
    );
  });
});

describe('memory candidates', () => {
  it('only extracts first-person statements, never questions, secrets or contact data', () => {
    expect(extractMemoryCandidates('Remember that I am allergic to peanuts')).toEqual([
      'I am allergic to peanuts',
    ]);
    expect(extractMemoryCandidates('I prefer window seats on long flights.')[0]).toMatch(
      /window seats/,
    );
    expect(extractMemoryCandidates('Do you remember that I like tea?')).toEqual([]);
    expect(extractMemoryCandidates('remember my password: hunter2hunter2')).toEqual([]);
    expect(extractMemoryCandidates('remember that my email is a@b.co')).toEqual([]);
    expect(extractMemoryCandidates('what is the weather like')).toEqual([]);
  });
});

describe('context bundle', () => {
  it('bounds tokens and items, truncates long items, dedupes by source and keeps provenance', () => {
    const c = new ContextBundle({ maxTokens: 100, maxItemTokens: 20, maxItems: 3 });
    c.add({ source: { type: 'post', id: '1' }, text: 'a'.repeat(1000) });
    c.add({ source: { type: 'post', id: '1' }, text: 'dup' });
    c.add({ source: { type: 'memory', id: '2' }, text: 'short', priority: 5 });
    c.add({ source: { type: 'post', id: '3' }, text: 'b'.repeat(200) });
    c.add({ source: { type: 'post', id: '4' }, text: 'c'.repeat(200) });
    const b = c.build();
    expect(b.items[0]!.source.type).toBe('memory'); // priority first
    expect(b.items.find((i) => i.source.id === '1')!.truncated).toBe(true);
    expect(b.items.length).toBeLessThanOrEqual(3);
    expect(b.tokens).toBeLessThanOrEqual(100);
    expect(b.dropped.length).toBeGreaterThan(0);
    expect(b.sources.every((s) => s.id && s.type)).toBe(true);
  });
  it('wraps untrusted items and leaves trusted ones', () => {
    const c = new ContextBundle()
      .add({ source: { type: 'post', id: 'p' }, text: 'user text' })
      .add({ source: { type: 'memory', id: 'm' }, text: 'system text', untrusted: false });
    const r = renderContext(c.build());
    expect(r).toContain('<untrusted_data source="post:p">');
    expect(r).toContain('system text');
    expect(r).not.toContain('source="memory:m"');
  });
});

describe('tool registry and agents', () => {
  it('has no tool that mutates the world', () => {
    expect(() => assertNoMutatingTools()).not.toThrow();
    for (const s of Object.values(TOOL_SPECS)) expect(['read', 'draft']).toContain(s.effect);
    expect(TOOL_NAMES.every((n) => TOOL_SPECS[n].name === n)).toBe(true);
  });
  it('produces JSON-schema descriptors for every tool', () => {
    for (const n of TOOL_NAMES) {
      const d = toolDescriptor(n);
      expect(d.inputSchema.type).toBe('object');
      expect(d.description.length).toBeGreaterThan(10);
    }
  });
  it('private-communication tools are never available to teens and require consent', () => {
    for (const s of Object.values(TOOL_SPECS))
      if (s.privateComms) {
        expect(s.teenAllowed).toBe(false);
        expect(s.consent).toBe('ai_processing');
      }
  });
  it('validates tool input', () => {
    expect(TOOL_SPECS.summarize_thread.input.safeParse({ postId: 'nope' }).success).toBe(false);
    expect(TOOL_SPECS.search_content.input.safeParse({ query: 'x' }).success).toBe(false);
  });
  it('defines the seven agents, each within its own grants', () => {
    expect([...AGENT_IDS].sort()).toEqual([
      'business',
      'community',
      'creator',
      'event',
      'shopping',
      'social',
      'travel',
    ]);
    for (const id of AGENT_IDS) {
      const a = AGENTS[id];
      expect(a.evals.length).toBeGreaterThan(0);
      for (const t of a.tools)
        for (const p of TOOL_SPECS[t].permissions) expect(a.grants, `${id}:${t}:${p}`).toContain(p);
      for (const t of a.tools) expect(TOOL_SPECS[t].scopes, `${id}:${t}`).toContain(a.scope);
    }
    expect(AGENTS.community.safety.groundedOnly && AGENTS.business.safety.groundedOnly).toBe(true);
    expect(getAgent('nope')).toBeNull();
  });
  it('renders the system prompt with the untrusted-data policy and canary', () => {
    const p = renderSystemPrompt(AGENTS.social, { date: '2026-01-02', canary: 'CANARY-X' });
    expect(p).toContain('untrusted_data');
    expect(p).toContain('CANARY-X');
    expect(p).toContain('2026-01-02');
    expect(p).not.toContain('{{');
  });
});

describe('cost estimates', () => {
  it('dev is free; known models are priced; unknown are 0', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
    expect(estimateCostMicros('dev', 'dev-rules-1', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(
      0,
    );
    expect(
      estimateCostMicros('openai', 'gpt-4o-mini', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(750_000);
    expect(estimateCostMicros('x', 'mystery', { inputTokens: 5, outputTokens: 5 })).toBe(0);
  });
});
