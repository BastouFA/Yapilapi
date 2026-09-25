import type { Pool } from 'pg';
import { z } from 'zod';
import { forbidden, notFound } from '../errors.ts';
import { analyzeText } from '../moderation.ts';
import { searchAll } from '../../modules/search.ts';
import { EVENT_SELECT, toEvent } from '../../modules/events.ts';
import { eventVisibleSql } from '../visibility.ts';
import type { AgentTool, AiProvider } from './providers.ts';

export const AGENT_KINDS = ['discover', 'travel', 'shopping', 'business'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

type EntityType = 'event' | 'place' | 'community' | 'person' | 'product' | 'business';
export interface Entity {
  type: EntityType;
  id: string;
  title: string;
  subtitle?: string;
  /** Events: when it starts (ISO), for the app to format in the viewer's locale. */
  startsAt?: string;
  href: string;
}
export interface Recommendation extends Entity {
  reason: string;
}
/** Something the assistant suggests doing. Nothing happens until the person confirms it in the app. */
export interface ProposedAction {
  kind: 'rsvp' | 'book' | 'buy' | 'follow' | 'join';
  target: Entity;
  label: string;
}
export interface AgentResult {
  agent: AgentKind;
  text: string;
  recommendations: Recommendation[];
  actions: ProposedAction[];
  provider: string;
  model: string;
  contextScopes: string[];
  notice?: string;
}

const ACTION_FOR: Partial<Record<EntityType, ProposedAction['kind']>> = { event: 'rsvp', place: 'book', product: 'buy', person: 'follow', community: 'join' };
const ACTION_LABEL: Record<ProposedAction['kind'], string> = { rsvp: 'RSVP', book: 'Request a booking', buy: 'Buy', follow: 'Follow', join: 'Join' };

const SYSTEMS: Record<AgentKind, string> = {
  discover:
    "You are YAPILAPI's Discover assistant. Help the person find things to do, people, communities, places and events that fit what they ask. Use the tools to search; only recommend items returned by the tools, using recommend() for each pick with a one-sentence reason grounded in the data. Prefer upcoming events and active communities. Keep the final answer short (2-4 sentences) and plain; the recommended items are shown as cards below it.",
  travel:
    "You are YAPILAPI's trip planner. Build a realistic day-by-day plan for the destination and dates the person gives, using only places and events the tools return (say clearly when YAPILAPI has nothing for a part of the trip rather than inventing venues). Use recommend() for each place or event you include and propose_action() for bookings or RSVPs worth making. Final answer: a short itinerary in plain text, one line per stop, with times when known.",
  shopping:
    "You are YAPILAPI's shopping assistant. Find products and services on YAPILAPI that match the need, compare them honestly on price and what the listing says, and never claim details the listing doesn't state. Use recommend() for up to 5 items and propose_action('buy') only for the single best fit. Final answer: 2-4 sentences.",
  business:
    "You are the assistant for a business owner on YAPILAPI. Answer questions about their own business using the tools (bookings, reviews, product sales). Give concrete numbers from the tools, point out patterns, and suggest practical next steps. Never guess numbers the tools didn't return. When asked to draft replies to reviews, write them warm, specific and short. Plain text, no markdown tables.",
};

/**
 * Agents run a model with tools that execute server-side AS the requesting
 * person: search goes through the same visibility rules as the app, and
 * business tools check ownership. Recommendations and actions are only
 * accepted for entities a tool actually returned in this run, so the model
 * can't invent venues or reach content the person couldn't see. Actions are
 * proposals; the person confirms them in the app.
 */
export async function runAgent(db: Pool, provider: AiProvider, userId: string, kind: AgentKind, prompt: string, opts: { businessId?: string } = {}): Promise<AgentResult> {
  if (analyzeText(prompt).risk === 'escalate') throw forbidden('This request can’t be processed.');
  const started = Date.now();
  const seen = new Map<string, Entity>();
  const recommendations: Recommendation[] = [];
  const actions: ProposedAction[] = [];
  const scopes = new Set<string>();
  const remember = (e: Entity) => (seen.set(`${e.type}:${e.id}`, e), e);

  let business: { id: string; name: string } | null = null;
  if (kind === 'business') {
    const r = await db.query(
      opts.businessId
        ? `SELECT id, name FROM businesses WHERE id = $2 AND owner_id = $1 AND deleted_at IS NULL`
        : `SELECT id, name FROM businesses WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      opts.businessId ? [userId, opts.businessId] : [userId],
    );
    business = r.rows[0] ?? null;
    if (!business) throw notFound('Business');
    scopes.add(`business:${business.id}`);
  }

  async function search(query: string, type: string, limit = 8) {
    scopes.add('search');
    const res = await searchAll(db, userId, { q: query.slice(0, 200), type: type as never, limit });
    const r = res.results as Record<string, any[] | undefined>;
    const out: Entity[] = [];
    for (const e of r.events ?? [])
      out.push(remember({ type: 'event', id: e.id, title: e.title, startsAt: e.startsAt, subtitle: e.place?.name ?? e.locationText ?? undefined, href: `/events/${e.id}` }));
    for (const p of r.places ?? []) out.push(remember({ type: 'place', id: p.id, title: p.name, subtitle: [p.category, p.city].filter(Boolean).join(' · '), href: `/places/${p.id}` }));
    for (const c of r.communities ?? [])
      if (c.visibility === 'public') out.push(remember({ type: 'community', id: c.id, title: c.name, subtitle: `${c.memberCount} members`, href: `/c/${c.slug}` }));
    for (const u of r.people ?? []) out.push(remember({ type: 'person', id: u.id, title: u.displayName, subtitle: `@${u.username}`, href: `/u/${u.username}` }));
    for (const p of r.products ?? [])
      out.push(remember({ type: 'product', id: p.id, title: p.title, subtitle: `${(p.priceCents / 100).toFixed(2)} ${p.currency} · ${p.kind}`, href: `/discover?q=${encodeURIComponent(p.title)}` }));
    for (const b of r.businesses ?? []) out.push(remember({ type: 'business', id: b.id, title: b.name, subtitle: b.category, href: `/b/${b.slug}` }));
    return { intent: res.intent, results: out };
  }

  const baseTools: AgentTool[] = [
    {
      name: 'search',
      description:
        'Search YAPILAPI for events, places, communities, people, products and businesses the person can see. Natural language works ("live music this weekend in Lisbon"). Returns items with type, id, title and subtitle.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in plain words.' },
          type: { type: 'string', enum: ['all', 'events', 'places', 'communities', 'people', 'products', 'businesses'] },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: async (input) => {
        const i = z.object({ query: z.string().min(1), type: z.string().default('all') }).parse(input);
        return JSON.stringify(await search(i.query, i.type));
      },
    },
    {
      name: 'my_context',
      description: "The person's interests (topics they follow), language and upcoming events they are going to. Use it to personalise.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        scopes.add('profile:interests');
        const [interests, profile, going] = await Promise.all([
          db.query(`SELECT t.slug FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1`, [userId]),
          db.query(`SELECT locale FROM profiles WHERE user_id = $1`, [userId]),
          db.query(
            `${EVENT_SELECT} WHERE ${eventVisibleSql('$1')} AND e.starts_at > now() AND EXISTS (SELECT 1 FROM event_attendees r WHERE r.event_id = e.id AND r.user_id = $1 AND r.status = 'going') ORDER BY e.starts_at LIMIT 5`,
            [userId],
          ),
        ]);
        return JSON.stringify({
          interests: interests.rows.map((r) => r.slug),
          locale: profile.rows[0]?.locale ?? 'en',
          goingTo: going.rows.map(toEvent).map((e) => ({ title: e.title, startsAt: e.startsAt })),
          now: new Date().toISOString(),
        });
      },
    },
    {
      name: 'place_details',
      description: 'Details for a place returned by search: description, address, opening hours, rating and whether it takes booking requests.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: async (input) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(input);
        if (!seen.has(`place:${id}`)) return 'Unknown place. Search for it first.';
        const r = await db.query(
          `SELECT p.name, p.description, p.address, p.city, p.hours, p.booking_capacity,
                  (SELECT round(avg(rating)::numeric, 1) FROM place_reviews WHERE place_id = p.id AND moderation_status IN ('normal','review')) AS rating,
                  (SELECT count(*) FROM place_reviews WHERE place_id = p.id AND moderation_status IN ('normal','review')) AS reviews
           FROM places p WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [id],
        );
        const p = r.rows[0];
        if (!p) return 'Place not found.';
        return JSON.stringify({ ...p, takesBookings: p.booking_capacity !== null, reviews: Number(p.reviews) });
      },
    },
    {
      name: 'recommend',
      description: 'Show an item from a search result to the person as a card, with a one-sentence reason grounded in the data.',
      inputSchema: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['event', 'place', 'community', 'person', 'product', 'business'] }, id: { type: 'string' }, reason: { type: 'string' } },
        required: ['type', 'id', 'reason'],
        additionalProperties: false,
      },
      run: async (input) => {
        const i = z.object({ type: z.string(), id: z.string(), reason: z.string().min(1).max(300) }).parse(input);
        const e = seen.get(`${i.type}:${i.id}`);
        if (!e) return 'Not shown: only items returned by search in this conversation can be recommended.';
        if (recommendations.length >= 8) return 'Not shown: at most 8 recommendations.';
        if (!recommendations.some((r) => r.type === e.type && r.id === e.id)) recommendations.push({ ...e, reason: i.reason });
        return 'Shown.';
      },
    },
    {
      name: 'propose_action',
      description:
        'Suggest an action the person can confirm with one tap: RSVP to an event, request a booking at a place, buy a product, follow a person or join a community. Nothing happens until they confirm.',
      inputSchema: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false },
      run: async (input) => {
        const i = z.object({ type: z.string(), id: z.string() }).parse(input);
        const e = seen.get(`${i.type}:${i.id}`);
        const k = e ? ACTION_FOR[e.type] : undefined;
        if (!e || !k) return 'Not proposed: unknown item or no action for it.';
        if (actions.length >= 4) return 'Not proposed: at most 4 actions.';
        if (!actions.some((a) => a.target.id === e.id)) actions.push({ kind: k, target: e, label: `${ACTION_LABEL[k]}: ${e.title}` });
        return 'Proposed. The person will confirm it.';
      },
    },
  ];

  const businessTools: AgentTool[] = business
    ? [
        {
          name: 'business_overview',
          description: `Numbers for ${business.name} over the last N days: bookings by status, upcoming bookings, review count and average, product sales.`,
          inputSchema: { type: 'object', properties: { days: { type: 'number', description: '1 to 90' } }, additionalProperties: false },
          run: async (input) => JSON.stringify(await businessOverview(db, business!.id, z.object({ days: z.number().int().min(1).max(90).default(30) }).parse(input).days)),
        },
        {
          name: 'recent_reviews',
          description: `The latest reviews of ${business.name}'s places, with rating and text.`,
          inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
          run: async (input) => {
            const { limit } = z.object({ limit: z.number().int().min(1).max(50).default(15) }).parse(input);
            scopes.add('business:reviews');
            const r = await db.query(
              `SELECT pl.name AS place, r.rating, r.body, r.created_at FROM place_reviews r JOIN places pl ON pl.id = r.place_id
               WHERE pl.business_id = $1 AND r.moderation_status IN ('normal','review') ORDER BY r.created_at DESC LIMIT $2`,
              [business!.id, limit],
            );
            return JSON.stringify(r.rows);
          },
        },
      ]
    : [];

  const tools =
    kind === 'business'
      ? [...businessTools, baseTools[0]!]
      : kind === 'shopping'
        ? baseTools.filter((t) => t.name !== 'place_details')
        : baseTools;

  let text: string;
  let refused = false;
  let status: 'ok' | 'blocked' | 'error' = 'ok';
  try {
    if (provider.agent) {
      const res = await provider.agent({
        system: SYSTEMS[kind] + (business ? `\nThe business is "${business.name}".` : ''),
        prompt,
        tools,
        maxSteps: 10,
      });
      text = res.text;
      refused = !!res.refused;
    } else {
      text = await devAgent(kind, prompt, { search, tools, business, recommendations });
    }
  } catch (e) {
    await log(db, userId, kind, provider, [...scopes], 'error', started);
    throw e;
  }
  const risk = analyzeText(text).risk;
  if (refused || risk === 'escalate' || risk === 'restrict') {
    status = 'blocked';
    text = '';
  }
  await log(db, userId, kind, provider, [...scopes], status, started);
  return {
    agent: kind,
    text,
    recommendations: status === 'ok' ? recommendations : [],
    actions: status === 'ok' ? actions : [],
    provider: provider.name,
    model: provider.model,
    contextScopes: [...scopes],
    notice:
      status === 'blocked'
        ? 'The result was withheld by safety filters.'
        : provider.name === 'dev'
          ? 'Generated by the local development provider (rule-based search, no model).'
          : undefined,
  };
}

