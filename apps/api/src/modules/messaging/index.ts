import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { resolveUser } from '../../lib/users.js';
import type { ApiModule } from '../types.js';
import { requireAccess } from './access.js';
import {
  addMembers,
  createGroup,
  createOrGetDirect,
  getConversationView,
  leaveGroup,
  listInbox,
  removeMember,
  renameGroup,
  setMemberRole,
  unreadSummary,
  updateMyPrefs,
  transferOwnershipIfNeeded,
} from './conversations.js';
import {
  deleteMessage,
  editMessage,
  listMessages,
  loadMessageForViewer,
  markRead,
  REACTION_KINDS,
  sendMessageDetailed,
  setMessageReaction,
  votePoll,
} from './service.js';
import { addTask, createPlan, getPlanView, rsvp, setPlanStatus, updateTask } from './plans.js';
import {
  declineCall,
  endCall,
  getCall,
  joinCall,
  leaveCall,
  listCalls,
  purgeUserFromCalls,
  startCall,
} from './calls.js';
import { registerRealtime } from './realtime.js';
import { hydrateMessages } from './views.js';

export { sendMessage, sendMessageDetailed } from './service.js';
export type { SendMessageInput } from './service.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const isoOrNull = z.union([z.iso.datetime({ offset: true }), z.null()]);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const sendBody = z.object({
  kind: z.enum(['text', 'media', 'file', 'voice']).optional(),
  body: z.string().max(8000).optional(),
  replyToId: z.uuid().optional(),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
  clientMessageId: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
  poll: z
    .object({
      question: z.string().trim().min(1).max(300),
      options: z.array(z.string().trim().min(1).max(200)).min(2).max(10),
      multiple: z.boolean().default(false),
    })
    .optional(),
});

