import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import type * as AiUsage from '../ai/usage.js';
import type * as AiRuntime from '../ai/runtime.js';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { classifyText } from '@yapilapi/moderation';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { mediaUrl } from '../../lib/media-url.js';
import { momentVisibleSql, postVisibleSql } from '../../lib/visibility.js';
import { eventVisibleSql } from '../events/access.js';
import { getMediaRuntime } from '../media/runtime.js';
import { ingestUpload, mediaView } from '../media/service.js';
import { hasConsent } from '../privacy/index.js';
import { ownRealSql, realVisibleSql } from '../real/access.js';
import { experienceVisibleSql } from '../together/access.js';
import { memoryItemVisibleSql, memoryVisibleSql } from './access.js';
import { buildRecap, recapText, type Recap } from './recap.js';
import { clusterTrips, type GeoItem, type TripCandidate } from './trips.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw pg rows
type Row = Record<string, any>;
export interface Actor {
  userId: string;
  ageBand: 'teen' | 'adult';
}

export const MEMORY_KINDS = [
  'highlight',
  'recap',
  'timeline',
  'collection',
  'trip',
  'on_this_day',
] as const;
export const MEMORY_PRIVACY = ['private', 'friends', 'public'] as const;
export const ITEM_TYPES = [
  'post',
  'moment',
  'media',
  'event',
  'real_capture',
  'experience',
  'message',
] as const;
export const LINK_TYPES = ['person', 'place', 'event', 'trip', 'community', 'experience'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryPrivacy = (typeof MEMORY_PRIVACY)[number];
export type ItemType = (typeof ITEM_TYPES)[number];
export type LinkType = (typeof LINK_TYPES)[number];
export interface ItemRef {
  type: ItemType;
  id: string;
}
export interface LinkRef {
  type: LinkType;
  id: string;
}
export const MAX_ITEMS_PER_MEMORY = 500;
const UNAVAILABLE = 'One or more items cannot be added to a memory';

// ------------------------------------------------------------------------------------------------ item / link authorization
/**
 * Every id must be something the user may put in THEIR memory: their own media, messages they SENT (never other people's messages), their
 * own or currently visible posts/moments/Reals, events they attended and experiences they joined. Anything else fails with one generic message so
 * the endpoint cannot be used to probe for content the user cannot see.
 */
export async function assertItemsAddable(
  db: Queryable,
  userId: string,
  items: ItemRef[],
): Promise<void> {
  const byType = new Map<ItemType, string[]>();
  for (const i of items) byType.set(i.type, [...(byType.get(i.type) ?? []), i.id]);
  for (const [type, rawIds] of byType) {
    const ids = [...new Set(rawIds)];
    let sql: string;
    switch (type) {
      case 'post':
        sql = `SELECT p.id FROM posts p WHERE p.id = ANY($2::uuid[]) AND ${postVisibleSql('$1::uuid', 'p')}`;
        break;
      case 'moment':
        sql = `SELECT m.id FROM moments m WHERE m.id = ANY($2::uuid[]) AND ${momentVisibleSql('$1::uuid', 'm')}`;
        break;
      case 'media':
        sql = `SELECT m.id FROM media m WHERE m.id = ANY($2::uuid[]) AND m.owner_id = $1 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')`;
        break;
      case 'event':
        sql = `SELECT ev.id FROM events ev JOIN event_attendees a ON a.event_id = ev.id AND a.user_id = $1 AND a.status IN ('attended','going') WHERE ev.id = ANY($2::uuid[]) AND ${eventVisibleSql('$1::uuid', 'ev')}`;
        break;
      case 'real_capture':
        sql = `SELECT rc.id FROM real_captures rc WHERE rc.id = ANY($2::uuid[]) AND (${realVisibleSql('$1::uuid', 'rc')} OR ${ownRealSql('$1::uuid', 'rc')})`;
        break;
      case 'experience':
        sql = `SELECT se.id FROM shared_experiences se JOIN shared_experience_members sm ON sm.experience_id = se.id AND sm.user_id = $1 AND sm.status = 'joined' WHERE se.id = ANY($2::uuid[]) AND ${experienceVisibleSql('$1::uuid', 'se')}`;
        break;
      case 'message':
        sql = `SELECT ms.id FROM messages ms JOIN conversation_members cm ON cm.conversation_id = ms.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL WHERE ms.id = ANY($2::uuid[]) AND ms.sender_id = $1 AND ms.deleted_at IS NULL AND ms.moderation_status <> 'removed'`;
        break;
    }
    const { rows } = await db.query(sql, [userId, ids]);
    if (rows.length !== ids.length) throw invalid(UNAVAILABLE);
  }
}

/** Links organise a memory by people, places, events, trips, communities and experiences the user really has a relationship with. */
export async function assertLinksAllowed(
  db: Queryable,
  userId: string,
  links: LinkRef[],
): Promise<void> {
  for (const l of links) {
    let sql: string;
    switch (l.type) {
      case 'person':
        sql = `SELECT 1 FROM users u WHERE u.id = $2 AND u.deleted_at IS NULL AND u.status = 'active'
          AND (u.id = $1 OR (EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($1::uuid, u.id) AND fr.user_high = GREATEST($1::uuid, u.id) AND fr.status = 'accepted')
              AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))))`;
        break;
      case 'place':
        sql = `SELECT 1 FROM places WHERE id = $2 AND deleted_at IS NULL AND $1::uuid IS NOT NULL`;
        break;
      case 'event':
        sql = `SELECT 1 FROM events ev JOIN event_attendees a ON a.event_id = ev.id AND a.user_id = $1 AND a.status IN ('attended','going') WHERE ev.id = $2 AND ${eventVisibleSql('$1::uuid', 'ev')}`;
        break;
      case 'trip':
        sql = `SELECT 1 FROM memories WHERE id = $2 AND owner_id = $1 AND kind = 'trip' AND deleted_at IS NULL`;
        break;
      case 'community':
        sql = `SELECT 1 FROM community_members cm JOIN communities c ON c.id = cm.community_id AND c.deleted_at IS NULL WHERE cm.community_id = $2 AND cm.user_id = $1 AND cm.status = 'active'`;
        break;
      case 'experience':
        sql = `SELECT 1 FROM shared_experiences se JOIN shared_experience_members sm ON sm.experience_id = se.id AND sm.user_id = $1 AND sm.status = 'joined' WHERE se.id = $2 AND ${experienceVisibleSql('$1::uuid', 'se')}`;
        break;
    }
    const r = await db.query(sql, [userId, l.id]);
    if (!r.rowCount) throw invalid('One or more links cannot be added to a memory');
  }
}

// ------------------------------------------------------------------------------------------------ insert / create
export interface InsertMemoryInput {
  ownerId: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  dateStart: Date | null;
  dateEnd: Date | null;
  privacy: MemoryPrivacy;
  source: 'manual' | 'on_this_day' | 'trip' | 'experience_export';
  items: ItemRef[];
  links: LinkRef[];
}

/** Low-level insert (no authorization): callers validate items/links first. Used by manual creation, suggestions and the Together export. */
export async function insertMemory(tx: Queryable, i: InsertMemoryInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO memories (owner_id, kind, title, summary, date_start, date_end, privacy, source, shared_at) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8, CASE WHEN $7 = 'private' THEN NULL ELSE now() END) RETURNING id`,
    [i.ownerId, i.kind, i.title, i.summary, i.dateStart, i.dateEnd, i.privacy, i.source],
  );
  const id = rows[0]!.id;
  const seen = new Set<string>();
  let pos = 0;
  for (const it of i.items) {
    const k = `${it.type}:${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await tx.query(
      'INSERT INTO memory_items (memory_id, item_type, item_id, position) VALUES ($1,$2,$3,$4)',
      [id, it.type, it.id, pos++],
    );
  }
  for (const l of i.links)
    await tx.query(
      'INSERT INTO memory_links (memory_id, entity_type, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, l.type, l.id],
    );
  return id;
}