export async function businessOverview(db: Pool, businessId: string, days: number) {
  const [bookings, upcoming, reviews, sales] = await Promise.all([
    db.query(
      `SELECT bk.status, count(*)::int AS n, coalesce(sum(bk.party_size), 0)::int AS guests FROM bookings bk JOIN places pl ON pl.id = bk.place_id
       WHERE pl.business_id = $1 AND bk.created_at > now() - make_interval(days => $2) GROUP BY bk.status`,
      [businessId, days],
    ),
    db.query(
      `SELECT count(*)::int AS n FROM bookings bk JOIN places pl ON pl.id = bk.place_id WHERE pl.business_id = $1 AND bk.status IN ('requested','confirmed') AND bk.starts_at > now()`,
      [businessId],
    ),
    db.query(
      `SELECT count(*)::int AS n, round(avg(r.rating)::numeric, 2) AS average FROM place_reviews r JOIN places pl ON pl.id = r.place_id
       WHERE pl.business_id = $1 AND r.moderation_status IN ('normal','review') AND r.created_at > now() - make_interval(days => $2)`,
      [businessId, days],
    ),
    db.query(
      `SELECT pd.title, o.currency, sum(oi.quantity)::int AS units, sum(oi.quantity * oi.unit_cents)::int AS revenue_cents
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products pd ON pd.id = oi.product_id
       WHERE pd.business_id = $1 AND o.status = 'paid' AND o.created_at > now() - make_interval(days => $2)
       GROUP BY pd.title, o.currency ORDER BY revenue_cents DESC LIMIT 10`,
      [businessId, days],
    ),
  ]);
  return {
    days,
    bookingsByStatus: Object.fromEntries(bookings.rows.map((r) => [r.status, { bookings: r.n, guests: r.guests }])),
    upcomingBookings: upcoming.rows[0].n,
    reviews: { count: reviews.rows[0].n, average: reviews.rows[0].average === null ? null : Number(reviews.rows[0].average) },
    topProducts: sales.rows,
  };
}

