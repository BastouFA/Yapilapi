import {
  TOOL_SPECS,
  type AgentConfig,
  type AgentScope,
  type ToolName,
  type ToolSpec,
} from '@yapilapi/ai';
import type { AppContext } from '../../lib/context.js';
import { loadVisiblePost, postVisibleSql } from '../../lib/visibility.js';
import { hasCommunityPermission } from '../../lib/community-access.js';
import { hasConsent } from '../privacy/index.js';
import { listCommunityKnowledge, type CommunityKnowledge } from '../communities/index.js';
import { getAuthorizedBusinessKnowledge, type AuthorizedKnowledge } from '../business/index.js';
import { eventVisibleSql } from '../events/index.js';
import { loadAccess, type ConvAccess } from '../messaging/access.js';
import { listMessages } from '../messaging/service.js';
import type { MessageView } from '../messaging/views.js';
import { PermissionDenied } from './errors.js';

export interface Principal {
  userId: string;
  ageBand: 'teen' | 'adult';
}

/** Conversations the user explicitly attached to THIS request. Never persisted, never inherited from an earlier turn. */
export type Attachments = ReadonlySet<string>;

export interface ThreadComment {
  id: string;
  authorId: string;
  authorUsername: string;
  body: string;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  starts_at: Date;
  ends_at: Date | null;
  location_text: string | null;
  status: string;
  visibility: string;
  going_count: number;
  community_id: string | null;
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * PERMISSION ENGINE. The core rule: the AI must know what the requesting user may see BEFORE it retrieves anything. Every read of
 * user data on behalf of an AI request goes through a method here, and each method evaluates the request AS THE USER with the same
 * code the HTTP API uses (postVisibleSql, eventVisibleSql, messaging loadAccess, community membership, approved business knowledge,
 * privacy consents). Deny by default: anything not explicitly allowed throws PermissionDenied, and the tool executor audits it.
 *
 * Deliberately NOT here: any way to read another user's data "for the model's benefit". The model is not a principal.
 */
export class PermissionEngine {
  constructor(private readonly ctx: AppContext) {}

  // ------------------------------------------------------------------ tool-level policy (before any handler runs)
  checkTool(p: Principal, spec: ToolSpec, agent: AgentConfig, scope: AgentScope): void {
    if (!agent.tools.includes(spec.name))
      throw new PermissionDenied('tool_not_allowed', `${agent.name} cannot use ${spec.name}`);
    if (!spec.scopes.includes(scope))
      throw new PermissionDenied(
        'scope_mismatch',
        `${spec.name} is not available in the ${scope} scope`,
      );
    for (const perm of spec.permissions) {
      if (!agent.grants.includes(perm))
        throw new PermissionDenied('permission_missing', `${agent.name} does not hold ${perm}`);
    }
    if (p.ageBand === 'teen' && !spec.teenAllowed)
      throw new PermissionDenied(
        'teen_restricted',
        'This AI feature is not available on accounts under 18',
      );
  }

  async consented(p: Principal, purpose: 'ai_processing' | 'ai_memory'): Promise<boolean> {
    return hasConsent(this.ctx, p.userId, purpose);
  }

  async requireConsent(p: Principal, purpose: 'ai_processing' | 'ai_memory'): Promise<void> {
    if (!(await this.consented(p, purpose))) {
      throw new PermissionDenied(
        'consent_required',
        `Turn on "${purpose === 'ai_memory' ? 'AI memory' : 'AI assistance'}" in Privacy settings to use this`,
        { purpose },
      );
    }
  }

  // ------------------------------------------------------------------ posts, threads, comments
  async post(
    p: Principal,
    postId: string,
  ): Promise<{
    id: string;
    author_id: string;
    body: string;
    language: string | null;
    community_id: string | null;
    visibility: string;
    created_at: Date;
  }> {
    if (!isUuid(postId)) throw new PermissionDenied('not_visible');
    const row = await loadVisiblePost<{
      id: string;
      author_id: string;
      body: string;
      language: string | null;
      community_id: string | null;
      visibility: string;
      created_at: Date;
    }>(this.ctx.db, p.userId, postId);
    if (!row) throw new PermissionDenied('not_visible', 'That post is not available to you');
    return row;
  }