export const messagingModule: ApiModule = {
  name: 'messaging',
  async register(app, ctx: AppContext) {
    // Account deletion: DM content is removed (both sides lose the deleted person's words), group messages are
    // anonymised (sender_id NULL, text kept for the remaining members), participation and personal state are dropped.
    registerDeletionHook(async (_ctx, tx, userId) => {
      const dm = `(SELECT id FROM conversations WHERE kind = 'direct')`;
      await tx.query(
        `DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE sender_id = $1 AND conversation_id IN ${dm})`,
        [userId],
      );
      await tx.query(
        `UPDATE messages SET body = '', metadata = '{}'::jsonb, deleted_at = COALESCE(deleted_at, now()) WHERE sender_id = $1 AND conversation_id IN ${dm}`,
        [userId],
      );
      await tx.query(
        `UPDATE messages SET sender_id = NULL, client_message_id = NULL WHERE sender_id = $1`,
        [userId],
      );
      await tx.query(`DELETE FROM reactions WHERE user_id = $1 AND target_type = 'message'`, [
        userId,
      ]);
      await tx.query('DELETE FROM message_poll_votes WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM ws_tickets WHERE user_id = $1', [userId]);
      await purgeUserFromCalls(tx, userId);
      const groups = await tx.query<{ conversation_id: string }>(
        `UPDATE conversation_members cm SET left_at = COALESCE(left_at, now()), pinned = false
           FROM conversations c WHERE c.id = cm.conversation_id AND c.kind = 'group' AND cm.user_id = $1 AND cm.left_at IS NULL
         RETURNING cm.conversation_id`,
        [userId],
      );
      for (const g of groups.rows) await transferOwnershipIfNeeded(tx, g.conversation_id);
    });

    await registerRealtime(app, ctx);

    // ------------------------------------------------------------------ conversations
    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/direct',
      summary: 'Create or fetch the direct conversation with a user',
      tags: ['messaging'],
      auth: 'user',
      body: z
        .object({ userId: z.uuid().optional(), username: z.string().min(1).max(40).optional() })
        .refine(
          (b) => (b.userId === undefined) !== (b.username === undefined),
          'Provide exactly one of userId or username',
        ),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, body, reply }) => {
        const targetId = body.userId ?? (await resolveUser(ctx, auth.userId, body.username!)).id;
        const { conversationId, created } = await createOrGetDirect(ctx, auth.userId, targetId);
        void reply.code(created ? 201 : 200);
        return getConversationView(
          ctx,
          auth.userId,
          await requireAccess(ctx.db, conversationId, auth.userId),
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/group',
      summary: 'Create a group conversation',
      tags: ['messaging'],
      auth: 'user',
      body: z.object({
        title: z.string().trim().min(1).max(100),
        memberIds: z.array(z.uuid()).min(1).max(99),
      }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        const id = await createGroup(ctx, auth.userId, body, req);
        void reply.code(201);
        return getConversationView(ctx, auth.userId, await requireAccess(ctx.db, id, auth.userId));
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/conversations',
      summary: 'Inbox: your direct and group conversations, newest activity first',
      tags: ['messaging'],
      auth: 'user',
      query: pageQuery.extend({
        pinned: z.enum(['true', 'false']).optional(),
        kind: z.enum(['direct', 'group']).optional(),
      }),
      handler: async ({ auth, query }) =>
        listInbox(ctx, auth.userId, {
          cursor: query.cursor,
          limit: query.limit,
          kind: query.kind,
          pinned: query.pinned === undefined ? undefined : query.pinned === 'true',
        }),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/conversations/unread-count',
      summary: 'Unread totals across un-muted conversations',
      tags: ['messaging'],
      auth: 'user',
      handler: async ({ auth }) => unreadSummary(ctx, auth.userId),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/conversations/:id',
      summary: 'Get a conversation you belong to',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) =>
        getConversationView(ctx, auth.userId, await requireAccess(ctx.db, params.id, auth.userId)),
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/conversations/:id',
      summary: 'Rename a group (owner/admin)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ title: z.string().trim().min(1).max(100) }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        await renameGroup(ctx, auth.userId, params.id, body.title, req);
        return getConversationView(
          ctx,
          auth.userId,
          await requireAccess(ctx.db, params.id, auth.userId),
        );
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/conversations/:id/me',
      summary: 'Mute/unmute or pin/unpin a conversation for yourself',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z
        .object({ mutedUntil: isoOrNull.optional(), pinned: z.boolean().optional() })
        .refine((b) => b.mutedUntil !== undefined || b.pinned !== undefined, 'Nothing to update'),
      handler: async ({ auth, params, body }) =>
        updateMyPrefs(ctx, auth.userId, params.id, {
          mutedUntil:
            body.mutedUntil === undefined
              ? undefined
              : body.mutedUntil === null
                ? null
                : new Date(body.mutedUntil),
          pinned: body.pinned,
        }),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/:id/members',
      summary: 'Add members to a group (owner/admin)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ userIds: z.array(z.uuid()).min(1).max(50) }),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        const added = await addMembers(ctx, auth.userId, params.id, body.userIds, req);
        return {
          added,
          conversation: await getConversationView(
            ctx,
            auth.userId,
            await requireAccess(ctx.db, params.id, auth.userId),
          ),
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/conversations/:id/members/:userId',
      summary: 'Remove a member from a group (owner/admin)',
      tags: ['messaging'],
      auth: 'user',
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      handler: async ({ auth, req, params }) =>
        removeMember(ctx, auth.userId, params.id, params.userId, req),
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/conversations/:id/members/:userId/role',
      summary: 'Promote/demote a group member (owner)',
      tags: ['messaging'],
      auth: 'user',
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      body: z.object({ role: z.enum(['admin', 'member']) }),
      handler: async ({ auth, req, params, body }) => {
        await setMemberRole(ctx, auth.userId, params.id, params.userId, body.role, req);
        return getConversationView(
          ctx,
          auth.userId,
          await requireAccess(ctx.db, params.id, auth.userId),
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/:id/leave',
      summary: 'Leave a group',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => leaveGroup(ctx, auth.userId, params.id, req),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/:id/read',
      summary: 'Mark a conversation read (optionally up to a message)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ messageId: z.uuid().optional() }),
      rateLimit: { limit: 600, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) =>
        markRead(ctx, auth.userId, params.id, body.messageId),
    });

    // ------------------------------------------------------------------ messages
    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/:id/messages',
      summary: 'Send a message (idempotent with clientMessageId)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: sendBody,
      rateLimit: { limit: 120, windowSec: 60, by: 'user' },
      handler: async ({ auth, params, body, reply }) => {
        const { message, created } = await sendMessageDetailed(ctx, {
          conversationId: params.id,
          senderId: auth.userId,
          ...body,
        });
        void reply.code(created ? 201 : 200);
        return message;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/conversations/:id/messages',
      summary: 'List messages, newest first (keyset)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      query: pageQuery,
      handler: async ({ auth, params, query }) => listMessages(ctx, auth.userId, params.id, query),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/messages/:id',
      summary: 'Get one message you can see',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const { row } = await loadMessageForViewer(ctx, auth.userId, params.id);
        return (await hydrateMessages(ctx, [row], auth.userId))[0];
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/messages/:id',
      summary: 'Edit your message',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ body: z.string().max(8000) }),
      rateLimit: { limit: 60, windowSec: 60, by: 'user' },
      handler: async ({ auth, params, body }) =>
        editMessage(ctx, auth.userId, params.id, body.body),
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/messages/:id',
      summary: 'Delete your message for everyone',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => deleteMessage(ctx, auth.userId, params.id),
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/messages/:id/reaction',
      summary: 'React to a message',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(REACTION_KINDS).default('like') }),
      rateLimit: { limit: 300, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) =>
        setMessageReaction(ctx, auth.userId, params.id, body.kind),
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/messages/:id/reaction',
      summary: 'Remove your reaction',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => setMessageReaction(ctx, auth.userId, params.id, null),
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/messages/:id/poll/votes',
      summary: 'Set your votes on an in-message poll (empty list clears)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ optionIds: z.array(z.string().min(1).max(20)).max(10) }),
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) =>
        votePoll(ctx, auth.userId, params.id, body.optionIds),
    });

    // ------------------------------------------------------------------ plans
    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/:id/plans',
      summary: 'Propose a plan in a conversation',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({
        title: z.string().trim().min(1).max(120),
        destination: z.string().trim().min(1).max(200).optional(),
        startsOn: dateOnly.optional(),
        endsOn: dateOnly.optional(),
        budgetCents: z.number().int().min(0).max(1_000_000_000_00).optional(),
        currency: z.string().length(3).optional(),
        details: z
          .record(z.string().max(50), z.unknown())
          .refine((d) => JSON.stringify(d).length <= 8000, 'details too large')
          .optional(),
        tasks: z
          .array(
            z.object({ title: z.string().trim().min(1).max(200), assigneeId: z.uuid().optional() }),
          )
          .max(50)
          .optional(),
      }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body, reply }) => {
        const out = await createPlan(ctx, auth.userId, params.id, body, req);
        void reply.code(201);
        return out;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/plans/:id',
      summary: 'Get a plan (conversation members only)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => getPlanView(ctx, auth.userId, params.id),
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/plans/:id/rsvp',
      summary: 'RSVP to a plan',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ rsvp: z.enum(['going', 'maybe', 'declined']) }),
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body }) => rsvp(ctx, auth.userId, params.id, body.rsvp),
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/plans/:id',
      summary: 'Confirm, cancel or finish a plan (its proposer)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ status: z.enum(['confirmed', 'cancelled', 'done']) }),
      handler: async ({ auth, req, params, body }) => {
        const v = await setPlanStatus(ctx, auth.userId, params.id, body.status);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'plan.status_changed',
            targetType: 'plan',
            targetId: params.id,
            metadata: { status: body.status },
          },
          req,
        );
        return v;
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/plans/:id/tasks',
      summary: 'Add a task to a plan',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ title: z.string().trim().min(1).max(200), assigneeId: z.uuid().optional() }),
      rateLimit: { limit: 120, windowSec: 600, by: 'user' },
      handler: async ({ auth, params, body, reply }) => {
        const out = await addTask(ctx, auth.userId, params.id, body);
        void reply.code(201);
        return out;
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/plans/:id/tasks/:taskId',
      summary: 'Complete/reopen or rename a plan task',
      tags: ['messaging'],
      auth: 'user',
      params: z.object({ id: z.uuid(), taskId: z.uuid() }),
      body: z
        .object({
          done: z.boolean().optional(),
          title: z.string().trim().min(1).max(200).optional(),
        })
        .refine((b) => b.done !== undefined || b.title !== undefined, 'Nothing to update'),
      handler: async ({ auth, params, body }) =>
        updateTask(ctx, auth.userId, params.id, params.taskId, body),
    });

    // ------------------------------------------------------------------ calls (signaling records; media is peer-to-peer WebRTC)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/conversations/:id/calls',
      summary: 'Start an audio or video call in a conversation',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      body: z.object({ kind: z.enum(['audio', 'video']) }),
      rateLimit: { limit: 30, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, params, body, reply }) => {
        const view = await startCall(ctx, auth.userId, params.id, body.kind, req);
        void reply.code(201);
        return view;
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/conversations/:id/calls',
      summary: 'Recent calls in a conversation (?active=true for open ones)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      query: z.object({ active: z.enum(['true', 'false']).optional() }),
      handler: async ({ auth, params, query }) =>
        listCalls(ctx, auth.userId, params.id, query.active === 'true'),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/calls/:id',
      summary: 'Get a call',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => getCall(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/calls/:id/join',
      summary: 'Join a call',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, params }) => joinCall(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/calls/:id/leave',
      summary: 'Leave a call',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => leaveCall(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/calls/:id/decline',
      summary: 'Decline an incoming call',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => declineCall(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/calls/:id/end',
      summary: 'End a call for everyone (initiator or group admin)',
      tags: ['messaging'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => endCall(ctx, auth.userId, params.id),
    });
  },
};
