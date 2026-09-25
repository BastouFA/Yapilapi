import type { FastifyInstance } from 'fastify';
import { aiAssistSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { featureDisabled, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { isEnabled } from '../lib/services.ts';
import { AGENT_KINDS } from '../lib/ai/agents.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export default async function aiModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.post('/v1/ai/assist', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const input = parse(aiAssistSchema, req.body);
    if (input.task === 'translate' && !(await isEnabled(db, 'AI_TRANSLATION'))) throw featureDisabled('Translation');
    return ctx.ai.run({ userId: u.id, ...input });
  });

  /**
   * AI memory is explicit: the user adds, sees and deletes every item.
   * Nothing is ingested from private conversations automatically.
   */
  app.get('/v1/ai/memories', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT id, content, source, created_at FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC`, [me(req).id]);
    return { items: rows };
  });

  app.post('/v1/ai/memories', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { content } = parse(z.object({ content: z.string().trim().min(1).max(1000) }), req.body);
    const consent = await db.query(`SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'ai_processing'`, [u.id]);
    if (!consent.rows[0]?.granted)
      return reply
        .code(403)
        .send({ error: { code: 'consent_required', message: 'Turn on AI processing in the Privacy center to let the assistant remember things.' } });
    const { rows } = await db.query(`INSERT INTO ai_memories (user_id, content, source) VALUES ($1,$2,'user') RETURNING id, content, source, created_at`, [
      u.id,
      content,
    ]);
    reply.code(201);
    return { memory: rows[0] };
  });

  app.delete('/v1/ai/memories/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await db.query(`DELETE FROM ai_memories WHERE id = $1 AND user_id = $2`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Memory');
    return { ok: true };
  });

  app.delete('/v1/ai/memories', { preHandler: requireAuth }, async (req) => {
    const r = await db.query(`DELETE FROM ai_memories WHERE user_id = $1`, [me(req).id]);
    return { deleted: r.rowCount };
  });

  app.get('/v1/ai/status', async () => ({ provider: ctx.ai.providerName }));

  app.post('/v1/ai/agents/:kind', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(AGENT_KINDS) }), req.params);
    const input = parse(z.object({ prompt: z.string().trim().min(2).max(1000), businessId: z.string().uuid().optional() }), req.body);
    return ctx.ai.agent(me(req).id, kind, input.prompt, { businessId: input.businessId });
  });
}
