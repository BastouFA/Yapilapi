import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { tx } from '@yapilapi/database';
import {
  CHAPTER_AUDIENCES,
  CHAPTER_STORIES_MAX,
  CHAPTER_TITLE_MAX,
  RECAP_MAX_ITEMS,
  RECAP_TITLE_MAX,
  TOGETHER_ADD_BATCH,
  TOGETHER_CAPTION_MAX,
  TOGETHER_COMMENT_MAX,
  TOGETHER_DESCRIPTION_MAX,
  TOGETHER_ITEMS_MAX,
  TOGETHER_MEMBERS_MAX,
  TOGETHER_REACTIONS,
  TOGETHER_TITLE_MAX,
  togetherClosesAtOk,
  type TogetherDetail,
  type TogetherInvitePreview,
  type TogetherJoinRequest,
  type TogetherReaction,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { minorRuleSql } from '../lib/collabs.ts';
import { analyzeText } from '../lib/moderation.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { assertRecapUse } from '../lib/recap-sharing.ts';
import { recapCandidates, startRecap } from '../lib/recaps.ts';
import { isEnabled, notify, track } from '../lib/services.ts';
import {
  addChecks,
  albumItems,
  albumMembers,
  announceClosed,
  closeIfDue,
  itemComments,
  itemVisibleSql,
  manages,
  markBestOf,
  memberIds,
  noticeAdded,
  SUMMARY_SELECT,
  toSummary,
  type AddCheck,
} from '../lib/together.ts';
import { ageOf, plusCol, publicUserFrom } from '../lib/users.ts';
import { eventVisibleSql, notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import type { ChatHelpers } from './chat-polls-lists.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const itemParams = z.object({ id: uuid, itemId: uuid });
const memberParams = z.object({ id: uuid, userId: uuid });
const codeParam = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) });
const title = z.string().trim().min(1, 'Add a title.').max(TOGETHER_TITLE_MAX, `Up to ${TOGETHER_TITLE_MAX} characters.`);
const description = z.string().trim().max(TOGETHER_DESCRIPTION_MAX, `Up to ${TOGETHER_DESCRIPTION_MAX} characters.`);
const closesAt = z.string().datetime({ offset: true }).nullable();

const createSchema = z.object({
  title,
  description: description.default(''),
  /** When it closes for adding; null keeps it open until a host closes it. Left out: in 48 hours. */
  closesAt: closesAt.optional(),
  /** Older apps: hours from now. */
  closesInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .optional(),
  memberIds: z.array(uuid).max(TOGETHER_MEMBERS_MAX).default([]),
  cohostIds: z.array(uuid).max(10).default([]),
  /** Everyone in this chat is added (a card goes in the chat). */
  conversationId: uuid.optional(),
  /** Everyone going to this event is added. */
  eventId: uuid.optional(),
  /** Turn the invite link on (guests ask to join; a host approves). */
  inviteLink: z.boolean().default(false),
});

