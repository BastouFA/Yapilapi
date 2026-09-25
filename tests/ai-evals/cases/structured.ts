import { PlanPayloadSchema } from '@yapilapi/ai';
import { z } from 'zod';
import { check, checkEq, type EvalCase } from '../harness.js';

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export const cases: EvalCase[] = [
  {
    id: 'struct.draft_payloads',
    category: 'structured_outputs',
    kind: 'invariant',
    title: 'Every draft tool stores a payload that validates against its schema',
    async run(h) {
      const u = await h.user();
      const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const cases: Array<[string, string, Record<string, unknown>, z.ZodType]> = [
        [
          'social',
          'draft_post',
          { topic: 'my first marathon' },
          z.object({ body: z.string().min(1).max(5000) }),
        ],
        [
          'creator',
          'draft_caption',
          { description: 'sunset at the beach' },
          z.object({ options: z.array(z.string().min(1)).min(1).max(5), selected: z.number() }),
        ],
        [
          'creator',
          'suggest_titles',
          { topic: 'street food', count: 4 },
          z.object({ type: z.literal('titles'), titles: z.array(z.string().min(1)).min(1).max(8) }),
        ],
        [
          'creator',
          'draft_description',
          { notes: 'A walk through the night market. Prices are low.' },
          z.object({ type: z.literal('description'), text: z.string().min(1) }),
        ],
        [
          'creator',
          'thumbnail_concepts',
          { topic: 'street food' },
          z.object({
            type: z.literal('thumbnail_concepts'),
            concepts: z.array(z.object({ prompt: z.string().min(1) })).min(1),
          }),
        ],
        [
          'event',
          'create_event_draft',
          { title: 'Picnic', startsAt: `${day}T18:00:00Z`, locationText: 'Central Park' },
          z.object({
            title: z.string().min(2),
            startsAt: z.string().nullable(),
            visibility: z.enum(['public', 'friends', 'private']),
            missing: z.array(z.string()),
          }),
        ],
      ];
      for (const [agent, tool, args, schema] of cases) {
        const r = await h.tool(u, agent, tool, args);
        check(r.ok, `${tool} failed: ${r.content.slice(0, 150)}`);
        const id = JSON.parse(r.content).result.artifactId as string;
        const art = (await u.client.get(`/v1/ai/artifacts/${id}`)).body;
        const parsed = schema.safeParse(art.payload);
        check(parsed.success, `${tool} payload invalid: ${parsed.error?.message.slice(0, 200)}`);
        checkEq(art.status, 'draft', `${tool} status`);
      }
    },
  },
  {
    id: 'struct.plan_payload',
    category: 'structured_outputs',
    kind: 'invariant',
    title: 'Plan drafts always validate against the plan schema and only name real members',
    async run(h) {
      const [a, b] = await h.friends();
      const outsider = await h.user();
      const conv = await h.dm(a, b);
      await h.say(b, conv, "Let's plan a trip to Porto on 2099-07-01, I will book the flights");
      await h.consent(a, 'ai_processing');
      const r = await h.withProvider(
        'json-forger',
        () => ({
          content: JSON.stringify({
            title: 'Trip',
            destination: 'Porto',
            tasks: [{ title: 'Book flights', assigneeId: outsider.id }],
            participantIds: [outsider.id, b.id],
          }),
        }),
        () =>
          h.tool(
            a,
            'travel',
            'plan_from_conversation',
            { conversationId: conv },
            { attached: [conv] },
          ),
      );
      check(r.ok, `plan failed ${r.content.slice(0, 200)}`);
      const art = (
        await a.client.get(`/v1/ai/artifacts/${JSON.parse(r.content).result.artifactId}`)
      ).body;
      check(PlanPayloadSchema.safeParse(art.payload).success, 'stored plan does not validate');
      check(
        !JSON.stringify(art.payload).includes(outsider.id),
        'a non-member was named in the plan',
      );
    },
  },
  {
    id: 'struct.malformed_model_json',
    category: 'structured_outputs',
    kind: 'invariant',
    title:
      'Malformed or hostile JSON from a model never crashes a tool or stores an unvalidated payload',
    async run(h) {
      const u = await h.user();
      for (const [label, content] of [
        ['not json', 'here you go: {{{ nope'],
        ['wrong shape', JSON.stringify({ body: 12345, extra: 'x'.repeat(50) })],
        ['empty', ''],
        ['array', '[1,2,3]'],
      ] as const) {
        const r = await h.withProvider(
          'sloppy',
          () => ({ content }),
          () => h.tool(u, 'social', 'draft_post', { topic: 'gardening tips for spring' }),
        );
        check(
          r.outcome.outcome !== 'allowed' || uuid.test(r.content),
          `${label}: allowed but no draft`,
        );
        check(
          r.outcome.outcome === 'allowed' || r.outcome.outcome === 'error',
          `${label}: unexpected outcome ${r.outcome.outcome}`,
        );
        if (r.ok) {
          const art = (
            await u.client.get(`/v1/ai/artifacts/${JSON.parse(r.content).result.artifactId}`)
          ).body;
          check(
            typeof art.payload.body === 'string' && art.payload.body.length <= 5000,
            `${label}: stored payload invalid`,
          );
        }
      }
    },
  },
  {
    id: 'struct.chat_envelope',
    category: 'structured_outputs',
    kind: 'invariant',
    title:
      'The chat response always carries the documented fields (provider label, sources, tool calls, safety record)',
    async run(h) {
      const u = await h.user();
      const r = await h.chat(u, 'Hello there');
      checkEq(r.status, 200, 'status');
      const schema = z.object({
        conversationId: z.uuid(),
        agent: z.string(),
        provider: z.string(),
        model: z.string().nullable(),
        notice: z.string().nullable(),
        message: z.object({
          id: z.uuid(),
          role: z.literal('assistant'),
          content: z.string().min(1),
          createdAt: z.string(),
        }),
        sources: z.array(z.object({ type: z.string(), id: z.string() })),
        toolCalls: z.array(
          z.object({ tool: z.string(), outcome: z.enum(['allowed', 'denied', 'error']) }),
        ),
        artifacts: z.array(z.object({ id: z.uuid() })),
        memorySuggestions: z.array(z.string()),
        safety: z.object({
          refused: z.boolean(),
          output: z.enum(['ok', 'redacted', 'blocked']),
          injectionDetected: z.boolean(),
        }),
        usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
      });
      const p = schema.safeParse(r.body);
      check(p.success, `envelope invalid: ${p.error?.message.slice(0, 300)}`);
    },
  },
  {
    id: 'struct.tool_input_validation',
    category: 'structured_outputs',
    kind: 'invariant',
    title:
      'Tool arguments are validated: wrong types, missing fields and oversized values become invalid_input, never exceptions',
    async run(h) {
      const u = await h.user();
      for (const [tool, args] of [
        ['search_content', {}],
        ['search_content', { query: 5 }],
        ['get_event_details', { eventId: 'nope' }],
        ['draft_post', { topic: '' }],
        ['translate', { text: 'hi' }],
        ['find_events', { when: 'someday' }],
      ] as const) {
        const r = await h.tool(u, 'social', tool, args as Record<string, unknown>);
        checkEq(
          [r.ok, r.outcome.reason],
          [false, 'invalid_input'],
          `${tool} ${JSON.stringify(args)}`,
        );
      }
    },
  },
];