/**
 * Offline stand-in used when no model is configured: it runs the same tools
 * with rules instead of a model, so permissions, grounding and logging are
 * exercised end to end in development and tests.
 */
async function devAgent(
  kind: AgentKind,
  prompt: string,
  s: { search: (q: string, t: string, l?: number) => Promise<{ results: Entity[] }>; tools: AgentTool[]; business: { id: string; name: string } | null; recommendations: Recommendation[] },
): Promise<string> {
  const call = (name: string, input: Record<string, unknown>) => s.tools.find((t) => t.name === name)!.run(input);
  if (kind === 'business') {
    const o = JSON.parse(await call('business_overview', { days: 30 }));
    const confirmed = o.bookingsByStatus.confirmed?.bookings ?? 0;
    const requested = o.bookingsByStatus.requested?.bookings ?? 0;
    return [
      `${s.business!.name}, last 30 days: ${confirmed} confirmed and ${requested} waiting booking requests, ${o.upcomingBookings} upcoming.`,
      o.reviews.count ? `${o.reviews.count} new review${o.reviews.count === 1 ? '' : 's'} averaging ${o.reviews.average} out of 5.` : 'No new reviews.',
      o.topProducts.length ? `Best seller: ${o.topProducts[0].title} (${o.topProducts[0].units} sold).` : 'No product sales.',
    ].join(' ');
  }
  const type = kind === 'shopping' ? 'products' : 'all';
  const { results } = await s.search(prompt, type);
  for (const e of results.slice(0, 5)) await call('recommend', { type: e.type, id: e.id, reason: `Matches "${prompt.slice(0, 60)}".` });
  const best = results.find((e) => ACTION_FOR[e.type] && (kind !== 'shopping' || e.type === 'product'));
  if (best && kind !== 'discover') await call('propose_action', { type: best.type, id: best.id });
  return results.length ? `Here's what YAPILAPI has for "${prompt}".` : `YAPILAPI doesn't have anything for "${prompt}" yet.`;
}

async function log(db: Pool, userId: string, kind: AgentKind, provider: AiProvider, scopes: string[], status: string, started: number) {
  await db
    .query(`INSERT INTO ai_tool_calls (user_id, task, provider, model, context_scopes, status, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      userId,
      `agent:${kind}`,
      provider.name,
      provider.model,
      scopes,
      status,
      Date.now() - started,
    ])
    .catch(() => {});
}
