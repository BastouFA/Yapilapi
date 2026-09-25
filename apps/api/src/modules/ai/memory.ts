import { createHash } from 'node:crypto';
import { classifyText } from '@yapilapi/moderation';
import { containsSecret, contentWords, scanForInjection, type SourceRef } from '@yapilapi/ai';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { FastifyRequest } from 'fastify';
import { audit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import type { PermissionEngine, Principal } from './permissions.js';
import { PermissionDenied, denialToError } from './errors.js';

export const MAX_MEMORIES = 100;
/** Natural-language mentions of credentials are refused too ("my password is ..."): a memory is a preference or fact, never a credential. */
const SENSITIVE_WORDS =
  /\b(password|passcode|passphrase|pin code|cvv|security code|seed phrase|recovery code|api key|private key)\b/i;

export interface MemoryView {
  id: string;
  content: string;
  sourceType: 'user_stated' | 'user_approved_suggestion';
  sourceRef: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

interface Row {
  id: string;
  content: string;
  source_type: 'user_stated' | 'user_approved_suggestion';
  source_ref: string | null;
  created_at: Date;
  last_used_at: Date | null;
  use_count: number;
}
const view = (r: Row): MemoryView => ({
  id: r.id,
  content: r.content,
  sourceType: r.source_type,
  sourceRef: r.source_ref,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  useCount: r.use_count,
});
const COLS = 'id, content, source_type, source_ref, created_at, last_used_at, use_count';

const hashOf = (s: string) =>
  createHash('sha256').update(s.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');

export async function listMemories(ctx: AppContext, userId: string): Promise<MemoryView[]> {
  const { rows } = await ctx.db.query<Row>(
    `SELECT ${COLS} FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 500`,
    [userId],
  );
  return rows.map(view);
}

/**
 * Create a memory. It is created ONLY here, and only from (a) a fact the user typed into the memory UI (`user_stated`) or (b) a suggestion the
 * assistant showed the user in one of THEIR chat replies that they approved (`user_approved_suggestion`, verified against the stored message).
 * Nothing is ever derived from retrieved posts, DMs, tool output or model text, so a malicious source cannot plant a memory (memory poisoning).
 */
export async function createMemory(
  ctx: AppContext,
  perms: PermissionEngine,
  p: Principal,
  input: {
    content: string;
    source: 'user_stated' | 'user_approved_suggestion';
    sourceRef?: string | undefined;
  },
  req?: FastifyRequest,
): Promise<MemoryView> {
  await ctx.flags.require('MEMORY', p.userId);
  if (p.ageBand === 'teen')
    throw denialToError(
      new PermissionDenied('teen_restricted', 'AI memory is not available on accounts under 18'),
    );
  try {
    await perms.requireConsent(p, 'ai_memory');
  } catch (e) {
    if (e instanceof PermissionDenied) throw denialToError(e);
    throw e;
  }

  const content = input.content.trim().replace(/\s+/g, ' ');
  if (content.length < 1 || content.length > 500)
    throw invalid('A memory must be 1 to 500 characters');
  if (containsSecret(content) || SENSITIVE_WORDS.test(content))
    throw new AppError('unprocessable', 'Memories cannot contain passwords, keys or card numbers', {
      reason: 'memory_rejected_sensitive',
    });
  if (scanForInjection(content).flagged)
    throw new AppError(
      'unprocessable',
      'That looks like an instruction to the assistant, not a fact about you, so it was not saved',
      { reason: 'memory_rejected_instruction' },
    );
  if (classifyText(content).status !== 'approved')
    throw new AppError('unprocessable', 'That cannot be saved as a memory', {
      reason: 'memory_rejected_content',
    });

  const sourceRef: string | null = input.sourceRef?.slice(0, 100) ?? null;
  if (input.source === 'user_approved_suggestion') {
    // Must point at an assistant message in the user's OWN conversation whose stored safety record contains exactly this suggestion.
    if (!sourceRef)
      throw invalid(
        'sourceRef (the message id that suggested it) is required for an approved suggestion',
      );
    const { rows } = await ctx.db
      .query<{ suggestions: unknown }>(
        `SELECT m.safety -> 'memorySuggestions' AS suggestions FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1::uuid AND c.user_id = $2 AND m.role = 'assistant'`,
        [sourceRef, p.userId],
      )
      .catch(() => ({ rows: [] as Array<{ suggestions: unknown }> }));
    const list = Array.isArray(rows[0]?.suggestions) ? (rows[0]!.suggestions as unknown[]) : [];
    if (!list.some((s) => typeof s === 'string' && hashOf(s) === hashOf(content)))
      throw invalid("That was not one of the assistant's suggestions");
  }

  const count = await ctx.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM ai_memories WHERE user_id = $1',
    [p.userId],
  );
  if (count.rows[0]!.n >= MAX_MEMORIES)
    throw conflict(`You can keep at most ${MAX_MEMORIES} memories. Delete some to add more.`);
  const { rows } = await ctx.db.query<Row>(
    `INSERT INTO ai_memories (user_id, content, source_type, source_ref, content_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING RETURNING ${COLS}`,
    [p.userId, content, input.source, sourceRef, hashOf(content)],
  );
  if (!rows[0]) throw conflict('I already remember that');
  await audit(
    ctx,
    {
      actorId: p.userId,
      action: 'ai.memory.created',
      targetType: 'ai_memory',
      targetId: rows[0].id,
      metadata: { source: input.source },
    },
    req,
  );
  return view(rows[0]);
}

export async function deleteMemory(
  ctx: AppContext,
  userId: string,
  id: string,
  req?: FastifyRequest,
): Promise<void> {
  const r = await ctx.db.query('DELETE FROM ai_memories WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (!r.rowCount) throw notFound('Memory');
  await audit(
    ctx,
    { actorId: userId, action: 'ai.memory.deleted', targetType: 'ai_memory', targetId: id },
    req,
  );
}

export async function deleteAllMemories(
  ctx: AppContext,
  userId: string,
  req?: FastifyRequest,
): Promise<number> {
  const r = await ctx.db.query('DELETE FROM ai_memories WHERE user_id = $1', [userId]);
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'ai.memory.deleted_all',
      targetType: 'ai_memory',
      metadata: { count: r.rowCount ?? 0 },
    },
    req,
  );
  return r.rowCount ?? 0;
}

const ASKS_ABOUT_MEMORY = /\b(remember|memories|what do you know about me|what have i told you)\b/i;

/**
 * Memories relevant to this message (lexical overlap; all of them when the user asks what is remembered). Marks them as used (transparency:
 * the user sees when each memory last influenced a reply) and returns provenance refs for the response `sources`.
 */
export async function memoriesForPrompt(
  ctx: AppContext,
  userId: string,
  message: string,
): Promise<{ items: MemoryView[]; sources: SourceRef[] }> {
  const { rows } = await ctx.db.query<Row>(
    `SELECT ${COLS} FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${MAX_MEMORIES}`,
    [userId],
  );
  if (!rows.length) return { items: [], sources: [] };
  const q = new Set(contentWords(message));
  const scored = rows.map((r) => ({
    r,
    s: contentWords(r.content).filter((w) => q.has(w)).length,
  }));
  const chosen = ASKS_ABOUT_MEMORY.test(message)
    ? scored.slice(0, 20)
    : scored
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5);
  if (!chosen.length) return { items: [], sources: [] };
  await ctx.db.query(
    'UPDATE ai_memories SET last_used_at = now(), use_count = use_count + 1 WHERE user_id = $1 AND id = ANY($2::uuid[])',
    [userId, chosen.map((c) => c.r.id)],
  );
  return {
    items: chosen.map((c) => view(c.r)),
    sources: chosen.map((c) => ({ type: 'memory' as const, id: c.r.id })),
  };
}