  /** Comments under a post the user can see, filtered like GET /v1/posts/:id/comments (blocks, moderation, restricted accounts). */
  async threadComments(
    p: Principal,
    postId: string,
    limit = 60,
  ): Promise<{ post: Awaited<ReturnType<PermissionEngine['post']>>; comments: ThreadComment[] }> {
    const post = await this.post(p, postId);
    const { rows } = await this.ctx.db.query<{
      id: string;
      author_id: string;
      username: string;
      body: string;
      created_at: Date;
    }>(
      `SELECT c.id, c.author_id, pr.username::text AS username, c.body, c.created_at
         FROM comments c JOIN profiles pr ON pr.user_id = c.author_id JOIN posts po ON po.id = c.post_id
        WHERE c.post_id = $2 AND c.deleted_at IS NULL
          AND (c.moderation_status = 'approved' OR c.author_id = $1::uuid)
          AND (c.hidden_by_restriction = false OR c.author_id = $1::uuid OR po.author_id = $1::uuid)
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1::uuid AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = $1::uuid))
        ORDER BY c.created_at ASC, c.id ASC LIMIT $3`,
      [p.userId, postId, limit],
    );
    return {
      post,
      comments: rows.map((r) => ({
        id: r.id,
        authorId: r.author_id,
        authorUsername: r.username,
        body: r.body,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** One comment, only if the post is visible to the user and the comment passes the same filters as the comment list. */
  async comment(
    p: Principal,
    commentId: string,
  ): Promise<{ id: string; post_id: string; author_id: string; body: string }> {
    if (!isUuid(commentId)) throw new PermissionDenied('not_visible');
    const { rows } = await this.ctx.db.query<{
      id: string;
      post_id: string;
      author_id: string;
      body: string;
    }>(
      `SELECT c.id, c.post_id, c.author_id, c.body FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = $2 AND c.deleted_at IS NULL AND ${postVisibleSql('$1::uuid')}
          AND (c.moderation_status = 'approved' OR c.author_id = $1::uuid)
          AND (c.hidden_by_restriction = false OR c.author_id = $1::uuid OR p.author_id = $1::uuid)
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1::uuid AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = $1::uuid))`,
      [p.userId, commentId],
    );
    if (!rows[0]) throw new PermissionDenied('not_visible', 'That comment is not available to you');
    return rows[0];
  }

  // ------------------------------------------------------------------ private communications
  /**
   * The ONLY door to direct/group message content. Requires, in order: an adult account, an explicit attachment on THIS request,
   * the user's ai_processing consent, and normal conversation access (active member, not blocked, history from joined_at).
   * There is no code path that ingests messages "in the background".
   */
  async attachedConversation(
    p: Principal,
    conversationId: string,
    attached: Attachments,
  ): Promise<ConvAccess> {
    if (p.ageBand === 'teen')
      throw new PermissionDenied(
        'teen_restricted',
        'AI cannot read conversations on accounts under 18',
      );
    if (!isUuid(conversationId) || !attached.has(conversationId)) {
      throw new PermissionDenied(
        'not_attached',
        'Attach the conversation to this request first. I never read private messages unless you attach them.',
      );
    }
    await this.requireConsent(p, 'ai_processing');
    const access = await loadAccess(this.ctx.db, conversationId, p.userId);
    if (!access)
      throw new PermissionDenied('not_visible', 'That conversation is not available to you');
    return access;
  }

  async conversationMessages(
    p: Principal,
    conversationId: string,
    attached: Attachments,
    limit = 100,
  ): Promise<{ access: ConvAccess; messages: MessageView[] }> {
    const access = await this.attachedConversation(p, conversationId, attached);
    const page = await listMessages(this.ctx, p.userId, conversationId, { limit });
    // Oldest first; tombstones and non-text kinds carry no readable content.
    const messages = page.items
      .filter((m) => !m.deleted && m.kind === 'text' && m.body.trim())
      .reverse();
    return { access, messages };
  }

  async conversationMemberIds(conversationId: string): Promise<string[]> {
    const { rows } = await this.ctx.db.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
      [conversationId],
    );
    return rows.map((r) => r.user_id);
  }

  // ------------------------------------------------------------------ events
  async event(p: Principal, eventId: string): Promise<EventRecord> {
    if (!isUuid(eventId)) throw new PermissionDenied('not_visible');
    const { rows } = await this.ctx.db.query<EventRecord>(
      `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.location_text, e.status, e.visibility, e.going_count, e.community_id
         FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1::uuid')}`,
      [p.userId, eventId],
    );
    if (!rows[0]) throw new PermissionDenied('not_visible', 'That event is not available to you');
    return rows[0];
  }

  // ------------------------------------------------------------------ community / business knowledge
  async communityKnowledge(p: Principal, communityId: string): Promise<CommunityKnowledge> {
    if (!isUuid(communityId)) throw new PermissionDenied('not_member');
    const k = await listCommunityKnowledge(this.ctx, communityId, p.userId);
    if (!k)
      throw new PermissionDenied('not_member', 'Only active members can ask a community assistant');
    return k;
  }

  async businessKnowledge(_p: Principal, businessId: string): Promise<AuthorizedKnowledge> {
    if (!isUuid(businessId)) throw new PermissionDenied('assistant_disabled');
    const k = await getAuthorizedBusinessKnowledge(this.ctx, businessId);
    if (!k)
      throw new PermissionDenied(
        'assistant_disabled',
        'This business has not enabled its assistant',
      );
    return k;
  }

  /** May the user draft/post into this community? (Re-checked again by createPost at confirmation.) */
  async canPostInCommunity(p: Principal, communityId: string): Promise<boolean> {
    return hasCommunityPermission(this.ctx.db, communityId, p.userId, 'post');
  }

  // ------------------------------------------------------------------ memory
  /** Memory needs the MEMORY flag, the ai_memory consent (never for teens) and an agent that uses it. */
  async memoryAllowed(p: Principal, agent: AgentConfig): Promise<boolean> {
    if (!agent.safety.useMemory || p.ageBand === 'teen') return false;
    if (!(await this.ctx.flags.isEnabled('MEMORY', p.userId))) return false;
    return this.consented(p, 'ai_memory');
  }
}

export const toolSpec = (name: ToolName): ToolSpec => TOOL_SPECS[name];
