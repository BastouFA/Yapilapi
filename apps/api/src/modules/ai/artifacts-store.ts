import type { SourceRef } from '@yapilapi/ai';
import type { ToolContext } from './types.js';

export type ArtifactKind =
  | 'caption'
  | 'post_draft'
  | 'reply_draft'
  | 'summary'
  | 'translation'
  | 'plan'
  | 'event_draft'
  | 'listing_draft'
  | 'other';

/** Create a draft. Drafts belong to the requesting user only and are never visible to anyone else. */
export async function createArtifact(
  tc: ToolContext,
  a: { kind: ArtifactKind; tool: string; payload: Record<string, unknown>; sources: SourceRef[] },
): Promise<{ id: string; kind: string }> {
  const provider = [...tc.turn.providers].join(',') || null;
  const { rows } = await tc.ctx.db.query<{ id: string }>(
    `INSERT INTO ai_artifacts (user_id, kind, payload, conversation_id, tool, provider, sources) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      tc.principal.userId,
      a.kind,
      JSON.stringify(a.payload),
      tc.conversationId,
      a.tool,
      provider,
      JSON.stringify(a.sources),
    ],
  );
  const ref = { id: rows[0]!.id, kind: a.kind, status: 'draft' };
  tc.turn.artifacts.push(ref);
  return { id: ref.id, kind: ref.kind };
}
