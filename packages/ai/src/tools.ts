import { z } from 'zod';
import type { ToolDescriptor } from './types.js';

/**
 * The typed tool registry (contracts only; handlers live in the API module next to the database and permission code).
 *
 * Hard rules encoded here:
 *  - `effect` is 'read' or 'draft'. There is NO effect that mutates the world: nothing publishes, sends, buys or deletes.
 *    Drafts become real only through the human-confirmed endpoints (POST /v1/ai/artifacts/:id/confirm).
 *  - `permissions` are checked against the AGENT's grants and `scopes` against the conversation scope before a handler runs.
 *  - `consent` names the privacy consent that must be granted; `privateComms` marks tools that read direct/group messages
 *    (only for a conversation the user explicitly attached to the current request).
 */
export const TOOL_NAMES = [
  'search_content',
  'get_event_details',
  'find_events',
  'summarize_thread',
  'summarize_conversation',
  'draft_post',
  'draft_reply',
  'draft_caption',
  'draft_description',
  'suggest_titles',
  'thumbnail_concepts',
  'plan_from_conversation',
  'create_event_draft',
  'community_faq_answer',
  'business_assistant_answer',
  'translate',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type AgentScope = 'personal' | 'community' | 'business' | 'creator';
export type ToolEffect = 'read' | 'draft';

export const PERMISSIONS = [
  'content.read',
  'events.read',
  'messages.read_attached',
  'drafts.write',
  'community.knowledge.read',
  'business.knowledge.read',
  'translate.use',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface ToolSpec {
  name: ToolName;
  description: string;
  effect: ToolEffect;
  input: z.ZodType;
  permissions: Permission[];
  scopes: AgentScope[];
  consent: 'ai_processing' | null;
  privateComms: boolean;
  teenAllowed: boolean;
}

const uuid = z.uuid();
const short = (max: number, min = 1) => z.string().trim().min(min).max(max);
const tone = z.enum(['friendly', 'professional', 'playful', 'concise', 'inspiring']).optional();

export const SEARCH_TYPES_FOR_AI = [
  'posts',
  'videos',
  'events',
  'communities',
  'places',
  'businesses',
  'people',
  'creators',
  'topics',
] as const;

const ALL_SCOPES: AgentScope[] = ['personal', 'community', 'business', 'creator'];

export const TOOL_SPECS = {
  search_content: {
    name: 'search_content',
    effect: 'read',
    permissions: ['content.read'],
    scopes: ALL_SCOPES,
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description:
      'Search content the user is allowed to see (posts, events, communities, places, businesses, people). Results respect the same privacy rules as the app search.',
    input: z.object({
      query: short(200, 2),
      types: z.array(z.enum(SEARCH_TYPES_FOR_AI)).max(6).optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }),
  },
  get_event_details: {
    name: 'get_event_details',
    effect: 'read',
    permissions: ['events.read'],
    scopes: ALL_SCOPES,
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description: 'Get the details of one event the user may see.',
    input: z.object({ eventId: uuid }),
  },
  find_events: {
    name: 'find_events',
    effect: 'read',
    permissions: ['events.read'],
    scopes: ALL_SCOPES,
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description: 'Find upcoming events the user may see, optionally by keyword and time window.',
    input: z.object({
      query: short(120).optional(),
      when: z
        .enum(['today', 'tomorrow', 'this weekend', 'next weekend', 'this week', 'next week'])
        .optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }),
  },
  summarize_thread: {
    name: 'summarize_thread',
    effect: 'read',
    permissions: ['content.read'],
    scopes: ['personal', 'creator'],
    consent: 'ai_processing',
    privateComms: false,
    teenAllowed: true,
    description: 'Summarise a post and the comments the user can see under it.',
    input: z.object({ postId: uuid }),
  },
  summarize_conversation: {
    name: 'summarize_conversation',
    effect: 'read',
    permissions: ['messages.read_attached'],
    scopes: ['personal'],
    consent: 'ai_processing',
    privateComms: true,
    teenAllowed: false,
    description:
      'Summarise a direct or group conversation. Works ONLY for a conversation the user explicitly attached to this request.',
    input: z.object({ conversationId: uuid }),
  },
  draft_post: {
    name: 'draft_post',
    effect: 'draft',
    permissions: ['drafts.write'],
    scopes: ['personal', 'creator', 'community'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description:
      'Draft a post for the user to review. Nothing is published until the user confirms.',
    input: z.object({
      topic: short(400, 3),
      tone,
      communityId: uuid.optional(),
      visibility: z.enum(['public', 'followers', 'friends']).optional(),
    }),
  },
  draft_reply: {
    name: 'draft_reply',
    effect: 'draft',
    permissions: ['drafts.write', 'content.read'],
    scopes: ['personal'],
    consent: 'ai_processing',
    privateComms: false,
    teenAllowed: true,
    description:
      'Draft a reply to a post, a comment, or (if attached) a conversation. The user must confirm before anything is sent.',
    input: z.object({
      targetType: z.enum(['post', 'comment', 'conversation']),
      targetId: uuid,
      guidance: short(300).optional(),
    }),
  },
  draft_caption: {
    name: 'draft_caption',
    effect: 'draft',
    permissions: ['drafts.write'],
    scopes: ['personal', 'creator'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description: 'Draft a few caption options for a photo or video the user describes.',
    input: z.object({
      description: short(500, 3),
      tone,
      count: z.number().int().min(1).max(5).optional(),
    }),
  },
  draft_description: {
    name: 'draft_description',
    effect: 'draft',
    permissions: ['drafts.write'],
    scopes: ['creator', 'personal'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description: 'Draft a description for a video, event or listing from notes the user provides.',
    input: z.object({ notes: short(1500, 3), tone }),
  },
  suggest_titles: {
    name: 'suggest_titles',
    effect: 'draft',
    permissions: ['drafts.write'],
    scopes: ['creator', 'personal'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description: 'Suggest title options for content the user describes.',
    input: z.object({ topic: short(500, 3), count: z.number().int().min(1).max(8).optional() }),
  },
  thumbnail_concepts: {
    name: 'thumbnail_concepts',
    effect: 'draft',
    permissions: ['drafts.write'],
    scopes: ['creator'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description: 'Suggest thumbnail concepts as TEXT prompts (no image is generated).',
    input: z.object({ topic: short(500, 3), count: z.number().int().min(1).max(5).optional() }),
  },
  plan_from_conversation: {
    name: 'plan_from_conversation',
    effect: 'draft',
    permissions: ['messages.read_attached', 'drafts.write'],
    scopes: ['personal'],
    consent: 'ai_processing',
    privateComms: true,
    teenAllowed: false,
    description:
      'Turn an attached group conversation into a structured plan draft (destination, dates, participants, budget, transport, accommodation, activities, tasks). Works ONLY for a conversation the user explicitly attached.',
    input: z.object({ conversationId: uuid, hints: short(300).optional() }),
  },
  create_event_draft: {
    name: 'create_event_draft',
    effect: 'draft',
    permissions: ['drafts.write'],
    scopes: ['personal', 'creator', 'community'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description:
      'Draft an event (title, description, time, place) for the user to review. Confirming creates an unpublished draft event.',
    input: z.object({
      title: short(160, 2),
      description: short(2000).optional(),
      startsAt: z.iso.datetime({ offset: true }).optional(),
      endsAt: z.iso.datetime({ offset: true }).optional(),
      locationText: short(200).optional(),
      visibility: z.enum(['public', 'friends', 'private']).optional(),
    }),
  },
  community_faq_answer: {
    name: 'community_faq_answer',
    effect: 'read',
    permissions: ['community.knowledge.read'],
    scopes: ['personal', 'community'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description:
      "Answer a question from a community's rules, resources and recorded decisions. Only for communities the user belongs to; says so when nothing is documented.",
    input: z.object({ communityId: uuid, question: short(500, 3) }),
  },
  business_assistant_answer: {
    name: 'business_assistant_answer',
    effect: 'read',
    permissions: ['business.knowledge.read'],
    scopes: ['personal', 'business'],
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description:
      "Answer a shopper's question from a business's owner-approved knowledge, only when the business enabled its assistant.",
    input: z.object({ businessId: uuid, question: short(500, 3) }),
  },
  translate: {
    name: 'translate',
    effect: 'read',
    permissions: ['translate.use'],
    scopes: ALL_SCOPES,
    consent: null,
    privateComms: false,
    teenAllowed: true,
    description:
      'Translate text the user provides into another language. The original text is always kept.',
    input: z.object({
      text: short(4000),
      targetLanguage: short(12, 2),
      sourceLanguage: short(12, 2).optional(),
    }),
  },
} satisfies Record<ToolName, ToolSpec>;

/** Per-tool input types, inferred from the concrete schemas. */
export type ToolInputs = { [K in ToolName]: z.infer<(typeof TOOL_SPECS)[K]['input']> };
export const specOf = (name: ToolName): ToolSpec => TOOL_SPECS[name];

export function toolDescriptor(name: ToolName): ToolDescriptor {
  const spec = TOOL_SPECS[name];
  const schema = z.toJSONSchema(spec.input) as Record<string, unknown>;
  delete schema.$schema;
  return { name: spec.name, description: spec.description, inputSchema: schema };
}

export const isToolName = (s: string): s is ToolName =>
  (TOOL_NAMES as readonly string[]).includes(s);

/** The invariant the whole design rests on; asserted in unit tests. */
export const MUTATING_TOOLS: readonly ToolName[] = [];
export function assertNoMutatingTools(): void {
  for (const s of Object.values(TOOL_SPECS) as ToolSpec[]) {
    if (s.effect !== 'read' && s.effect !== 'draft')
      throw new Error(`tool ${s.name} has a forbidden effect`);
  }
}

/** Structured plan payload (artifact kind 'plan'), validated before it is stored and again when confirmed. */
export const PlanPayloadSchema = z.object({
  conversationId: uuid.nullable(),
  plan: z.object({
    title: short(200),
    destination: short(200).nullable(),
    startsOn: z.iso.date().nullable(),
    endsOn: z.iso.date().nullable(),
    participantIds: z.array(uuid).max(100),
    budget: z
      .object({
        amountCents: z.number().int().min(0).max(1_000_000_000_00),
        currency: z.string().length(3),
      })
      .nullable(),
    transport: z.array(short(60)).max(20),
    accommodation: z.array(short(60)).max(20),
    activities: z.array(short(60)).max(30),
    tasks: z.array(z.object({ title: short(200), assigneeId: uuid.nullable() })).max(50),
    missing: z.array(z.string()).max(10),
  }),
});
export type PlanPayload = z.infer<typeof PlanPayloadSchema>;