function assertTextOk(...texts: Array<string | undefined>): void {
  const t = texts.filter(Boolean).join(' ').trim();
  if (t && classifyText(t).status !== 'approved')
    throw new AppError('unprocessable', 'That text cannot be used. Please rephrase it.');
}

function assertPrivacyAllowed(actor: Actor, privacy: MemoryPrivacy): void {
  if (actor.ageBand === 'teen' && privacy === 'public')
    throw new AppError('unprocessable', 'Accounts under 18 cannot make memories public');
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  title: string;
  summary: string;
  dateStart?: string | undefined;
  dateEnd?: string | undefined;
  privacy: MemoryPrivacy;
  items: ItemRef[];
  links: LinkRef[];
}

export async function createMemory(
  ctx: AppContext,
  actor: Actor,
  i: CreateMemoryInput,
  req?: FastifyRequest,
): Promise<string> {
  assertTextOk(i.title, i.summary);
  assertPrivacyAllowed(actor, i.privacy);
  if (i.dateStart && i.dateEnd && i.dateEnd < i.dateStart)
    throw invalid('dateEnd must not be before dateStart');
  await assertItemsAddable(ctx.db, actor.userId, i.items);
  await assertLinksAllowed(ctx.db, actor.userId, i.links);
  const id = await withTransaction(ctx.db, async (tx) => {
    const mid = await insertMemory(tx, {
      ownerId: actor.userId,
      kind: i.kind,
      title: i.title.trim(),
      summary: i.summary.trim(),
      dateStart: i.dateStart ? new Date(i.dateStart) : null,
      dateEnd: i.dateEnd ? new Date(i.dateEnd) : null,
      privacy: i.privacy,
      source: 'manual',
      items: i.items,
      links: i.links,
    });
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'memory.created',
        targetType: 'memory',
        targetId: mid,
        metadata: { kind: i.kind, privacy: i.privacy },
      },
      req,
      tx,
    );
    if (i.privacy !== 'private')
      await audit(
        ctx,
        {
          actorId: actor.userId,
          action: 'memory.shared',
          targetType: 'memory',
          targetId: mid,
          metadata: { from: 'private', to: i.privacy },
        },
        req,
        tx,
      );
    return mid;
  });
  ctx.metrics.events.inc({ name: 'memory_created' });
  return id;
}

export interface PatchMemoryInput {
  title?: string | undefined;
  summary?: string | undefined;
  dateStart?: string | null | undefined;
  dateEnd?: string | null | undefined;
  privacy?: MemoryPrivacy | undefined;
}

async function loadOwned(db: Queryable, userId: string, id: string): Promise<Row> {
  const { rows } = await db.query(
    'SELECT * FROM memories WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
    [id, userId],
  );
  if (!rows[0]) throw notFound('Memory');
  return rows[0];
}

export async function patchMemory(
  ctx: AppContext,
  actor: Actor,
  id: string,
  p: PatchMemoryInput,
  req?: FastifyRequest,
): Promise<void> {
  const m = await loadOwned(ctx.db, actor.userId, id);
  assertTextOk(p.title, p.summary);
  if (p.privacy) assertPrivacyAllowed(actor, p.privacy);
  const ds = p.dateStart === undefined ? m.date_start : p.dateStart;
  const de = p.dateEnd === undefined ? m.date_end : p.dateEnd;
  if (ds && de && String(de) < String(ds) && typeof ds === 'string' && typeof de === 'string')
    throw invalid('dateEnd must not be before dateStart');
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE memories SET title = COALESCE($2, title), summary = COALESCE($3, summary),
              date_start = CASE WHEN $4::boolean THEN $5::date ELSE date_start END, date_end = CASE WHEN $6::boolean THEN $7::date ELSE date_end END,
              privacy = COALESCE($8, privacy),
              shared_at = CASE WHEN $8::text IS NOT NULL AND $8 <> 'private' AND privacy = 'private' THEN now() ELSE shared_at END,
              ai_provenance = CASE WHEN ai_generated AND ($2::text IS NOT NULL OR $3::text IS NOT NULL) THEN jsonb_set(ai_provenance, '{editedByUser}', 'true'::jsonb) ELSE ai_provenance END
        WHERE id = $1`,
      [
        id,
        p.title?.trim() ?? null,
        p.summary?.trim() ?? null,
        p.dateStart !== undefined,
        p.dateStart ?? null,
        p.dateEnd !== undefined,
        p.dateEnd ?? null,
        p.privacy ?? null,
      ],
    );
    if (p.privacy && p.privacy !== m.privacy) {
      await audit(
        ctx,
        {
          actorId: actor.userId,
          action: p.privacy === 'private' ? 'memory.unshared' : 'memory.shared',
          targetType: 'memory',
          targetId: id,
          metadata: { from: m.privacy, to: p.privacy },
        },
        req,
        tx,
      );
    }
  });
}

export async function deleteMemory(
  ctx: AppContext,
  userId: string,
  id: string,
  req?: FastifyRequest,
): Promise<void> {
  await loadOwned(ctx.db, userId, id);
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE memories SET deleted_at = now(), title = '', summary = '' WHERE id = $1`,
      [id],
    );
    await tx.query('DELETE FROM memory_items WHERE memory_id = $1', [id]);
    await tx.query('DELETE FROM memory_links WHERE memory_id = $1', [id]);
    await tx.query('DELETE FROM memory_ai_drafts WHERE memory_id = $1', [id]);
    await tx.query(`DELETE FROM memory_links WHERE entity_type = 'trip' AND entity_id = $1`, [id]);
    await audit(
      ctx,
      { actorId: userId, action: 'memory.deleted', targetType: 'memory', targetId: id },
      req,
      tx,
    );
  });
}

