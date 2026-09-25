import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Device registration for push notifications (browsers and the mobile app). */
export default async function pushModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.get('/v1/push/config', async () => ({ webPush: !!ctx.config.VAPID_PUBLIC_KEY, vapidPublicKey: ctx.config.VAPID_PUBLIC_KEY || null }));

  app.post('/v1/push/subscriptions', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const input = parse(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('webpush'),
          endpoint: z.string().url().startsWith('https://').max(1000),
          keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
        }),
        z.object({ kind: z.literal('expo'), endpoint: z.string().regex(/^Expo(nent)?PushToken\[[\w-]+\]$/) }),
      ]),
      req.body,
    );
    await db.query(
      `INSERT INTO push_subscriptions (user_id, kind, endpoint, keys) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kind, endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys`,
      [me(req).id, input.kind, input.endpoint, input.kind === 'webpush' ? input.keys : {}],
    );
    reply.code(201);
    return { ok: true };
  });

  app.delete('/v1/push/subscriptions', { preHandler: requireAuth }, async (req) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    await db.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [me(req).id, endpoint]);
    return { ok: true };
  });
}
