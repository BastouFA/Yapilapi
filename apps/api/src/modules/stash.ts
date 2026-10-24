import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LAUNCH_CITIES,
  hideStashSchema,
  openStashSchema,
  seedStashSchema,
  stashExplorersSchema,
  stashNearSchema,
  stashSettingsSchema,
  stashThanksSchema,
} from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { featureDisabled, notFound, parse } from '../lib/errors.ts';
import { audit, isEnabled, track } from '../lib/services.ts';
import {
  explorerOf,
  hideStash,
  myFinds,
  myStashes,
  nearStashes,
  openStash,
  setStashSettings,
  stashCard,
  stashCards,
  stashFinds,
  stashSettings,
  takeBack,
  thankStash,
  topExplorers,
} from '../lib/stash.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Stash (docs/product/stash.md, lib/stash.ts): hide something at a real place, find stashes near
 * you, open one when you're there, thank whoever hid it, and the explorer counts and lists. Behind
 * STASH. The exact point of a stash is only ever in answers to the person who hid it.
 */
export default async function stashModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const on = async () => {
    if (!(await isEnabled(db, 'STASH'))) throw featureDisabled('Stash');
  };

  /** Hide a stash where the device is now (accurate to STASH_MAX_ACCURACY metres or better). */
  app.post('/v1/stashes', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const input = parse(hideStashSchema, req.body);
    const id = await hideStash(ctx, u.id, input, { point: { lat: input.position.lat, lng: input.position.lng }, accuracy: input.position.accuracy });
    track(db, u.id, 'stash_hidden', { kind: input.kind, audience: input.audience, firstOnly: !!input.firstOnly, duration: input.duration });
    reply.code(201);
    return { stash: await stashCard(ctx, id, u.id) };
  });

  /** Stashes near a point (yours, or the map's middle) that you may find, nearest first, by their area. */
  app.get('/v1/stashes/near', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const viewer = me(req).id;
    const q = parse(stashNearSchema, req.query);
    const near = await nearStashes(db, viewer, q);
    const cards = await stashCards(
      ctx,
      near.map((n) => n.id),
      viewer,
    );
    const metres = new Map(near.map((n) => [n.id, n.metres]));
    return { items: cards.map((c) => ({ stash: c, metres: metres.get(c.id) ?? null })) };
  });

  /** Yours: the stashes you hid (with their points) and the ones you found. */
  app.get('/v1/stashes/mine', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const [hidden, found] = await Promise.all([myStashes(db, u.id), myFinds(db, u.id)]);
    return { hidden: await stashCards(ctx, hidden, u.id), found: await stashCards(ctx, found, u.id) };
  });

  /** This month's top explorers in a launch city. */
  app.get('/v1/stashes/explorers', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const q = parse(stashExplorersSchema, req.query);
    const city = LAUNCH_CITIES.find((c) => c.key === q.city)!;
    return { city: city.name, items: await topExplorers(db, me(req).id, city.name) };
  });

  /** Someone's "Stashes found · Hidden" and badges; null when they keep it to themselves. */
  app.get('/v1/users/:username/explorer', async (req) => {
    await on();
    const { username } = parse(z.object({ username: z.string().min(1).max(40) }), req.params);
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT pr.user_id FROM profiles pr JOIN users u ON u.id = pr.user_id WHERE lower(pr.username) = lower($1) AND u.status = 'active'`,
      [username],
    );
    if (!rows[0]) throw notFound('That person');
    return { explorer: await explorerOf(db, rows[0].user_id, req.user?.id ?? null) };
  });

  /** A stash's page: its area, title and hint, and what's inside once you opened it (or hid it). Yours: who found it. */
  app.get('/v1/stashes/:id', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const stash = await stashCard(ctx, id, u.id);
    return { stash, finds: stash.mine ? await stashFinds(db, u.id, id) : [] };
  });

  /** Try to open it from here: opened (with what's inside), or how far there is to go. */
  app.post('/v1/stashes/:id/open', { preHandler: requireAuth, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const pos = parse(openStashSchema, req.body);
    const result = await openStash(ctx, u.id, id, pos);
    if (result.opened && !result.stash.mine) track(db, u.id, 'stash_opened', { kind: result.stash.kind });
    return result;
  });

  /** Thank whoever hid it (finders only): a quick thank-you, a few words, or both. */
  app.post('/v1/stashes/:id/thanks', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await thankStash(ctx, u.id, id, parse(stashThanksSchema, req.body));
    return { thanked: true };
  });

  /** Take one of yours back: nobody can find it any more. */
  app.delete('/v1/stashes/:id', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    await takeBack(db, me(req).id, id);
    return { deleted: true };
  });

  app.get('/v1/me/stash-settings', { preHandler: requireAuth }, async (req) => ({ settings: await stashSettings(db, me(req).id) }));

  app.put('/v1/me/stash-settings', { preHandler: requireAuth }, async (req) => {
    const input = parse(stashSettingsSchema, req.body);
    return { settings: await setStashSettings(db, me(req).id, input) };
  });

  // ─── Seed mode (admins) ───────────────────────────────────────────────

  /** The team hides a launch stash at a chosen point, for everyone: "Hidden by YAPILAPI". */
  app.post('/v1/admin/stashes', { preHandler: requireRole('admin') }, async (req, reply) => {
    await on();
    const u = me(req);
    const input = parse(seedStashSchema, req.body);
    const id = await hideStash(
      ctx,
      u.id,
      { ...input, audience: 'everyone', position: { ...input.point, accuracy: 0 } },
      {
        seeded: true,
        point: input.point,
        accuracy: null,
      },
    );
    await audit(db, { actorId: u.id, action: 'stash.seed', entityType: 'stash', entityId: id, ip: req.ip, requestId: req.id });
    reply.code(201);
    return { stash: await stashCard(ctx, id, u.id) };
  });

  /** The team's launch stashes, newest first, with their points (moderators and admins). */
  app.get('/v1/admin/stashes', { preHandler: requireRole('moderator', 'admin') }, async () => {
    const { rows } = await db.query(
      `SELECT s.id, s.kind, s.title, s.hint, s.city, s.lat, s.lng, s.area_lat, s.area_lng, s.expires_at, s.created_at, s.deleted_at, s.moderation_status,
              (SELECT count(*)::int FROM stash_finds f WHERE f.stash_id = s.id) AS finds
       FROM stashes s WHERE s.seeded ORDER BY s.created_at DESC LIMIT 200`,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        hint: r.hint,
        city: r.city,
        point: { lat: r.lat, lng: r.lng },
        area: { lat: r.area_lat, lng: r.area_lng },
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        removed: !!r.deleted_at || r.moderation_status === 'removed',
        finds: r.finds,
      })),
    };
  });

  /** Remove any stash (moderators and admins): it can't be found any more. Reports go through the moderation queue. */
  app.delete('/v1/admin/stashes/:id', { preHandler: requireRole('moderator', 'admin') }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE stashes SET moderation_status = 'removed', deleted_at = coalesce(deleted_at, now()) WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound('That stash');
    await audit(db, { actorId: u.id, action: 'stash.remove', entityType: 'stash', entityId: id, ip: req.ip, requestId: req.id });
    return { removed: true };
  });
}