// ------------------------------------------------------------------------------------------------ items & links
export async function addItems(
  ctx: AppContext,
  actor: Actor,
  id: string,
  items: ItemRef[],
): Promise<{ added: number }> {
  await loadOwned(ctx.db, actor.userId, id);
  await assertItemsAddable(ctx.db, actor.userId, items);
  return withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM memories WHERE id = $1 FOR UPDATE', [id]);
    const cur = await tx.query<{ n: number; p: number }>(
      'SELECT count(*)::int AS n, COALESCE(max(position), -1)::int AS p FROM memory_items WHERE memory_id = $1',
      [id],
    );
    let pos = cur.rows[0]!.p + 1;
    let added = 0;
    for (const it of items) {
      if (cur.rows[0]!.n + added >= MAX_ITEMS_PER_MEMORY)
        throw conflict(`A memory can hold at most ${MAX_ITEMS_PER_MEMORY} items`);
      const r = await tx.query(
        'INSERT INTO memory_items (memory_id, item_type, item_id, position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [id, it.type, it.id, pos],
      );
      if (r.rowCount) {
        added++;
        pos++;
      }
    }
    return { added };
  });
}

export async function removeItem(
  ctx: AppContext,
  userId: string,
  id: string,
  type: ItemType,
  itemId: string,
): Promise<void> {
  await loadOwned(ctx.db, userId, id);
  const r = await ctx.db.query(
    'DELETE FROM memory_items WHERE memory_id = $1 AND item_type = $2 AND item_id = $3',
    [id, type, itemId],
  );
  if (!r.rowCount) throw notFound('Item');
}

/** Put `first` at the front (in that order) and keep every other item after them in its current order. Items in `first` that are not in the memory are ignored unless `strict`. */
async function applyOrder(
  tx: Queryable,
  id: string,
  first: ItemRef[],
  strict: boolean,
): Promise<void> {
  const cur = await tx.query<{ item_type: ItemType; item_id: string }>(
    'SELECT item_type, item_id FROM memory_items WHERE memory_id = $1 ORDER BY position, item_type, item_id',
    [id],
  );
  const have = new Set(cur.rows.map((r) => `${r.item_type}:${r.item_id}`));
  const head = first.filter(
    (f, i) => first.findIndex((g) => g.type === f.type && g.id === f.id) === i,
  );
  if (strict && head.some((h) => !have.has(`${h.type}:${h.id}`)))
    throw invalid('Ordering contains an item that is not in the memory');
  const headKeys = new Set(head.map((h) => `${h.type}:${h.id}`));
  const ordered = [
    ...head.filter((h) => have.has(`${h.type}:${h.id}`)).map((h) => ({ type: h.type, id: h.id })),
    ...cur.rows
      .filter((r) => !headKeys.has(`${r.item_type}:${r.item_id}`))
      .map((r) => ({ type: r.item_type, id: r.item_id })),
  ];
  for (const [pos, it] of ordered.entries())
    await tx.query(
      'UPDATE memory_items SET position = $4 WHERE memory_id = $1 AND item_type = $2 AND item_id = $3',
      [id, it.type, it.id, pos],
    );
}

export async function reorderItems(
  ctx: AppContext,
  userId: string,
  id: string,
  order: ItemRef[],
): Promise<void> {
  await loadOwned(ctx.db, userId, id);
  await withTransaction(ctx.db, (tx) => applyOrder(tx, id, order, true));
}

export async function addLinks(
  ctx: AppContext,
  actor: Actor,
  id: string,
  links: LinkRef[],
): Promise<void> {
  await loadOwned(ctx.db, actor.userId, id);
  await assertLinksAllowed(ctx.db, actor.userId, links);
  for (const l of links)
    await ctx.db.query(
      'INSERT INTO memory_links (memory_id, entity_type, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, l.type, l.id],
    );
}

export async function removeLink(
  ctx: AppContext,
  userId: string,
  id: string,
  type: LinkType,
  entityId: string,
): Promise<void> {
  await loadOwned(ctx.db, userId, id);
  const r = await ctx.db.query(
    'DELETE FROM memory_links WHERE memory_id = $1 AND entity_type = $2 AND entity_id = $3',
    [id, type, entityId],
  );
  if (!r.rowCount) throw notFound('Link');
}

// ------------------------------------------------------------------------------------------------ views
export interface ItemPreview {
  type: ItemType;
  id: string;
  position: number;
  at: string | null;
  text: string;
  kind: string | null;
  placeId: string | null;
  mediaUrl: string | null;
}

const snippet = (s: unknown, n = 160): string => (typeof s === 'string' ? s.slice(0, n) : '');

/** Cheap previews for items ALREADY filtered by memoryItemVisibleSql (no visibility decisions are made here). */
async function previews(
  ctx: AppContext,
  rows: Array<{ item_type: ItemType; item_id: string; position: number }>,
): Promise<ItemPreview[]> {
  const ids = (t: ItemType) => rows.filter((r) => r.item_type === t).map((r) => r.item_id);
  const q = async (t: ItemType, sql: string): Promise<Map<string, Row>> => {
    const list = ids(t);
    if (!list.length) return new Map();
    return new Map((await ctx.db.query(sql, [list])).rows.map((r) => [r.id as string, r]));
  };
  const [post, moment, media, event, real, exp, msg] = await Promise.all([
    q(
      'post',
      `SELECT p.id, p.kind, p.body AS text, p.created_at AS at, p.place_id, (SELECT m.storage_key FROM post_media pm JOIN media m ON m.id = pm.media_id AND m.deleted_at IS NULL WHERE pm.post_id = p.id ORDER BY pm.position LIMIT 1) AS key FROM posts p WHERE p.id = ANY($1::uuid[])`,
    ),
    q(
      'moment',
      `SELECT m.id, m.kind, m.body AS text, m.created_at AS at, m.place_id, md.storage_key AS key FROM moments m LEFT JOIN media md ON md.id = m.media_id AND md.deleted_at IS NULL WHERE m.id = ANY($1::uuid[])`,
    ),
    q(
      'media',
      `SELECT m.id, m.kind, COALESCE(m.alt_text, '') AS text, m.created_at AS at, NULL::uuid AS place_id, m.storage_key AS key FROM media m WHERE m.id = ANY($1::uuid[])`,
    ),
    q(
      'event',
      `SELECT e.id, 'event' AS kind, e.title AS text, e.starts_at AS at, e.place_id, NULL AS key FROM events e WHERE e.id = ANY($1::uuid[])`,
    ),
    q(
      'real_capture',
      `SELECT r.id, 'real' AS kind, r.caption AS text, r.captured_at AS at, NULL::uuid AS place_id, COALESCE(rm.storage_key, fm.storage_key) AS key FROM real_captures r
        LEFT JOIN media rm ON rm.id = r.rear_media_id AND rm.deleted_at IS NULL LEFT JOIN media fm ON fm.id = r.front_media_id AND fm.deleted_at IS NULL WHERE r.id = ANY($1::uuid[])`,
    ),
    q(
      'experience',
      `SELECT e.id, 'experience' AS kind, e.title AS text, COALESCE(e.starts_at, e.created_at) AS at, e.place_id, NULL AS key FROM shared_experiences e WHERE e.id = ANY($1::uuid[])`,
    ),
    q(
      'message',
      `SELECT m.id, m.kind, m.body AS text, m.created_at AS at, NULL::uuid AS place_id, NULL AS key FROM messages m WHERE m.id = ANY($1::uuid[])`,
    ),
  ]);
  const by: Record<ItemType, Map<string, Row>> = {
    post,
    moment,
    media,
    event,
    real_capture: real,
    experience: exp,
    message: msg,
  };
  const out: ItemPreview[] = [];
  for (const r of rows) {
    const d = by[r.item_type].get(r.item_id);
    if (!d) continue;
    out.push({
      type: r.item_type,
      id: r.item_id,
      position: r.position,
      at: d.at ? new Date(d.at).toISOString() : null,
      text: snippet(d.text),
      kind: d.kind ?? null,
      placeId: d.place_id ?? null,
      mediaUrl: d.key ? mediaUrl(ctx.config, d.key) : null,
    });
  }
  return out;
}

