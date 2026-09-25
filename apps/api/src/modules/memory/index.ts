import { z } from 'zod';
import { route } from '../../lib/route.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { resolveUser } from '../../lib/users.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { registerExportSection } from '../privacy/index.js';
import {
  AI_DRAFT_KINDS,
  ITEM_TYPES,
  LINK_TYPES,
  MEMORY_KINDS,
  MEMORY_PRIVACY,
  acceptOnThisDay,
  acceptTrip,
  addItems,
  addLinks,
  applyRecap,
  computeRecap,
  confirmAiDraft,
  createAiDraft,
  createMemory,
  deleteMemory,
  discardAiDraft,
  dismissSuggestion,
  exportSlideshow,
  getMemoryView,
  listAiDrafts,
  listMemories,
  loadTimeline,
  onThisDay,
  patchMemory,
  purgeUserMemories,
  removeItem,
  removeLink,
  reorderItems,
  tripSuggestions,
} from './service.js';

export { memoryVisibleSql, memoryItemVisibleSql } from './access.js';
export { clusterTrips, inferHome, tripKey, type GeoItem, type TripCandidate } from './trips.js';
export { buildRecap, recapText, type Recap } from './recap.js';
export {
  insertMemory,
  onThisDay,
  tripSuggestions,
  exportSlideshow,
  ffmpegAvailable,
} from './service.js';