const addItemsSchema = z.object({
  items: z
    .array(
      z.object({
        mediaId: uuid,
        caption: z.string().trim().max(TOGETHER_CAPTION_MAX).default(''),
        /** When it was taken, from the file's date (never its location). Ignored when it isn't a believable time. */
        takenAt: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .min(1, 'Add a photo or video.')
    .max(TOGETHER_ADD_BATCH, `Add up to ${TOGETHER_ADD_BATCH} at a time.`),
});

/** Refuse words the text check blocks (titles, descriptions, captions and comments). */
function checkText(...texts: string[]) {
  if (texts.some((s) => s && analyzeText(s).risk !== 'normal')) throw new AppError(422, 'content_blocked', "This can't be shared. Try different words.");
}

function checkClosesAt(iso: string | null | undefined) {
  if (iso && !togetherClosesAtOk(new Date(iso)))
    throw badRequest('Choose a time at least 10 minutes from now and within 60 days.', { fields: { closesAt: 'Choose another time.' } });
}

/** A file's date is used when it's believable: not in the future, and not before cameras were in phones. */
function takenAtOf(iso: string | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000 || at.getFullYear() < 2000) return null;
  return at;
}

const newCode = () => randomBytes(9).toString('base64url');

const ADD_REFUSED: Record<Exclude<AddCheck, 'ok' | 'member'>, (name: string) => AppError> = {
  missing: () => notFound('That person'),
  blocked: (name) => new AppError(403, 'forbidden', `${name} can't be added to this album.`),
  minor: () => new AppError(403, 'minor_protection', 'To keep younger people safe, you can only add them once you are friends.'),
};

/**
 * Together: shared albums (lib/together.ts and packages/shared/src/together.ts). Behind the
 * REAL_TOGETHER flag. Registered from the messaging module, which lends it the chat helpers:
 * an album started from a chat posts a card there.
 */
export function registerTogether(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;
  const togetherOn = async () => {
    if (!(await isEnabled(db, 'REAL_TOGETHER'))) throw featureDisabled('Real Together');
  };
  // Signed in, and Together is on.
  const gate = [requireAuth, togetherOn];

  /** An album you're in (its summary row); "not found" for everyone else. */
  async function load(id: string, userId: string) {
    await closeIfDue(db, id);
    const { rows } = await db.query(`${SUMMARY_SELECT} AND t.id = $2`, [userId, id]);
    if (!rows[0]) throw notFound('Together');
    return rows[0] as Record<string, any>;
  }

  async function loadManaged(id: string, userId: string) {
    const r = await load(id, userId);
    if (!manages(r.my_role)) throw forbidden('Only the hosts can do that.');
    return r;
  }

  async function detail(id: string, userId: string): Promise<TogetherDetail> {
    const r = await load(id, userId);
    const summary = toSummary(r);
    const items = await albumItems(db, id, userId, r.title);
    const bestOf = markBestOf(items);
    const members = await albumMembers(db, id, userId);
    const canManage = manages(r.my_role);
    let event: TogetherDetail['event'] = null;
    if (r.event_id) {
      const ev = await db.query(`SELECT e.id, e.title, e.starts_at FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1')}`, [userId, r.event_id]);
      if (ev.rows[0]) event = { id: ev.rows[0].id, title: ev.rows[0].title, startsAt: new Date(ev.rows[0].starts_at).toISOString() };
    }
    return {
      ...summary,
      itemCount: items.length,
      members,
      items,
      bestOf,
      invite: canManage ? { code: r.invite_code ?? null, enabled: !!r.invite_enabled && !!r.invite_code } : null,
      canAdd: summary.status === 'open',
      canManage,
      event,
    };
  }

  /** The item, if it's one you can see in an album you're in. */
  async function loadItem(albumId: string, itemId: string, userId: string) {
    const album = await load(albumId, userId);
    const { rows } = await db.query(
      `SELECT c.id, c.user_id, c.media_id FROM together_contributions c JOIN media md ON md.id = c.media_id JOIN users au ON au.id = c.user_id
       WHERE c.id = $2 AND c.together_id = $3 AND ${itemVisibleSql('$1')}`,
      [userId, itemId, albumId],
    );
    if (!rows[0]) throw notFound('That photo or video');
    return { album, item: rows[0] as { id: string; user_id: string; media_id: string } };
  }

  async function oneItem(album: Record<string, any>, itemId: string, userId: string) {
    const all = await albumItems(db, album.id, userId, album.title);
    markBestOf(all);
    const item = all.find((i) => i.id === itemId);
    if (!item) throw notFound('That photo or video');
    return item;
  }

  /** Tell everyone else in an album that an item changed (stars, reactions, comments, caption). */
  async function itemChanged(albumId: string, itemId: string, by: string) {
    const people = (await memberIds(db, albumId)).filter((m) => m !== by);
    await ctx.realtime.publish(people, { type: 'together.item', data: { togetherId: albumId, itemId } });
  }

  /**
   * Of these people, the ones `adder` may add straight away: friends, people in the chat the
   * album came from, and people going to its event. Anyone else asks to join with the link.
   */
  async function reachable(adder: string, userIds: string[], conversationId: string | null, eventId: string | null): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const { rows } = await db.query<{ id: string }>(
      `SELECT x.id FROM unnest($2::uuid[]) AS x(id)
       WHERE EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = x.id) OR (fr.user_a = x.id AND fr.user_b = $1))
          OR ($3::uuid IS NOT NULL
              AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = $3 AND cm.user_id = x.id AND cm.left_at IS NULL)
              AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = $3 AND cm.user_id = $1 AND cm.left_at IS NULL))
          OR ($4::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = $4 AND ea.user_id = x.id AND ea.status = 'going'))`,
      [adder, userIds, conversationId, eventId],
    );
    return new Set(rows.map((r) => r.id));
  }

  async function namesOf(ids: string[]): Promise<Map<string, string>> {
    const { rows } = await db.query<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM profiles WHERE user_id = ANY($1::uuid[])`, [
      ids,
    ]);
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }

  /**
   * Work out who goes in: `picked` people must each be reachable and pass the checks (the first
   * one that doesn't is refused by name); `bulk` people (a chat's members, an event's guests)
   * who don't pass are skipped and counted.
   */
  async function whoGoesIn(
    adder: string,
    host: string,
    albumId: string | null,
    picked: string[],
    bulk: string[],
    source: { conversationId: string | null; eventId: string | null },
  ): Promise<{ ids: string[]; skipped: number }> {
    const wanted = [...new Set(picked.filter((x) => x !== adder))];
    const ok = await reachable(adder, wanted, source.conversationId, source.eventId);
    const checks = await addChecks(db, adder, host, albumId, wanted);
    const names = await namesOf(wanted);
    const ids: string[] = [];
    for (const id of wanted) {
      const check = checks.get(id) ?? 'missing';
      if (check === 'member') continue;
      if (check !== 'ok') throw ADD_REFUSED[check](names.get(id) ?? 'This person');
      if (!ok.has(id))
        throw forbidden(
          `You can add friends, people in the chat it came from or people going to its event. ${names.get(id) ?? 'Others'} can ask to join with the invite link.`,
        );
      ids.push(id);
    }
    let skipped = 0;
    const rest = [...new Set(bulk.filter((x) => x !== adder && !ids.includes(x)))];
    const bulkChecks = await addChecks(db, adder, host, albumId, rest);
    for (const id of rest) {
      const check = bulkChecks.get(id) ?? 'missing';
      if (check === 'ok') ids.push(id);
      else if (check !== 'member') skipped++;
    }
    return { ids, skipped };
  }

  async function assertRoom(albumId: string | null, adding: number) {
    const now = albumId ? Number((await db.query(`SELECT count(*)::int AS n FROM together_members WHERE together_id = $1`, [albumId])).rows[0].n) : 1;
    if (now + adding > TOGETHER_MEMBERS_MAX) throw badRequest(`An album can have up to ${TOGETHER_MEMBERS_MAX} people.`);
  }

  async function tellAdded(albumId: string, albumTitle: string, by: string, ids: string[]) {
    for (const m of ids)
      await notify(db, ctx.realtime, {
        userId: m,
        category: 'friends',
        type: 'together_invite',
        actorId: by,
        entityType: 'together',
        entityId: albumId,
        data: { title: albumTitle },
      });
  }

  /** The event an album can be made for: one you can see, that you host or are going to. */
  async function eventFor(userId: string, eventId: string): Promise<string[]> {
    const ev = await db.query(
      `SELECT e.host_id, EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = $1 AND ea.status = 'going') AS going
       FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1')}`,
      [userId, eventId],
    );
    if (!ev.rows[0]) throw notFound('Event');
    if (ev.rows[0].host_id !== userId && !ev.rows[0].going) throw forbidden('Make an album for an event you are hosting or going to.');
    const going = await db.query<{ user_id: string }>(
      `SELECT ea.user_id FROM event_attendees ea WHERE ea.event_id = $1 AND ea.status = 'going' ORDER BY ea.user_id LIMIT ${TOGETHER_MEMBERS_MAX * 2}`,
      [eventId],
    );
    return [ev.rows[0].host_id, ...going.rows.map((r) => r.user_id)];
  }

  // ── Albums ────────────────────────────────────────────────────────────

  /** The albums you're in: open ones first, then by the latest photo. */
  app.get('/v1/together', { preHandler: gate }, async (req) => {
    const u = me(req);
    await closeIfDue(db);
    const { rows } = await db.query(
      `${SUMMARY_SELECT} ORDER BY (t.status = 'open') DESC, greatest(t.created_at, coalesce(t.opened_at, t.created_at),
         coalesce((SELECT max(c.created_at) FROM together_contributions c WHERE c.together_id = t.id AND c.deleted_at IS NULL), t.created_at)) DESC
       LIMIT 200`,
      [u.id],
    );
    return { items: rows.map(toSummary) };
  });

  /**
   * Start an album: a title, a description, when it's open for adding, and who's in it (friends
   * you pick, everyone in a chat you're in, or everyone going to an event). Started from a chat,
   * it posts a card there.
   */
  app.post('/v1/together', { preHandler: gate, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createSchema, req.body);
    checkText(input.title, input.description);
    checkClosesAt(input.closesAt);
    const ends =
      input.closesAt === undefined ? new Date(Date.now() + (input.closesInHours ?? 48) * 3_600_000) : input.closesAt ? new Date(input.closesAt) : null;
    let bulk: string[] = [];
    if (input.conversationId) {
      await h.assertMember(input.conversationId, u.id);
      const kind = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [input.conversationId])).rows[0]?.kind;
      if (kind !== 'group' && kind !== 'direct') throw badRequest('Albums can be started from one-to-one chats and groups.');
      bulk = await h.memberIds(input.conversationId);
    }
    if (input.eventId) bulk = [...bulk, ...(await eventFor(u.id, input.eventId))];
    const { ids, skipped } = await whoGoesIn(u.id, u.id, null, input.memberIds, bulk, {
      conversationId: input.conversationId ?? null,
      eventId: input.eventId ?? null,
    });
    const people = ids.slice(0, TOGETHER_MEMBERS_MAX - 1);
    const cohosts = new Set(input.cohostIds.filter((c) => people.includes(c)));
    const created = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO togethers (creator_id, event_id, conversation_id, title, description, closes_at, invite_code, invite_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          u.id,
          input.eventId ?? null,
          input.conversationId ?? null,
          input.title,
          input.description,
          ends,
          input.inviteLink ? newCode() : null,
          input.inviteLink,
        ],
      );
      const id = rows[0]!.id;
      await c.query(`INSERT INTO together_members (together_id, user_id, role, added_by) VALUES ($1,$2,'creator',$2)`, [id, u.id]);
      if (people.length)
        await c.query(
          `INSERT INTO together_members (together_id, user_id, role, added_by)
           SELECT $1, x, CASE WHEN x = ANY($3::uuid[]) THEN 'cohost' ELSE 'member' END, $4 FROM unnest($2::uuid[]) AS x`,
          [id, people, [...cohosts], u.id],
        );
      let lineId: string | null = null;
      if (input.conversationId) {
        // A card in the chat: "{name} started a shared album", which opens it for the people in it.
        const line = await c.query<{ id: string }>(
          `INSERT INTO messages (conversation_id, sender_id, body, kind, meta) VALUES ($1,$2,'','system',$3) RETURNING id`,
          [input.conversationId, u.id, { type: 'together', togetherId: id, title: input.title }],
        );
        lineId = line.rows[0]!.id;
        await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [input.conversationId]);
      }
      return { id, lineId };
    });
    if (created.lineId && input.conversationId) {
      const chat = await h.notBlocking(u.id, await h.memberIds(input.conversationId));
      for (const m of chat) {
        const line = await h.loadMessage(created.lineId, m);
        if (line) await ctx.realtime.publish([m], { type: 'message.created', data: line });
      }
    }
    await tellAdded(created.id, input.title, u.id, people);
    track(db, u.id, 'together_created', { members: people.length, chat: !!input.conversationId, event: !!input.eventId, open: !ends });
    reply.code(201);
    return { together: await detail(created.id, u.id), added: people.length, skipped: skipped + (ids.length - people.length) };
  });

  app.get('/v1/together/:id', { preHandler: gate }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { together: await detail(id, me(req).id) };
  });

  /** Hosts: rename it, change the description or the cover, or change when it closes (while it's open). */
  app.patch('/v1/together/:id', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(
      z.object({ title: title.optional(), description: description.optional(), coverItemId: uuid.nullable().optional(), closesAt: closesAt.optional() }),
      req.body,
    );
    const r = await loadManaged(id, u.id);
    checkText(input.title ?? '', input.description ?? '');
    if (input.closesAt !== undefined) {
      if (r.status !== 'open') throw badRequest('Reopen the album to choose when it closes.');
      checkClosesAt(input.closesAt);
    }
    if (input.coverItemId) {
      const ok = await db.query(
        `SELECT 1 FROM together_contributions c JOIN media md ON md.id = c.media_id JOIN users au ON au.id = c.user_id
         WHERE c.id = $2 AND c.together_id = $3 AND ${itemVisibleSql('$1')} AND md.moderation <> 'sensitive'`,
        [u.id, input.coverItemId, id],
      );
      if (!ok.rowCount) throw badRequest('Choose a cover from the photos in this album.');
    }
    await db.query(
      `UPDATE togethers SET title = coalesce($2, title), description = coalesce($3, description),
              cover_item_id = CASE WHEN $4 THEN $5::uuid ELSE cover_item_id END,
              closes_at = CASE WHEN $6 THEN $7::timestamptz ELSE closes_at END,
              opened_at = CASE WHEN $6 THEN now() ELSE opened_at END,
              closing_notified_at = CASE WHEN $6 THEN NULL ELSE closing_notified_at END,
              updated_at = now()
       WHERE id = $1`,
      [
        id,
        input.title ?? null,
        input.description ?? null,
        input.coverItemId !== undefined,
        input.coverItemId ?? null,
        input.closesAt !== undefined,
        input.closesAt ?? null,
      ],
    );
    await ctx.realtime.publish(await memberIds(db, id), { type: 'together.updated', data: { togetherId: id } });
    return { together: await detail(id, u.id) };
  });

  /** Hosts: close it now. Everyone in it hears it closed. */
  app.post('/v1/together/:id/close', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await loadManaged(id, u.id);
    if (r.status === 'open') {
      await db.query(`UPDATE togethers SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now() WHERE id = $1`, [id, u.id]);
      await announceClosed(db, ctx.realtime, id);
    }
    return { together: await detail(id, u.id) };
  });

  /** Hosts: open it again for adding, until a time or until a host closes it. */
  app.post('/v1/together/:id/reopen', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ closesAt: closesAt.default(null) }), req.body ?? {});
    checkClosesAt(input.closesAt);
    const r = await loadManaged(id, u.id);
    if (r.status !== 'open') {
      await db.query(
        `UPDATE togethers SET status = 'open', closes_at = $2, opened_at = now(), closed_at = NULL, closed_by = NULL,
                closing_notified_at = NULL, closed_notified_at = NULL, updated_at = now() WHERE id = $1`,
        [id, input.closesAt],
      );
      await ctx.realtime.publish(await memberIds(db, id), { type: 'together.updated', data: { togetherId: id } });
    }
    return { together: await detail(id, u.id) };
  });

  /** The host: delete the album for everyone. The photos and videos stay with the people who added them. */
  app.delete('/v1/together/:id', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await load(id, u.id);
    if (r.my_role !== 'creator') throw forbidden('Only the person who started the album can delete it.');
    const people = await memberIds(db, id);
    await db.query(`UPDATE togethers SET deleted_at = now(), invite_enabled = false, updated_at = now() WHERE id = $1`, [id]);
    await ctx.realtime.publish(people, { type: 'together.updated', data: { togetherId: id, deleted: true } });
    track(db, u.id, 'together_deleted');
    return { ok: true };
  });

  // ── People ────────────────────────────────────────────────────────────

  /**
   * Hosts: add people. `userIds` must be friends, people in the chat the album came from, or
   * people going to its event (each refused by name if not). `fromChat` and `fromEvent` add
   * everyone there who can be added, and skip the rest.
   */
  app.post('/v1/together/:id/members', { preHandler: gate, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(
      z.object({ userIds: z.array(uuid).max(TOGETHER_MEMBERS_MAX).default([]), fromChat: z.boolean().default(false), fromEvent: z.boolean().default(false) }),
      req.body,
    );
    const r = await loadManaged(id, u.id);
    let bulk: string[] = [];
    if (input.fromChat) {
      if (!r.conversation_id) throw badRequest("This album didn't come from a chat.");
      await h.assertMember(r.conversation_id, u.id);
      bulk = await h.memberIds(r.conversation_id);
    }
    if (input.fromEvent) {
      if (!r.event_id) throw badRequest("This album isn't for an event.");
      bulk = [...bulk, ...(await eventFor(u.id, r.event_id).catch(() => []))];
    }
    const { ids, skipped } = await whoGoesIn(u.id, r.creator_id, id, input.userIds, bulk, { conversationId: r.conversation_id, eventId: r.event_id });
    await assertRoom(id, ids.length);
    if (ids.length) {
      await db.query(
        `INSERT INTO together_members (together_id, user_id, role, added_by) SELECT $1, x, 'member', $3 FROM unnest($2::uuid[]) AS x ON CONFLICT DO NOTHING`,
        [id, ids, u.id],
      );
      await db.query(
        `UPDATE together_requests SET status = 'approved', decided_by = $3, decided_at = now() WHERE together_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'pending'`,
        [id, ids, u.id],
      );
      await tellAdded(id, r.title, u.id, ids);
    }
    return { together: await detail(id, u.id), added: ids.length, skipped };
  });

  /** The host: make someone a co-host, or a member again. */
  app.put('/v1/together/:id/members/:userId/role', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(memberParams, req.params);
    const { role } = parse(z.object({ role: z.enum(['cohost', 'member']) }), req.body);
    const r = await load(id, u.id);
    if (r.my_role !== 'creator') throw forbidden('Only the person who started the album can choose co-hosts.');
    const up = await db.query(`UPDATE together_members SET role = $3 WHERE together_id = $1 AND user_id = $2 AND role <> 'creator'`, [id, userId, role]);
    if (!up.rowCount) throw notFound('That person');
    await ctx.realtime.publish(await memberIds(db, id), { type: 'together.updated', data: { togetherId: id } });
    return { together: await detail(id, u.id) };
  });

  /** Hosts: take someone out (co-hosts can't take out the host or another co-host). What they added stays. */
  app.delete('/v1/together/:id/members/:userId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(memberParams, req.params);
    const r = await loadManaged(id, u.id);
    if (userId === u.id) throw badRequest('Leave the album instead.');
    const allowed = r.my_role === 'creator' ? ['cohost', 'member'] : ['member'];
    const gone = await db.query(`DELETE FROM together_members WHERE together_id = $1 AND user_id = $2 AND role = ANY($3::text[])`, [id, userId, allowed]);
    if (!gone.rowCount) throw forbidden("You can't take this person out.");
    await ctx.realtime.publish([userId], { type: 'together.updated', data: { togetherId: id, removed: true } });
    return { together: await detail(id, u.id) };
  });

  /** Leave an album (the host can't: they delete it instead). What you added stays; remove it first if you like. */
  app.post('/v1/together/:id/leave', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await load(id, u.id);
    if (r.my_role === 'creator') throw badRequest('You started this album. Delete it instead, or close it.');
    await db.query(`DELETE FROM together_members WHERE together_id = $1 AND user_id = $2`, [id, u.id]);
    return { ok: true };
  });

  // ── Invite link and requests ──────────────────────────────────────────

  /** Hosts: turn the invite link on or off, or make a new one (the old one stops working). */
  app.post('/v1/together/:id/invite', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ enabled: z.boolean(), reset: z.boolean().default(false) }), req.body);
    const r = await loadManaged(id, u.id);
    const code = input.reset || !r.invite_code ? newCode() : r.invite_code;
    await db.query(`UPDATE togethers SET invite_code = $2, invite_enabled = $3, updated_at = now() WHERE id = $1`, [id, code, input.enabled]);
    return { invite: { code, enabled: input.enabled } };
  });

  /** The album behind an invite link is found only while its link is on, and never across a block with its host. */
  async function byCode(code: string, userId: string) {
    const { rows } = await db.query(
      `SELECT t.id, t.title, t.description, t.status, t.creator_id, ${plusCol('h_', 'hp')},
              hp.user_id AS h_id, hp.username AS h_username, hp.display_name AS h_display_name, hp.avatar_url AS h_avatar_url, hp.mode AS h_mode,
              (SELECT count(*) FROM together_members m WHERE m.together_id = t.id)::int AS member_count,
              (SELECT count(*) FROM together_contributions c WHERE c.together_id = t.id AND c.deleted_at IS NULL)::int AS item_count,
              EXISTS (SELECT 1 FROM together_members m WHERE m.together_id = t.id AND m.user_id = $2) AS member,
              (SELECT r.status FROM together_requests r WHERE r.together_id = t.id AND r.user_id = $2) AS request
       FROM togethers t JOIN profiles hp ON hp.user_id = t.creator_id JOIN users hu ON hu.id = t.creator_id
       WHERE t.invite_code = $1 AND t.invite_enabled AND t.deleted_at IS NULL AND hu.status = 'active' AND ${notBlockedSql('t.creator_id', '$2')}`,
      [code, userId],
    );
    if (!rows[0]) throw notFound('That invite');
    return rows[0] as Record<string, any>;
  }

  const previewOf = (r: Record<string, any>): TogetherInvitePreview => ({
    id: r.id,
    title: r.title,
    description: r.description,
    host: publicUserFrom(r, 'h_'),
    memberCount: r.member_count,
    itemCount: r.item_count,
    status: r.status === 'open' ? 'open' : 'closed',
    state: r.member ? 'member' : r.request === 'pending' ? 'requested' : r.request === 'declined' ? 'declined' : 'none',
  });

  /** What an invite link leads to: what the album is and who hosts it (no photos until you're in). */
  app.get('/v1/together/invite/:code', { preHandler: gate }, async (req) => {
    const { code } = parse(codeParam, req.params);
    return { invite: previewOf(await byCode(code, me(req).id)) };
  });

  /** Ask to join with an invite link. The hosts are told and one of them approves. */
  app.post('/v1/together/invite/:code/request', { preHandler: gate, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { code } = parse(codeParam, req.params);
    const r = await byCode(code, u.id);
    if (r.member || r.request === 'pending' || r.request === 'declined') return { invite: previewOf(r) };
    // The minor rule, as for adding: an adult host and someone under 18 only when they're friends.
    const ok = await db.query(`SELECT ${minorRuleSql('$1::uuid', '$2::uuid')} AS ok`, [r.creator_id, u.id]);
    if (!ok.rows[0]?.ok) throw new AppError(403, 'minor_protection', "You can't join this album.");
    await db.query(
      `INSERT INTO together_requests (together_id, user_id) VALUES ($1,$2)
       ON CONFLICT (together_id, user_id) DO UPDATE SET status = 'pending', created_at = now(), decided_by = NULL, decided_at = NULL
       WHERE together_requests.status = 'approved'`,
      [r.id, u.id],
    );
    const hosts = await db.query<{ user_id: string }>(`SELECT user_id FROM together_members WHERE together_id = $1 AND role IN ('creator', 'cohost')`, [r.id]);
    for (const host of hosts.rows)
      await notify(db, ctx.realtime, {
        userId: host.user_id,
        category: 'friends',
        type: 'together_request',
        actorId: u.id,
        entityType: 'together',
        entityId: r.id,
        data: { title: r.title },
      });
    await ctx.realtime.publish(
      hosts.rows.map((x) => x.user_id),
      { type: 'together.requests', data: { togetherId: r.id } },
    );
    return { invite: previewOf(await byCode(code, u.id)) };
  });

  /** Hosts: the people asking to join, oldest first. */
  app.get('/v1/together/:id/requests', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await loadManaged(id, u.id);
    const { rows } = await db.query(
      `SELECT r.created_at, pr.user_id AS u_id, pr.username AS u_username, pr.display_name AS u_display_name, pr.avatar_url AS u_avatar_url, pr.mode AS u_mode, ${plusCol('u_')},
              EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $2 AND fr.user_b = r.user_id) OR (fr.user_a = r.user_id AND fr.user_b = $2)) AS friend
       FROM together_requests r JOIN profiles pr ON pr.user_id = r.user_id JOIN users au ON au.id = r.user_id
       WHERE r.together_id = $1 AND r.status = 'pending' AND au.status = 'active' AND ${notBlockedSql('r.user_id', '$2')}
       ORDER BY r.created_at LIMIT 500`,
      [id, u.id],
    );
    const items: TogetherJoinRequest[] = rows.map((r) => ({
      user: publicUserFrom(r, 'u_'),
      createdAt: new Date(r.created_at).toISOString(),
      friend: r.friend,
    }));
    return { items };
  });

  /** Hosts: let someone in, or not. Letting in follows the same rules as adding (blocks, the minor rule). */
  app.post('/v1/together/:id/requests/:userId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(memberParams, req.params);
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const r = await loadManaged(id, u.id);
    const pending = await db.query(`SELECT 1 FROM together_requests WHERE together_id = $1 AND user_id = $2 AND status = 'pending'`, [id, userId]);
    if (!pending.rowCount) throw notFound('That request');
    if (approve) {
      const check = (await addChecks(db, u.id, r.creator_id, id, [userId])).get(userId) ?? 'missing';
      if (check !== 'ok' && check !== 'member') throw ADD_REFUSED[check]((await namesOf([userId])).get(userId) ?? 'This person');
      await assertRoom(id, 1);
      await db.query(`INSERT INTO together_members (together_id, user_id, role, added_by) VALUES ($1,$2,'member',$3) ON CONFLICT DO NOTHING`, [
        id,
        userId,
        u.id,
      ]);
    }
    await db.query(`UPDATE together_requests SET status = $3, decided_by = $4, decided_at = now() WHERE together_id = $1 AND user_id = $2`, [
      id,
      userId,
      approve ? 'approved' : 'declined',
      u.id,
    ]);
    if (approve)
      await notify(db, ctx.realtime, {
        userId,
        category: 'friends',
        type: 'together_approved',
        actorId: u.id,
        entityType: 'together',
        entityId: id,
        data: { title: r.title },
      });
    return { ok: true };
  });

  // ── Photos and videos ─────────────────────────────────────────────────

  /**
   * Add photos and videos (up to 20 at a time) while the album is open: your own uploads, each
   * with an optional caption and the time it was taken. People in it hear about it, at most
   * once every 30 minutes per person adding.
   */
  app.post('/v1/together/:id/items', { preHandler: gate, config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(addItemsSchema, req.body);
    checkText(...input.items.map((i) => i.caption));
    const ids = input.items.map((i) => i.mediaId);
    if (new Set(ids).size !== ids.length) throw badRequest('Each photo or video can be added once.');
    const r = await load(id, u.id);
    if (r.status !== 'open') throw badRequest('This album is closed, so nothing more can be added.');
    const added = await tx(db, async (c) => {
      // One add at a time per album, so two can't pass the limit together.
      await c.query(`SELECT 1 FROM togethers WHERE id = $1 FOR UPDATE`, [id]);
      const n = Number((await c.query(`SELECT count(*)::int AS n FROM together_contributions WHERE together_id = $1 AND deleted_at IS NULL`, [id])).rows[0].n);
      if (n + ids.length > TOGETHER_ITEMS_MAX) throw badRequest(`An album holds up to ${TOGETHER_ITEMS_MAX} photos and videos.`);
      // Your own uploads, not view-once ones, photos and videos only.
      const media = await c.query<{ id: string; kind: string; moderation: string }>(
        `SELECT id, kind, moderation FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND NOT private AND deleted_at IS NULL`,
        [ids, u.id],
      );
      if (media.rows.length !== ids.length) throw notFound('Media');
      if (media.rows.some((m) => m.kind !== 'image' && m.kind !== 'video')) throw badRequest('Add photos and videos.');
      if (media.rows.some((m) => m.moderation === 'blocked')) throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
      const dup = await c.query(`SELECT 1 FROM together_contributions WHERE together_id = $1 AND media_id = ANY($2::uuid[]) AND deleted_at IS NULL`, [id, ids]);
      if (dup.rowCount) throw new AppError(409, 'conflict', 'That photo or video is already in this album.');
      // A recap only when it could be sent in a chat (everyone in the album sees it).
      await assertRecapUse(c, u.id, ids, 'chat');
      await c.query(`UPDATE media SET used_at = coalesce(used_at, now()) WHERE id = ANY($1::uuid[])`, [ids]);
      const out: string[] = [];
      for (const item of input.items) {
        const taken = takenAtOf(item.takenAt);
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO together_contributions (together_id, user_id, media_id, caption, captured_at, taken_source) VALUES ($1,$2,$3,$4,coalesce($5, now()),$6) RETURNING id`,
          [id, u.id, item.mediaId, item.caption, taken, taken ? 'file' : 'added'],
        );
        out.push(rows[0]!.id);
      }
      await c.query(`UPDATE togethers SET updated_at = now() WHERE id = $1`, [id]);
      return out;
    });
    const videos = (await db.query(`SELECT count(*)::int AS n FROM media WHERE id = ANY($1::uuid[]) AND kind = 'video'`, [ids])).rows[0].n as number;
    const people = (await memberIds(db, id)).filter((m) => m !== u.id);
    await ctx.realtime.publish(people, { type: 'together.items', data: { togetherId: id, userId: u.id, count: added.length } });
    await noticeAdded(db, ctx.realtime, { id, title: r.title }, u.id, { count: added.length, videos });
    track(db, u.id, 'together_items_added', { count: added.length, videos });
    reply.code(201);
    const items = await albumItems(db, id, u.id, r.title, added);
    return { items };
  });

  app.get('/v1/together/:id/items/:itemId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { album } = await loadItem(id, itemId, u.id);
    return { item: await oneItem(album, itemId, u.id) };
  });

  /** Change the caption of something you added. */
  app.patch('/v1/together/:id/items/:itemId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { caption } = parse(z.object({ caption: z.string().trim().max(TOGETHER_CAPTION_MAX) }), req.body);
    checkText(caption);
    const { album, item } = await loadItem(id, itemId, u.id);
    if (item.user_id !== u.id) throw forbidden('You can change the caption of what you added.');
    await db.query(`UPDATE together_contributions SET caption = $2 WHERE id = $1`, [itemId, caption]);
    await itemChanged(id, itemId, u.id);
    return { item: await oneItem(album, itemId, u.id) };
  });

  /** Remove something: your own, or anyone's if you're a host. */
  app.delete('/v1/together/:id/items/:itemId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const r = await load(id, u.id);
    const gone = await db.query(
      `UPDATE together_contributions SET deleted_at = now() WHERE id = $1 AND together_id = $2 AND (user_id = $3 OR $4) AND deleted_at IS NULL`,
      [itemId, id, u.id, manages(r.my_role)],
    );
    if (!gone.rowCount) throw notFound('That photo or video');
    await db.query(`UPDATE togethers SET cover_item_id = NULL WHERE id = $1 AND cover_item_id = $2`, [id, itemId]);
    await ctx.realtime.publish(
      (await memberIds(db, id)).filter((m) => m !== u.id),
      { type: 'together.items', data: { togetherId: id, removed: itemId } },
    );
    return { ok: true };
  });

  /** Star something: anyone in the album, anything in it. The person who added it hears it, batched. */
  app.put('/v1/together/:id/items/:itemId/star', { preHandler: gate, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { album, item } = await loadItem(id, itemId, u.id);
    const r = await db.query(`INSERT INTO together_stars (item_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [itemId, u.id]);
    if (r.rowCount && item.user_id !== u.id)
      await notify(db, ctx.realtime, {
        userId: item.user_id,
        category: 'friends',
        type: 'together_starred',
        actorId: u.id,
        entityType: 'together',
        entityId: id,
        data: { title: album.title, itemId },
        group: `together_star:${id}`,
      });
    await itemChanged(id, itemId, u.id);
    return { item: await oneItem(album, itemId, u.id) };
  });

  app.delete('/v1/together/:id/items/:itemId/star', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { album } = await loadItem(id, itemId, u.id);
    await db.query(`DELETE FROM together_stars WHERE item_id = $1 AND user_id = $2`, [itemId, u.id]);
    await itemChanged(id, itemId, u.id);
    return { item: await oneItem(album, itemId, u.id) };
  });

  /** React with one of the reactions (one per person per item; a new one replaces yours). */
  app.put('/v1/together/:id/items/:itemId/reaction', { preHandler: gate, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { kind } = parse(z.object({ kind: z.enum(TOGETHER_REACTIONS as unknown as [TogetherReaction, ...TogetherReaction[]]) }), req.body);
    const { album } = await loadItem(id, itemId, u.id);
    await db.query(
      `INSERT INTO together_reactions (item_id, user_id, kind) VALUES ($1,$2,$3) ON CONFLICT (item_id, user_id) DO UPDATE SET kind = EXCLUDED.kind, created_at = now()`,
      [itemId, u.id, kind],
    );
    await itemChanged(id, itemId, u.id);
    return { item: await oneItem(album, itemId, u.id) };
  });

  app.delete('/v1/together/:id/items/:itemId/reaction', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { album } = await loadItem(id, itemId, u.id);
    await db.query(`DELETE FROM together_reactions WHERE item_id = $1 AND user_id = $2`, [itemId, u.id]);
    await itemChanged(id, itemId, u.id);
    return { item: await oneItem(album, itemId, u.id) };
  });

  app.get('/v1/together/:id/items/:itemId/comments', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { album } = await loadItem(id, itemId, u.id);
    return { items: await itemComments(db, itemId, u.id, manages(album.my_role)) };
  });

  /** A short comment on something in the album. */
  app.post('/v1/together/:id/items/:itemId/comments', { preHandler: gate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1, 'Write something first.').max(TOGETHER_COMMENT_MAX) }), req.body);
    checkText(body);
    const { album } = await loadItem(id, itemId, u.id);
    await db.query(`INSERT INTO together_comments (item_id, author_id, body) VALUES ($1,$2,$3)`, [itemId, u.id, body]);
    await itemChanged(id, itemId, u.id);
    reply.code(201);
    return { items: await itemComments(db, itemId, u.id, manages(album.my_role)) };
  });

  /** Remove a comment: your own, or any if you're a host. */
  app.delete('/v1/together/:id/items/:itemId/comments/:commentId', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id, itemId, commentId } = parse(z.object({ id: uuid, itemId: uuid, commentId: uuid }), req.params);
    const { album } = await loadItem(id, itemId, u.id);
    const gone = await db.query(
      `UPDATE together_comments SET deleted_at = now() WHERE id = $1 AND item_id = $2 AND (author_id = $3 OR $4) AND deleted_at IS NULL`,
      [commentId, itemId, u.id, manages(album.my_role)],
    );
    if (!gone.rowCount) throw notFound('That comment');
    await itemChanged(id, itemId, u.id);
    return { items: await itemComments(db, itemId, u.id, manages(album.my_role)) };
  });

  // ── Afterwards ────────────────────────────────────────────────────────

  /**
   * One tap: a recap video of the best of (or, when nothing is starred yet, a spread of the
   * album). It's yours alone, like every recap (modules/recaps.ts): with other people's photos
   * in it you can watch and save it, not post it.
   */
  app.post('/v1/together/:id/recap', { preHandler: gate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ title: z.string().trim().min(1).max(RECAP_TITLE_MAX).optional() }), req.body ?? {});
    const r = await load(id, u.id);
    const items = await albumItems(db, id, u.id, r.title);
    const best = new Set(markBestOf(items));
    const usable = new Set((await recapCandidates(db, u.id, { source: 'together', sourceId: id })).items.map((c) => c.mediaId));
    const ready = items.filter((i) => usable.has(i.media.id));
    let chosen = ready.filter((i) => best.has(i.id));
    if (chosen.length < 3) {
      const step = Math.max(1, Math.ceil(ready.length / RECAP_MAX_ITEMS));
      chosen = ready.filter((_, i) => i % step === 0);
    }
    if (!chosen.length) throw badRequest('There are no photos or videos ready for a recap yet.');
    const recapId = await startRecap(db, u.id, {
      source: 'together',
      sourceId: id,
      title: (input.title ?? r.title).slice(0, RECAP_TITLE_MAX),
      mediaIds: chosen.slice(0, RECAP_MAX_ITEMS).map((i) => i.media.id),
      style: 'calm',
      aspect: '9:16',
    });
    track(db, u.id, 'recap_created', { source: 'together', style: 'calm', aspect: '9:16', items: chosen.length, sound: false });
    reply.code(202);
    return { recap: { id: recapId } };
  });

  /**
   * A chapter from your own photos and videos in the album (the best of yours unless you pick):
   * each becomes a story in your archive, dated when it was taken, and the chapter holds them.
   * Other people's photos stay in the album.
   */
  app.post('/v1/together/:id/chapter', { preHandler: gate, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(
      z.object({
        title: z.string().trim().min(1).max(CHAPTER_TITLE_MAX).optional(),
        audience: z.enum(CHAPTER_AUDIENCES).default('friends'),
        itemIds: z.array(uuid).max(CHAPTER_STORIES_MAX).optional(),
      }),
      req.body ?? {},
    );
    if (input.audience === 'public') {
      const age = ageOf(u.birthDate);
      if (age !== null && age < 18) throw forbidden('Chapters of people under 18 can be for followers, friends, close friends or only you, not everyone.');
    }
    const r = await load(id, u.id);
    const items = await albumItems(db, id, u.id, r.title);
    const best = new Set(markBestOf(items));
    const mine = items.filter((i) => i.mine && !i.media.processing);
    let chosen = input.itemIds ? mine.filter((i) => input.itemIds!.includes(i.id)) : mine.filter((i) => best.has(i.id));
    if (input.itemIds && chosen.length !== new Set(input.itemIds).size) throw badRequest('Choose from the photos and videos you added.');
    if (!chosen.length) chosen = mine;
    chosen = chosen.slice(0, CHAPTER_STORIES_MAX);
    if (!chosen.length) throw badRequest('Add some photos or videos of your own first.');
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chapters WHERE owner_id = $1 AND deleted_at IS NULL`, [u.id]);
    if (n.rows[0]!.n >= 100) throw badRequest('You have 100 chapters, the most you can have. Delete one to start another.');
    const chapterTitle = (input.title ?? r.title).slice(0, CHAPTER_TITLE_MAX);
    checkText(chapterTitle);
    const chapterId = await tx(db, async (c) => {
      const moments: string[] = [];
      for (const i of chosen) {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO moments (author_id, body, media_url, media_kind, media_id, visibility, expires_at, created_at)
           SELECT $1, $2, coalesce(CASE WHEN md.kind = 'video' THEN md.variants->>'mp4' END, md.url), md.kind, md.id, 'private', now(), $4
           FROM media md WHERE md.id = $3 AND md.owner_id = $1 RETURNING id`,
          [u.id, i.caption, i.media.id, i.takenAt],
        );
        if (rows[0]) moments.push(rows[0].id);
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO chapters (owner_id, title, audience, cover_moment_id, cover_symbol) VALUES ($1,$2,$3,$4,'image') RETURNING id`,
        [u.id, chapterTitle, input.audience, moments[0] ?? null],
      );
      await c.query(`INSERT INTO chapter_items (chapter_id, moment_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [rows[0]!.id, moments]);
      return rows[0]!.id;
    });
    track(db, u.id, 'chapter_created', { capsule: false, stories: chosen.length, from: 'together' });
    reply.code(201);
    return { chapter: { id: chapterId, stories: chosen.length } };
  });
}