/** The items of a memory that `viewerId` may see RIGHT NOW, each judged by its own audience rule (the non-widening property). */
export async function loadVisibleItems(
  ctx: AppContext,
  viewerId: string | null,
  memoryId: string,
): Promise<{ items: ItemPreview[]; total: number }> {
  const { rows } = await ctx.db.query<{ item_type: ItemType; item_id: string; position: number }>(
    `SELECT mi.item_type, mi.item_id, mi.position FROM memory_items mi JOIN memories mem ON mem.id = mi.memory_id
      WHERE mi.memory_id = $2 AND ${memoryItemVisibleSql('$1::uuid')} ORDER BY mi.position, mi.item_type, mi.item_id LIMIT ${MAX_ITEMS_PER_MEMORY}`,
    [viewerId, memoryId],
  );
  const total = (
    await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM memory_items WHERE memory_id = $1',
      [memoryId],
    )
  ).rows[0]!.n;
  return { items: await previews(ctx, rows), total };
}

/** Links, filtered so a memory never reveals a person or place to someone who should not learn of them. */
async function loadLinks(
  ctx: AppContext,
  viewerId: string | null,
  memoryId: string,
  ownerId: string,
) {
  const { rows } = await ctx.db.query(
    `SELECT ml.entity_type, ml.entity_id,
            CASE ml.entity_type
              WHEN 'person' THEN (SELECT pr.display_name FROM profiles pr WHERE pr.user_id = ml.entity_id)
              WHEN 'place' THEN (SELECT pl.name FROM places pl WHERE pl.id = ml.entity_id)
              WHEN 'event' THEN (SELECT ev.title FROM events ev WHERE ev.id = ml.entity_id)
              WHEN 'trip' THEN (SELECT tm.title FROM memories tm WHERE tm.id = ml.entity_id AND tm.deleted_at IS NULL)
              WHEN 'community' THEN (SELECT cm.name FROM communities cm WHERE cm.id = ml.entity_id)
              WHEN 'experience' THEN (SELECT se.title FROM shared_experiences se WHERE se.id = ml.entity_id AND se.deleted_at IS NULL)
            END AS label
       FROM memory_links ml
      WHERE ml.memory_id = $2 AND (
        $1::uuid = $3::uuid  -- the owner sees all their links
        OR CASE ml.entity_type
          WHEN 'person' THEN ($1::uuid IS NOT NULL AND (ml.entity_id = $1 OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($1::uuid, ml.entity_id) AND fr.user_high = GREATEST($1::uuid, ml.entity_id) AND fr.status = 'accepted')))
            AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE $1::uuid IS NOT NULL AND ((b.blocker_id = $1 AND b.blocked_id = ml.entity_id) OR (b.blocker_id = ml.entity_id AND b.blocked_id = $1)))
          WHEN 'place' THEN true
          WHEN 'event' THEN EXISTS (SELECT 1 FROM events ev WHERE ev.id = ml.entity_id AND ${eventVisibleSql('$1::uuid', 'ev')})
          WHEN 'experience' THEN EXISTS (SELECT 1 FROM shared_experiences se WHERE se.id = ml.entity_id AND ${experienceVisibleSql('$1::uuid', 'se')})
          WHEN 'trip' THEN EXISTS (SELECT 1 FROM memories tm WHERE tm.id = ml.entity_id AND ${memoryVisibleSql('$1::uuid', 'tm')})
          ELSE false END)
      ORDER BY ml.entity_type, ml.entity_id`,
    [viewerId, memoryId, ownerId],
  );
  return rows
    .filter((r) => r.label !== null)
    .map((r) => ({
      type: r.entity_type as LinkType,
      id: r.entity_id as string,
      label: r.label as string,
    }));
}

const MEM_SELECT = `mem.id, mem.owner_id, mem.kind, mem.title, mem.summary, mem.date_start::text AS date_start, mem.date_end::text AS date_end, mem.privacy, mem.ai_generated, mem.ai_provenance,
  mem.source, mem.shared_at, mem.created_at, mem.updated_at, pr.username, pr.display_name, pr.avatar_url`;
const MEM_FROM = 'memories mem JOIN profiles pr ON pr.user_id = mem.owner_id';

function memoryHead(r: Row, viewerId: string | null) {
  const own = viewerId === r.owner_id;
  return {
    id: r.id,
    owner: {
      id: r.owner_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
    },
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    dateStart: r.date_start,
    dateEnd: r.date_end,
    privacy: r.privacy,
    aiGenerated: r.ai_generated,
    aiProvenance: r.ai_provenance,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    viewer: { isOwner: own },
    ...(own
      ? { source: r.source, sharedAt: r.shared_at ? new Date(r.shared_at).toISOString() : null }
      : {}),
  };
}

export async function getMemoryView(ctx: AppContext, viewerId: string | null, id: string) {
  const { rows } = await ctx.db.query(
    `SELECT ${MEM_SELECT} FROM ${MEM_FROM} WHERE mem.id = $2 AND ${memoryVisibleSql('$1::uuid')}`,
    [viewerId, id],
  );
  const r = rows[0];
  if (!r) throw notFound('Memory');
  const [{ items, total }, links] = await Promise.all([
    loadVisibleItems(ctx, viewerId, id),
    loadLinks(ctx, viewerId, id, r.owner_id),
  ]);
  const own = viewerId === r.owner_id;
  return {
    ...memoryHead(r, viewerId),
    items,
    itemCount: items.length,
    links,
    ...(own ? { unavailableItemCount: total - items.length } : {}),
  };
}

export async function listMemories(
  ctx: AppContext,
  viewerId: string | null,
  o: {
    ownerId: string;
    kind?: string | undefined;
    privacy?: string | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  },
) {
  const limit = clampLimit(o.limit);
  const cur = decodeCursor<{ t: string; id: string }>(o.cursor);
  const { rows } = await ctx.db.query(
    `SELECT ${MEM_SELECT}, (SELECT count(*)::int FROM memory_items mi JOIN memories mm ON mm.id = mi.memory_id WHERE mi.memory_id = mem.id AND ${memoryItemVisibleSql('$1::uuid', 'mi', 'mm')}) AS visible_items
       FROM ${MEM_FROM}
      WHERE mem.owner_id = $2 AND ${memoryVisibleSql('$1::uuid')}
        AND ($3::text IS NULL OR mem.kind = $3) AND ($4::text IS NULL OR mem.privacy = $4) AND ($5::text IS NULL OR mem.title ILIKE '%' || $5 || '%')
        AND ($6::timestamptz IS NULL OR (mem.created_at, mem.id) < ($6::timestamptz, $7::uuid))
      ORDER BY mem.created_at DESC, mem.id DESC LIMIT $8`,
    [
      viewerId,
      o.ownerId,
      o.kind ?? null,
      o.privacy ?? null,
      o.q?.replace(/[%_\\]/g, '\\$&') ?? null,
      cur?.t ?? null,
      cur?.id ?? null,
      limit + 1,
    ],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...memoryHead(r, viewerId), itemCount: r.visible_items })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
        : null,
  };
}