const idParams = z.object({ id: z.uuid() });
const itemParams = z.object({ id: z.uuid(), type: z.enum(ITEM_TYPES), itemId: z.uuid() });
const linkParams = z.object({ id: z.uuid(), type: z.enum(LINK_TYPES), entityId: z.uuid() });
const draftParams = z.object({ id: z.uuid(), draftId: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const itemRef = z.object({ type: z.enum(ITEM_TYPES), id: z.uuid() });
const linkRef = z.object({ type: z.enum(LINK_TYPES), id: z.uuid() });

const createBody = z.object({
  kind: z.enum(MEMORY_KINDS).default('collection'),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(2000).default(''),
  dateStart: dateStr.optional(),
  dateEnd: dateStr.optional(),
  privacy: z.enum(MEMORY_PRIVACY).default('private'),
  items: z.array(itemRef).max(100).default([]),
  links: z.array(linkRef).max(50).default([]),
});
const patchBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(2000).optional(),
  dateStart: dateStr.nullable().optional(),
  dateEnd: dateStr.nullable().optional(),
  privacy: z.enum(MEMORY_PRIVACY).optional(),
});
const timelineQuery = pageQuery.extend({
  from: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  placeId: z.uuid().optional(),
  eventId: z.uuid().optional(),
  personId: z.uuid().optional(),
  types: z
    .string()
    .max(200)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(ITEM_TYPES)).max(7))
    .optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const memoryModule: ApiModule = {
  name: 'memory',
  register(app, ctx: AppContext) {
    const gate = (userId: string) => ctx.flags.require('MEMORY', userId);
    const W = { limit: 120, windowSec: 3600, by: 'user' } as const;
    const R = { limit: 600, windowSec: 600, by: 'user' } as const;
    const actorOf = (a: { userId: string; ageBand: 'teen' | 'adult' }) => ({
      userId: a.userId,
      ageBand: a.ageBand,
    });

    registerExportSection({
      key: 'memory',
      description: 'Your memories with their items and links, AI drafts, and video exports',
      collect: async (_c, db, u) => ({
        memories: (
          await db.query(
            `SELECT m.id, m.kind, m.title, m.summary, m.date_start, m.date_end, m.privacy, m.ai_generated, m.ai_provenance, m.source, m.created_at,
                  COALESCE((SELECT json_agg(json_build_object('type', i.item_type, 'id', i.item_id, 'position', i.position) ORDER BY i.position) FROM memory_items i WHERE i.memory_id = m.id), '[]') AS items,
                  COALESCE((SELECT json_agg(json_build_object('type', l.entity_type, 'id', l.entity_id)) FROM memory_links l WHERE l.memory_id = m.id), '[]') AS links
             FROM memories m WHERE m.owner_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 5000`,
            [u],
          )
        ).rows,
        aiDrafts: (
          await db.query(
            'SELECT id, memory_id, kind, payload, provider, model, status, created_at FROM memory_ai_drafts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000',
            [u],
          )
        ).rows,
        exports: (
          await db.query(
            'SELECT id, memory_id, kind, media_id, item_count, created_at FROM memory_exports WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000',
            [u],
          )
        ).rows,
        dismissedSuggestions: (
          await db.query(
            'SELECT key, created_at FROM memory_suggestion_dismissals WHERE user_id = $1',
            [u],
          )
        ).rows,
      }),
    });
    registerDeletionHook(async (_c, tx, userId) => purgeUserMemories(tx, userId));

    // ------------------------------------------------------------------ memories
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories',
      summary:
        "Create a memory (private by default). Items must be yours or visible to you; sharing never widens an item's audience.",
      tags: ['memory'],
      auth: 'user',
      body: createBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const id = await createMemory(ctx, actorOf(auth), body, req);
        void reply.code(201);
        return getMemoryView(ctx, auth.userId, id);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/memories',
      summary: 'My memories',
      tags: ['memory'],
      auth: 'user',
      rateLimit: R,
      query: pageQuery.extend({
        kind: z.enum(MEMORY_KINDS).optional(),
        privacy: z.enum(MEMORY_PRIVACY).optional(),
        q: z.string().trim().min(1).max(80).optional(),
      }),
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        return listMemories(ctx, auth.userId, { ...query, ownerId: auth.userId });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username/memories',
      summary:
        "A person's memories that you may open (friends/public), each showing only the items you may already see",
      tags: ['memory', 'profiles'],
      auth: 'optional',
      params: z.object({ username: z.string().min(1).max(40) }),
      query: pageQuery,
      rateLimit: R,
      handler: async ({ auth, params, query }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('MEMORY');
        const target = await resolveUser(ctx, auth?.userId ?? null, params.username);
        return listMemories(ctx, auth?.userId ?? null, { ...query, ownerId: target.id });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/memories/:id',
      summary: 'A memory (404 unless you may open it). Items are filtered per item for YOU.',
      tags: ['memory'],
      auth: 'optional',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('MEMORY');
        return getMemoryView(ctx, auth?.userId ?? null, params.id);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/memories/:id',
      summary:
        'Edit title, summary, dates or privacy (privacy changes are audited as sharing/unsharing)',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      body: patchBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await patchMemory(ctx, actorOf(auth), params.id, body, req);
        return getMemoryView(ctx, auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/memories/:id',
      summary:
        'Delete a memory (its items and links go; the underlying posts, moments and media are untouched)',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await deleteMemory(ctx, auth.userId, params.id, req);
      },
    });

    // ------------------------------------------------------------------ items & links
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/items',
      summary: 'Add items (yours, or visible to you). Messages: only ones you sent.',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      body: z.object({ items: z.array(itemRef).min(1).max(50) }),
      rateLimit: W,
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        return addItems(ctx, actorOf(auth), params.id, body.items);
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/memories/:id/items/order',
      summary: 'Reorder items (listed ones first)',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      body: z.object({ items: z.array(itemRef).min(1).max(500) }),
      rateLimit: W,
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        await reorderItems(ctx, auth.userId, params.id, body.items);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/memories/:id/items/:type/:itemId',
      summary: 'Remove an item from the memory (the item itself is untouched)',
      tags: ['memory'],
      auth: 'user',
      params: itemParams,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        await removeItem(ctx, auth.userId, params.id, params.type, params.itemId);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/links',
      summary: 'Organise by people (friends), places, events, trips, communities or experiences',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      body: z.object({ links: z.array(linkRef).min(1).max(20) }),
      rateLimit: W,
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        await addLinks(ctx, actorOf(auth), params.id, body.links);
        return getMemoryView(ctx, auth.userId, params.id);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/memories/:id/links/:type/:entityId',
      summary: 'Remove a link',
      tags: ['memory'],
      auth: 'user',
      params: linkParams,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        await removeLink(ctx, auth.userId, params.id, params.type, params.entityId);
      },
    });

    // ------------------------------------------------------------------ recap
    route(app, ctx, {
      method: 'GET',
      url: '/v1/memories/:id/recap',
      summary:
        'Deterministic (non-AI) recap of the items YOU can see: counts, date span, places, people',
      tags: ['memory'],
      auth: 'optional',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('MEMORY');
        return computeRecap(ctx, auth?.userId ?? null, params.id);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/recap/apply',
      summary: 'Save the deterministic recap as the memory summary (owner)',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return applyRecap(ctx, auth.userId, params.id);
      },
    });

    // ------------------------------------------------------------------ timeline & suggestions
    route(app, ctx, {
      method: 'GET',
      url: '/v1/memory/timeline',
      summary:
        'My life across posts, moments, Reals, events and experiences, filterable by date range, person, place and event',
      tags: ['memory'],
      auth: 'user',
      query: timelineQuery,
      rateLimit: R,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        return loadTimeline(ctx, auth.userId, query);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/memory/on-this-day',
      summary:
        'Suggestions from this day in earlier years (computed, never saved or shared until you accept)',
      tags: ['memory'],
      auth: 'user',
      query: z.object({ date: dateStr.optional() }),
      rateLimit: R,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        return {
          suggestions: await onThisDay(
            ctx,
            auth.userId,
            query.date ?? new Date().toISOString().slice(0, 10),
          ),
        };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memory/on-this-day/accept',
      summary: 'Turn a suggestion into a PRIVATE memory',
      tags: ['memory'],
      auth: 'user',
      body: z.object({
        date: dateStr,
        year: z.number().int().min(1970).max(2100),
        title: z.string().trim().min(1).max(120).optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const id = await acceptOnThisDay(ctx, actorOf(auth), body.date, body.year, body.title, req);
        void reply.code(201);
        return getMemoryView(ctx, auth.userId, id);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/memory/trips/suggestions',
      summary:
        'Trips detected from your geotagged items (computed; nothing is saved until you accept)',
      tags: ['memory'],
      auth: 'user',
      rateLimit: R,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        return { suggestions: await tripSuggestions(ctx, auth.userId) };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memory/trips/accept',
      summary: 'Turn a trip suggestion into a PRIVATE trip memory',
      tags: ['memory'],
      auth: 'user',
      body: z.object({
        key: z.string().regex(/^[0-9a-f]{24}$/),
        title: z.string().trim().min(1).max(120).optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const id = await acceptTrip(ctx, actorOf(auth), body.key, body.title, req);
        void reply.code(201);
        return getMemoryView(ctx, auth.userId, id);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memory/suggestions/dismiss',
      summary: 'Not now: hide a suggestion (key from the suggestion list)',
      tags: ['memory'],
      auth: 'user',
      body: z.object({ key: z.string().regex(/^(otd:\d{2}-\d{2}:\d{4}|trip:[0-9a-f]{24})$/) }),
      rateLimit: W,
      handler: async ({ auth, body }) => {
        await gate(auth.userId);
        await dismissSuggestion(ctx, auth.userId, body.key);
      },
    });

    // ------------------------------------------------------------------ AI (optional) and video export
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/ai-drafts',
      summary:
        'Ask AI for a title, summary or highlights DRAFT (needs AI consent; nothing changes until you confirm)',
      tags: ['memory', 'ai'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(AI_DRAFT_KINDS) }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, reply, params, body }) => {
        await gate(auth.userId);
        const d = await createAiDraft(ctx, actorOf(auth), params.id, body.kind);
        void reply.code(201);
        return d;
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/memories/:id/ai-drafts',
      summary: 'My AI drafts for this memory',
      tags: ['memory', 'ai'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return listAiDrafts(ctx, auth.userId, params.id);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/ai-drafts/:draftId/confirm',
      summary:
        'Apply a draft (optionally with your edit). The memory is then marked AI-generated with provenance.',
      tags: ['memory', 'ai'],
      auth: 'user',
      params: draftParams,
      body: z.object({ text: z.string().trim().min(1).max(2000).optional() }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await confirmAiDraft(ctx, auth.userId, params.id, params.draftId, body.text, req);
        return getMemoryView(ctx, auth.userId, params.id);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/ai-drafts/:draftId/discard',
      summary: 'Discard a draft',
      tags: ['memory', 'ai'],
      auth: 'user',
      params: draftParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        await discardAiDraft(ctx, auth.userId, params.id, params.draftId);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/memories/:id/exports/slideshow',
      summary:
        'Render a simple photo slideshow video from your own photos in this memory (503 processing_unavailable without ffmpeg)',
      tags: ['memory'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params }) => {
        await gate(auth.userId);
        const r = await exportSlideshow(ctx, auth.userId, params.id, req);
        void reply.code(201);
        return r;
      },
    });
  },
};
