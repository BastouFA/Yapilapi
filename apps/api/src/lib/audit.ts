import type { FastifyRequest } from 'fastify';
import { hashIp, redact } from '@yapilapi/security';
import type { Queryable } from '@yapilapi/database';
import type { AppContext } from './context.js';

export interface AuditEntry {
  actorId?: string | null;
  actorType?: 'user' | 'staff' | 'system' | 'ai' | 'service';
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Append to the immutable audit log. Metadata is redacted; never pass secrets or raw payment data. */
export async function audit(
  ctx: AppContext,
  entry: AuditEntry,
  req?: FastifyRequest,
  db: Queryable = ctx.db,
): Promise<void> {
  const salt = ctx.config.IP_HASH_SALT ?? 'dev-salt';
  await db.query(
    `INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, request_id, ip_hash, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.actorId ?? null,
      entry.actorType ?? 'user',
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      req?.id ?? null,
      req ? hashIp(req.clientIp, salt) : null,
      JSON.stringify(redact(entry.metadata ?? {})),
    ],
  );
}

export async function securityEvent(
  ctx: AppContext,
  userId: string | null,
  type: string,
  req?: FastifyRequest,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO security_events (user_id, type, ip, user_agent, metadata) VALUES ($1,$2,$3,$4,$5)`,
    [
      userId,
      type,
      req?.clientIp ?? null,
      req?.headers['user-agent']?.slice(0, 300) ?? null,
      JSON.stringify(redact(metadata)),
    ],
  );
}