// ------------------------------------------------------------------------------------------------ recap
export async function computeRecap(
  ctx: AppContext,
  viewerId: string | null,
  id: string,
): Promise<{ recap: Recap; text: string }> {
  const { rows } = await ctx.db.query(
    `SELECT mem.owner_id FROM memories mem WHERE mem.id = $2 AND ${memoryVisibleSql('$1::uuid')}`,
    [viewerId, id],
  );
  if (!rows[0]) throw notFound('Memory');
  const { items } = await loadVisibleItems(ctx, viewerId, id);
  const links = await loadLinks(ctx, viewerId, id, rows[0].owner_id);
  const recap = buildRecap(
    items.map((i) => ({ type: i.type, at: i.at ? new Date(i.at) : null, placeId: i.placeId })),
    {
      extraPlaceIds: links.filter((l) => l.type === 'place').map((l) => l.id),
      peopleCount: links.filter((l) => l.type === 'person').length,
    },
  );
  return { recap, text: recapText(recap) };
}

export async function applyRecap(
  ctx: AppContext,
  userId: string,
  id: string,
): Promise<{ summary: string }> {
  await loadOwned(ctx.db, userId, id);
  const { recap, text } = await computeRecap(ctx, userId, id);
  await ctx.db.query(
    'UPDATE memories SET summary = $2, date_start = COALESCE(date_start, $3::date), date_end = COALESCE(date_end, $4::date) WHERE id = $1',
    [id, text, recap.dateStart, recap.dateEnd],
  );
  return { summary: text };
}

// ------------------------------------------------------------------------------------------------ timeline (the owner's own life, across sources)
export interface TimelineQuery {
  from?: Date | undefined;
  to?: Date | undefined;
  placeId?: string | undefined;
  eventId?: string | undefined;
  personId?: string | undefined;
  types?: ItemType[] | undefined;
  order: 'asc' | 'desc';
  cursor?: string | undefined;
  limit?: number | undefined;
}

const SOURCES = `
  SELECT 'post'::text AS item_type, p.id AS item_id, p.created_at AS at, p.place_id, p.event_id FROM posts p WHERE p.author_id = $1 AND p.deleted_at IS NULL AND p.moderation_status <> 'removed'
  UNION ALL
  SELECT 'moment', m.id, m.created_at, m.place_id, NULL::uuid FROM moments m WHERE m.author_id = $1 AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
  UNION ALL
  SELECT 'real_capture', r.id, r.captured_at, NULL::uuid, NULL::uuid FROM real_captures r WHERE r.author_id = $1 AND r.deleted_at IS NULL
  UNION ALL
  SELECT 'event', e.id, e.starts_at, e.place_id, e.id FROM event_attendees a JOIN events e ON e.id = a.event_id AND e.deleted_at IS NULL
   WHERE a.user_id = $1 AND (a.status = 'attended' OR (a.status = 'going' AND e.status = 'completed')) AND e.status IN ('published','completed') AND e.starts_at < now()
  UNION ALL
  SELECT 'experience', se.id, COALESCE(se.starts_at, se.created_at), se.place_id, se.event_id FROM shared_experience_members sm JOIN shared_experiences se ON se.id = sm.experience_id AND se.deleted_at IS NULL
   WHERE sm.user_id = $1 AND sm.status = 'joined'`;

export async function loadTimeline(ctx: AppContext, userId: string, q: TimelineQuery) {
  if (q.personId) {
    const p = await ctx.db.query(
      `SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($1::uuid, $2::uuid) AND fr.user_high = GREATEST($1::uuid, $2::uuid) AND fr.status = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1))`,
      [userId, q.personId],
    );
    if (!p.rowCount) throw notFound('Person');
  }
  const limit = clampLimit(q.limit);
  const cur = decodeCursor<{ t: string; id: string; ty: string }>(q.cursor);
  const op = q.order === 'asc' ? '>' : '<';
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await ctx.db.query<{ item_type: ItemType; item_id: string; at: Date }>(
    `SELECT t.item_type, t.item_id, t.at FROM (${SOURCES}) t
      WHERE ($2::timestamptz IS NULL OR t.at >= $2) AND ($3::timestamptz IS NULL OR t.at < $3)
        AND ($4::uuid IS NULL OR t.place_id = $4)
        AND ($5::uuid IS NULL OR t.event_id = $5)
        AND ($6::uuid IS NULL OR t.event_id IN (SELECT a.event_id FROM event_attendees a WHERE a.user_id = $6 AND a.status IN ('attended','going'))
             OR (t.item_type = 'experience' AND EXISTS (SELECT 1 FROM shared_experience_members x WHERE x.experience_id = t.item_id AND x.user_id = $6 AND x.status = 'joined')))
        AND ($7::text[] IS NULL OR t.item_type = ANY($7))
        AND ($8::timestamptz IS NULL OR (t.at, t.item_id) ${op} ($8::timestamptz, $9::uuid))
      ORDER BY t.at ${dir}, t.item_id ${dir} LIMIT $10`,
    [
      userId,
      q.from ?? null,
      q.to ?? null,
      q.placeId ?? null,
      q.eventId ?? null,
      q.personId ?? null,
      q.types ?? null,
      cur?.t ?? null,
      cur?.id ?? null,
      limit + 1,
    ],
  );
  const page = rows.slice(0, limit);
  const pv = await previews(
    ctx,
    page.map((r, i) => ({ item_type: r.item_type, item_id: r.item_id, position: i })),
  );
  const key = (t: string, id: string) => `${t}:${id}`;
  const byKey = new Map(pv.map((p) => [key(p.type, p.id), p]));
  const last = page[page.length - 1];
  return {
    items: page.map((r) => byKey.get(key(r.item_type, r.item_id))).filter(Boolean),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: last.at.toISOString(), id: last.item_id, ty: last.item_type })
        : null,
  };
}

// ------------------------------------------------------------------------------------------------ on this day (deterministic; never auto-created, never auto-shared)
export interface OnThisDaySuggestion {
  key: string;
  year: number;
  date: string;
  itemCount: number;
  items: ItemPreview[];
}

async function userTimezone(ctx: AppContext, userId: string): Promise<string> {
  const { rows } = await ctx.db.query<{ tz: string | null }>(
    'SELECT COALESCE(up.timezone, u.timezone) AS tz FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1',
    [userId],
  );
  const tz = rows[0]?.tz ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** `date` is YYYY-MM-DD in the user's own time zone. Items from the same month and day in earlier years, grouped by year (newest year first). */
export async function onThisDay(
  ctx: AppContext,
  userId: string,
  date: string,
  opts: { maxYears?: number } = {},
): Promise<OnThisDaySuggestion[]> {
  const tz = await userTimezone(ctx, userId);
  const year = Number(date.slice(0, 4));
  const md = date.slice(5);
  const { rows } = await ctx.db.query<{
    item_type: ItemType;
    item_id: string;
    at: Date;
    y: number;
  }>(
    `SELECT t.item_type, t.item_id, t.at, EXTRACT(YEAR FROM t.at AT TIME ZONE $2)::int AS y FROM (${SOURCES}) t
      WHERE to_char(t.at AT TIME ZONE $2, 'MM-DD') = $3 AND EXTRACT(YEAR FROM t.at AT TIME ZONE $2) < $4 AND EXTRACT(YEAR FROM t.at AT TIME ZONE $2) >= $5
      ORDER BY t.at, t.item_id LIMIT 500`,
    [userId, tz, md, year, year - (opts.maxYears ?? 10)],
  );
  const dismissed = new Set(
    (
      await ctx.db.query<{ key: string }>(
        'SELECT key FROM memory_suggestion_dismissals WHERE user_id = $1 AND key LIKE $2',
        [userId, `otd:${md}:%`],
      )
    ).rows.map((r) => r.key),
  );
  const byYear = new Map<number, typeof rows>();
  for (const r of rows) byYear.set(r.y, [...(byYear.get(r.y) ?? []), r]);
  const out: OnThisDaySuggestion[] = [];
  for (const y of [...byYear.keys()].sort((a, b) => b - a)) {
    const key = `otd:${md}:${y}`;
    if (dismissed.has(key)) continue;
    const list = byYear.get(y)!.slice(0, 30);
    out.push({
      key,
      year: y,
      date: `${y}-${md}`,
      itemCount: byYear.get(y)!.length,
      items: await previews(
        ctx,
        list.map((r, i) => ({ item_type: r.item_type, item_id: r.item_id, position: i })),
      ),
    });
  }
  return out;
}

export async function dismissSuggestion(
  ctx: AppContext,
  userId: string,
  key: string,
): Promise<void> {
  await ctx.db.query(
    'INSERT INTO memory_suggestion_dismissals (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [userId, key],
  );
}

/** The user explicitly accepts a suggestion: only then does a (private) memory exist. */
export async function acceptOnThisDay(
  ctx: AppContext,
  actor: Actor,
  date: string,
  year: number,
  title: string | undefined,
  req?: FastifyRequest,
): Promise<string> {
  const s = (await onThisDay(ctx, actor.userId, date)).find((x) => x.year === year);
  if (!s) throw notFound('Suggestion');
  const full = await ctx.db.query<{ item_type: ItemType; item_id: string; at: Date }>(
    `SELECT t.item_type, t.item_id, t.at FROM (${SOURCES}) t WHERE to_char(t.at AT TIME ZONE $2, 'MM-DD') = $3 AND EXTRACT(YEAR FROM t.at AT TIME ZONE $2) = $4 ORDER BY t.at, t.item_id LIMIT 200`,
    [actor.userId, await userTimezone(ctx, actor.userId), date.slice(5), year],
  );
  const id = await withTransaction(ctx.db, async (tx) => {
    const mid = await insertMemory(tx, {
      ownerId: actor.userId,
      kind: 'on_this_day',
      title: (title ?? `On this day in ${year}`).trim(),
      summary: '',
      dateStart: new Date(`${year}-${date.slice(5)}`),
      dateEnd: new Date(`${year}-${date.slice(5)}`),
      privacy: 'private',
      source: 'on_this_day',
      items: full.rows.map((r) => ({ type: r.item_type, id: r.item_id })),
      links: [],
    });
    await tx.query(
      'INSERT INTO memory_suggestion_dismissals (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [actor.userId, s.key],
    );
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'memory.created',
        targetType: 'memory',
        targetId: mid,
        metadata: { kind: 'on_this_day', privacy: 'private', source: 'suggestion' },
      },
      req,
      tx,
    );
    return mid;
  });
  return id;
}

// ------------------------------------------------------------------------------------------------ trips
async function geoItems(ctx: AppContext, userId: string): Promise<GeoItem[]> {
  const { rows } = await ctx.db.query<{
    type: string;
    id: string;
    at: Date;
    lat: number;
    lng: number;
  }>(
    `SELECT 'post' AS type, p.id, p.created_at AS at, p.latitude AS lat, p.longitude AS lng FROM posts p WHERE p.author_id = $1 AND p.deleted_at IS NULL AND p.latitude IS NOT NULL AND p.created_at > now() - interval '3 years'
     UNION ALL
     SELECT 'moment', m.id, m.created_at, m.latitude, m.longitude FROM moments m WHERE m.author_id = $1 AND m.deleted_at IS NULL AND m.latitude IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at > now())
     UNION ALL
     SELECT 'real_capture', r.id, r.captured_at, r.latitude, r.longitude FROM real_captures r WHERE r.author_id = $1 AND r.deleted_at IS NULL AND r.latitude IS NOT NULL AND r.captured_at > now() - interval '3 years'
     UNION ALL
     SELECT 'event', e.id, e.starts_at, e.latitude, e.longitude FROM event_attendees a JOIN events e ON e.id = a.event_id AND e.deleted_at IS NULL
      WHERE a.user_id = $1 AND (a.status = 'attended' OR (a.status = 'going' AND e.status = 'completed')) AND e.latitude IS NOT NULL AND e.starts_at < now() AND e.starts_at > now() - interval '3 years'
     ORDER BY at LIMIT 5000`,
    [userId],
  );
  return rows.map((r) => ({ type: r.type, id: r.id, at: r.at, latitude: r.lat, longitude: r.lng }));
}

export async function tripSuggestions(ctx: AppContext, userId: string) {
  const trips = clusterTrips(await geoItems(ctx, userId));
  const done = new Set(
    (
      await ctx.db.query<{ key: string }>(
        `SELECT key FROM memory_suggestion_dismissals WHERE user_id = $1 AND key LIKE 'trip:%'`,
        [userId],
      )
    ).rows.map((r) => r.key),
  );
  return trips
    .filter((t) => !done.has(`trip:${t.key}`))
    .map((t) => ({
      key: t.key,
      startAt: t.startAt.toISOString(),
      endAt: t.endAt.toISOString(),
      itemCount: t.items.length,
      distinctDays: t.distinctDays,
      centroid: t.centroid,
      maxDistanceFromHomeKm: t.maxDistanceFromHomeKm,
    }));
}

export async function acceptTrip(
  ctx: AppContext,
  actor: Actor,
  key: string,
  title: string | undefined,
  req?: FastifyRequest,
): Promise<string> {
  const trip: TripCandidate | undefined = clusterTrips(await geoItems(ctx, actor.userId)).find(
    (t) => t.key === key,
  );
  if (!trip) throw notFound('Suggestion');
  const id = await withTransaction(ctx.db, async (tx) => {
    const mid = await insertMemory(tx, {
      ownerId: actor.userId,
      kind: 'trip',
      title: (title ?? `Trip, ${trip.startAt.toISOString().slice(0, 10)}`).trim(),
      summary: '',
      dateStart: trip.startAt,
      dateEnd: trip.endAt,
      privacy: 'private',
      source: 'trip',
      items: trip.items as ItemRef[],
      links: [],
    });
    await tx.query(
      'INSERT INTO memory_suggestion_dismissals (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [actor.userId, `trip:${key}`],
    );
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'memory.created',
        targetType: 'memory',
        targetId: mid,
        metadata: { kind: 'trip', privacy: 'private', source: 'suggestion' },
      },
      req,
      tx,
    );
    return mid;
  });
  return id;
}

// ------------------------------------------------------------------------------------------------ AI drafts (optional; the human confirms)
type AiModules = { usage: typeof AiUsage; runtime: typeof AiRuntime };

/** The AI module is optional: when it is not in this build the feature answers "unavailable" instead of pretending. */
async function loadAi(): Promise<AiModules | null> {
  try {
    const [usage, runtime] = await Promise.all([
      import('../ai/usage.js'),
      import('../ai/runtime.js'),
    ]);
    return { usage, runtime };
  } catch {
    return null;
  }
}

export const AI_DRAFT_KINDS = ['title', 'summary', 'highlights'] as const;
export type AiDraftKind = (typeof AI_DRAFT_KINDS)[number];

const draftView = (r: Row) => ({
  id: r.id,
  memoryId: r.memory_id,
  kind: r.kind,
  payload: r.payload,
  provider: r.provider,
  model: r.model,
  status: r.status,
  createdAt: new Date(r.created_at).toISOString(),
});

export async function createAiDraft(
  ctx: AppContext,
  actor: Actor,
  memoryId: string,
  kind: AiDraftKind,
) {
  const m = await loadOwned(ctx.db, actor.userId, memoryId);
  if (!ctx.config.AI_ENABLED)
    throw new AppError('unavailable', 'AI features are turned off', { reason: 'ai_unavailable' });
  const ai = await loadAi();
  if (!ai)
    throw new AppError('unavailable', 'AI is not available in this deployment', {
      reason: 'ai_unavailable',
    });
  if (!(await hasConsent(ctx, actor.userId, 'ai_processing')))
    throw forbidden('Turn on AI assistance in your privacy settings first');

  const { items } = await loadVisibleItems(ctx, actor.userId, memoryId);
  // Only facts the user themself wrote or that are structural. Other people's text never goes to a model provider.
  const own = await ctx.db.query<{ id: string }>(
    `SELECT id FROM posts WHERE author_id = $1 AND id = ANY($2::uuid[])
     UNION SELECT id FROM real_captures WHERE author_id = $1 AND id = ANY($2::uuid[])
     UNION SELECT id FROM moments WHERE author_id = $1 AND id = ANY($2::uuid[])`,
    [actor.userId, items.map((i) => i.id)],
  );
  const mine = new Set(own.rows.map((r) => r.id));
  const facts = items.slice(0, 40).map((i, n) => ({
    n,
    type: i.type,
    date: i.at?.slice(0, 10) ?? null,
    text: mine.has(i.id) || i.type === 'event' || i.type === 'experience' ? i.text : '',
  }));
  const recap = (await computeRecap(ctx, actor.userId, memoryId)).recap;
  const system =
    kind === 'highlights'
      ? 'You choose the most representative items of a personal memory. Reply with JSON only: {"picks":[numbers]} using at most 5 of the given item numbers n. Use only the given facts.'
      : `You write a ${kind === 'title' ? 'short title (max 8 words)' : 'warm two-sentence summary'} for a personal memory. Use ONLY the facts given. Do not invent people, places or events. Reply with plain text only.`;
  const rt = ai.runtime.getAiRuntime(ctx);
  const { response } = await ai.usage.callModel(ctx, rt, actor.userId, {
    task: 'summarise',
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({ memoryTitle: m.title, kind: m.kind, recap, items: facts }),
      },
    ],
    ...(kind === 'highlights' ? { json: true } : {}),
  } as never);
  let payload: Record<string, unknown>;
  if (kind === 'highlights') {
    let picks: unknown;
    try {
      picks = (
        JSON.parse(response.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
          picks?: unknown;
        }
      ).picks;
    } catch {
      picks = null;
    }
    const ok = Array.isArray(picks)
      ? [
          ...new Set(
            picks.filter((p): p is number => Number.isInteger(p) && p >= 0 && p < facts.length),
          ),
        ].slice(0, 5)
      : [];
    if (!ok.length)
      throw new AppError('unprocessable', 'The AI did not return a usable selection', {
        reason: 'ai_unusable_output',
      });
    payload = { items: ok.map((n) => ({ type: items[n]!.type, id: items[n]!.id })) };
  } else {
    const text = response.content.trim().slice(0, kind === 'title' ? 120 : 800);
    if (!text || classifyText(text).status !== 'approved')
      throw new AppError('unprocessable', 'The AI did not return usable text', {
        reason: 'ai_unusable_output',
      });
    payload = { text };
  }
  const { rows } = await ctx.db.query(
    `INSERT INTO memory_ai_drafts (memory_id, user_id, kind, payload, provider, model) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [memoryId, actor.userId, kind, JSON.stringify(payload), response.provider, response.model],
  );
  return draftView(rows[0]!);
}

export async function listAiDrafts(ctx: AppContext, userId: string, memoryId: string) {
  await loadOwned(ctx.db, userId, memoryId);
  const { rows } = await ctx.db.query(
    'SELECT * FROM memory_ai_drafts WHERE memory_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50',
    [memoryId, userId],
  );
  return { items: rows.map(draftView) };
}

/** The owner confirms (optionally editing the text). Only now does the memory change, and it is marked ai_generated with provenance. */
export async function confirmAiDraft(
  ctx: AppContext,
  userId: string,
  memoryId: string,
  draftId: string,
  editedText: string | undefined,
  req?: FastifyRequest,
) {
  await loadOwned(ctx.db, userId, memoryId);
  await withTransaction(ctx.db, async (tx) => {
    const d = await tx.query<Row>(
      `SELECT * FROM memory_ai_drafts WHERE id = $1 AND memory_id = $2 AND user_id = $3 AND status = 'pending' FOR UPDATE`,
      [draftId, memoryId, userId],
    );
    const draft = d.rows[0];
    if (!draft) throw notFound('Draft');
    const provenance = {
      generated: true,
      provider: draft.provider,
      model: draft.model,
      draftId,
      kind: draft.kind,
      confirmedAt: new Date().toISOString(),
      editedByUser: false,
    };
    if (draft.kind === 'highlights') {
      const picks = (draft.payload.items as ItemRef[]) ?? [];
      // Highlights = these items come first. Nothing is added or removed.
      await applyOrder(tx, memoryId, picks, false);
      await tx.query(`UPDATE memories SET ai_generated = true, ai_provenance = $2 WHERE id = $1`, [
        memoryId,
        JSON.stringify(provenance),
      ]);
    } else {
      const text = (editedText ?? (draft.payload.text as string)).trim();
      if (editedText !== undefined) {
        assertTextOk(text);
        provenance.editedByUser = editedText.trim() !== draft.payload.text;
      }
      await tx.query(
        `UPDATE memories SET ${draft.kind === 'title' ? 'title' : 'summary'} = $2, ai_generated = true, ai_provenance = $3 WHERE id = $1`,
        [memoryId, text, JSON.stringify(provenance)],
      );
    }
    await tx.query(
      `UPDATE memory_ai_drafts SET status = 'confirmed', resolved_at = now() WHERE id = $1`,
      [draftId],
    );
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'memory.ai_draft_confirmed',
        targetType: 'memory',
        targetId: memoryId,
        metadata: { draftId, kind: draft.kind, provider: draft.provider },
      },
      req,
      tx,
    );
  });
}

export async function discardAiDraft(
  ctx: AppContext,
  userId: string,
  memoryId: string,
  draftId: string,
): Promise<void> {
  await loadOwned(ctx.db, userId, memoryId);
  const r = await ctx.db.query(
    `UPDATE memory_ai_drafts SET status = 'discarded', resolved_at = now() WHERE id = $1 AND memory_id = $2 AND user_id = $3 AND status = 'pending'`,
    [draftId, memoryId, userId],
  );
  if (!r.rowCount) throw notFound('Draft');
}

// ------------------------------------------------------------------------------------------------ slideshow export (needs ffmpeg)
const run = promisify(execFile);
let ffmpegProbe: { path: string; ok: boolean } | null = null;
export function ffmpegAvailable(ctx: AppContext): boolean {
  const p = ctx.config.MEDIA_FFMPEG_PATH;
  if (!ffmpegProbe || ffmpegProbe.path !== p)
    ffmpegProbe = { path: p, ok: spawnSync(p, ['-version']).status === 0 };
  return ffmpegProbe.ok;
}
export const SLIDESHOW_SECONDS_PER_IMAGE = 2;
export const SLIDESHOW_MAX_IMAGES = 30;

export async function exportSlideshow(
  ctx: AppContext,
  userId: string,
  memoryId: string,
  req?: FastifyRequest,
) {
  await loadOwned(ctx.db, userId, memoryId);
  if (!ffmpegAvailable(ctx))
    throw new AppError(
      'unavailable',
      'Video export needs ffmpeg on the server, which is not installed here',
      { reason: 'processing_unavailable' },
    );
  // Only images the user owns and can currently see in this memory (posts, moments, Reals and media items).
  const { items } = await loadVisibleItems(ctx, userId, memoryId);
  const ids = (t: ItemType) => items.filter((i) => i.type === t).map((i) => i.id);
  const { rows } = await ctx.db.query<{ storage_key: string }>(
    `SELECT DISTINCT ON (m.id) m.storage_key FROM media m
      WHERE m.owner_id = $1 AND m.deleted_at IS NULL AND m.kind = 'image' AND m.status IN ('uploaded','processing','ready') AND (
        m.id = ANY($2::uuid[])
        OR m.id IN (SELECT pm.media_id FROM post_media pm WHERE pm.post_id = ANY($3::uuid[]))
        OR m.id IN (SELECT mo.media_id FROM moments mo WHERE mo.id = ANY($4::uuid[]))
        OR m.id IN (SELECT r.front_media_id FROM real_captures r WHERE r.id = ANY($5::uuid[]) UNION SELECT r.rear_media_id FROM real_captures r WHERE r.id = ANY($5::uuid[])))
      ORDER BY m.id LIMIT ${SLIDESHOW_MAX_IMAGES}`,
    [userId, ids('media'), ids('post'), ids('moment'), ids('real_capture')],
  );
  if (!rows.length) throw invalid('This memory has no photos of yours to make a slideshow from');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yl-slideshow-'));
  try {
    const adapter = getMediaRuntime(ctx).adapter;
    const files: string[] = [];
    for (const [i, r] of rows.entries()) {
      const chunks: Buffer[] = [];
      for await (const c of await adapter.read(r.storage_key))
        chunks.push(Buffer.from(c as Buffer));
      const f = path.join(dir, `img${String(i).padStart(3, '0')}`);
      await writeFile(f, Buffer.concat(chunks));
      files.push(f);
    }
    const list =
      files.map((f) => `file '${f}'\nduration ${SLIDESHOW_SECONDS_PER_IMAGE}`).join('\n') +
      `\nfile '${files[files.length - 1]}'\n`;
    await writeFile(path.join(dir, 'list.txt'), list);
    const out = path.join(dir, 'out.mp4');
    await run(
      ctx.config.MEDIA_FFMPEG_PATH,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        path.join(dir, 'list.txt'),
        '-vf',
        'scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p',
        '-c:v',
        'libx264',
        '-movflags',
        '+faststart',
        '-y',
        out,
      ],
      { timeout: 120_000 },
    );
    const media = await ingestUpload(ctx, await readFile(out), {
      ownerId: userId,
      purpose: 'attachment',
      declaredKind: 'video',
    });
    const rec = await ctx.db.query<{ id: string }>(
      `INSERT INTO memory_exports (memory_id, user_id, kind, media_id, item_count) VALUES ($1,$2,'slideshow',$3,$4) RETURNING id`,
      [memoryId, userId, media.id, rows.length],
    );
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'memory.slideshow_exported',
        targetType: 'memory',
        targetId: memoryId,
        metadata: { images: rows.length },
      },
      req,
    );
    return {
      exportId: rec.rows[0]!.id,
      kind: 'slideshow',
      images: rows.length,
      media: mediaView(ctx, media, true),
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    ctx.log.warn({ err: e }, 'slideshow export failed');
    throw new AppError('unavailable', 'The video could not be produced', {
      reason: 'processing_unavailable',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------ account deletion
export async function purgeUserMemories(tx: Queryable, userId: string): Promise<void> {
  const own = `SELECT id FROM memories WHERE owner_id = $1`;
  await tx.query(`DELETE FROM memory_items WHERE memory_id IN (${own})`, [userId]);
  await tx.query(`DELETE FROM memory_links WHERE memory_id IN (${own})`, [userId]);
  await tx.query(`DELETE FROM memory_ai_drafts WHERE user_id = $1`, [userId]);
  await tx.query(`DELETE FROM memory_exports WHERE user_id = $1`, [userId]);
  await tx.query(`DELETE FROM memory_suggestion_dismissals WHERE user_id = $1`, [userId]);
  await tx.query(
    `UPDATE memories SET deleted_at = COALESCE(deleted_at, now()), title = '', summary = '' WHERE owner_id = $1`,
    [userId],
  );
  // Other people's memories that pointed at this person's content or at the person.
  await tx.query(
    `DELETE FROM memory_items WHERE (item_type = 'post' AND item_id IN (SELECT id FROM posts WHERE author_id = $1))
     OR (item_type = 'moment' AND item_id IN (SELECT id FROM moments WHERE author_id = $1))
     OR (item_type = 'real_capture' AND item_id IN (SELECT id FROM real_captures WHERE author_id = $1))
     OR (item_type = 'media' AND item_id IN (SELECT id FROM media WHERE owner_id = $1))`,
    [userId],
  );
  await tx.query(`DELETE FROM memory_links WHERE entity_type = 'person' AND entity_id = $1`, [
    userId,
  ]);
}
