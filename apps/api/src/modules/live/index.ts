import { z } from 'zod';
import { route } from '../../lib/route.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { registerExportSection } from '../privacy/index.js';
import { TICKET_TTL_SEC } from '../messaging/realtime.js';
import { loadAccess } from './access.js';
import {
  commerceView,
  addProduct,
  listProducts,
  pinProduct,
  productParams,
  removeProduct,
} from './commerce.js';
import {
  addMarker,
  attachRecording,
  clipBody,
  clipToStudio,
  createClip,
  listClips,
  listMarkers,
  markerBody,
  recordingBody,
  translate,
  translateBody,
} from './extras.js';
import {
  answerBody,
  answerQuestion,
  askQuestion,
  closePoll,
  createPoll,
  dismissQuestion,
  hideMessage,
  listMessages,
  listPolls,
  listQuestions,
  messageBody,
  messagesQuery,
  pollBody,
  postMessage,
  questionBody,
  questionsQuery,
  reactionBody,
  reactionTotals,
  react,
  recentMessages,
  upvoteQuestion,
  votePoll,
  voteBody,
} from './interact.js';
import {
  banBody,
  banParticipant,
  listModerated,
  muteBody,
  muteParticipant,
  unbanParticipant,
  unmuteParticipant,
} from './moderation.js';
import {
  cancelSession,
  createBody,
  createSession,
  endBody,
  endLive,
  endSession,
  getSessionView,
  joinSession,
  leaveSession,
  listQuery,
  listSessions,
  listTeam,
  mySessions,
  patchBody,
  patchSession,
  removeTeamMember,
  runLiveMaintenance,
  sessionView,
  setTeamMember,
  settingsBody,
  startSession,
  staffView,
  teamBody,
  updateSettings,
} from './sessions.js';
import { registerLiveSocket } from './ws.js';

export { assertLiveGiftable } from './access.js';
export { runLiveMaintenance, endLive } from './sessions.js';
export {
  overrideLiveRuntime,
  getLiveRuntime,
  type IngestProvider,
  type TranslationProvider,
} from './runtime.js';
export { liveSocketSettings } from './ws.js';

const STAFF = ['moderator', 'admin', 'superadmin'] as const;
const idParams = z.object({ id: z.uuid() });
const userParams = z.object({ id: z.uuid(), userId: z.uuid() });
const R = { limit: 240, windowSec: 600, by: 'user' } as const;
const W = { limit: 120, windowSec: 600, by: 'user' } as const;
const CHAT = { limit: 40, windowSec: 60, by: 'user' } as const;

export const liveModule: ApiModule = {
  name: 'live',
  async register(app, ctx: AppContext) {
    registerExportSection({
      key: 'live',
      description:
        'Live sessions you hosted, and your chat messages, questions, poll votes and reactions in live sessions',
      collect: async (_c, db, u) => ({
        hosted: (
          await db.query(
            'SELECT id, title, description, status, visibility, media_mode, scheduled_for, started_at, ended_at, peak_viewers FROM live_sessions WHERE host_id = $1',
            [u],
          )
        ).rows,
        messages: (
          await db.query(
            'SELECT live_id, body, created_at FROM live_messages WHERE user_id = $1 AND hidden_at IS NULL ORDER BY created_at',
            [u],
          )
        ).rows,
        questions: (
          await db.query(
            'SELECT live_id, body, status, upvotes, created_at FROM live_questions WHERE asker_id = $1',
            [u],
          )
        ).rows,
        pollVotes: (
          await db.query(
            'SELECT poll_id, option_id, created_at FROM live_poll_votes WHERE user_id = $1',
            [u],
          )
        ).rows,
        reactions: (
          await db.query('SELECT live_id, kind, n FROM live_reactions WHERE user_id = $1', [u])
        ).rows,
      }),
    });
    registerDeletionHook(async (_c, tx, userId) => {
      // A deleted host's sessions stop; the person's chat lines go with them (live_messages.user_id is nulled by the FK, the text is removed here).
      await tx.query(
        `UPDATE live_polls SET status = 'closed', closed_at = now() WHERE status = 'open' AND live_id IN (SELECT id FROM live_sessions WHERE host_id = $1 AND status = 'live')`,
        [userId],
      );
      await tx.query(
        `UPDATE live_sessions SET status = 'ended', ended_at = now(), end_reason = 'host_deleted', viewer_count = 0 WHERE host_id = $1 AND status = 'live'`,
        [userId],
      );
      await tx.query(
        `UPDATE live_sessions SET status = 'cancelled', ended_at = now(), end_reason = 'host_deleted' WHERE host_id = $1 AND status = 'scheduled'`,
        [userId],
      );
      await tx.query(
        `UPDATE live_participants SET left_at = now() WHERE user_id = $1 AND left_at IS NULL`,
        [userId],
      );
      await tx.query('DELETE FROM live_messages WHERE user_id = $1', [userId]);
      await tx.query('DELETE FROM live_questions WHERE asker_id = $1', [userId]);
    });

    await registerLiveSocket(app, ctx);

    // ------------------------------------------------------------------ sessions
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live',
      summary: 'Live sessions I may see (on air by default; scheduled or ended on request)',
      tags: ['live'],
      auth: 'user',
      query: listQuery,
      rateLimit: R,
      handler: async ({ auth, query }) => {
        await ctx.flags.require('LIVE', auth.userId);
        return listSessions(ctx, auth.userId, query);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/mine',
      summary: 'Sessions I host or help run',
      tags: ['live'],
      auth: 'user',
      rateLimit: R,
      handler: async ({ auth }) => {
        await ctx.flags.require('LIVE', auth.userId);
        return mySessions(ctx, auth.userId);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live',
      summary:
        'Create a live session (scheduled; start it when ready). Teens: followers/private only.',
      tags: ['live'],
      auth: 'user',
      body: createBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, body }) => {
        const s = await createSession(ctx, auth, body, req);
        void reply.code(201);
        return sessionView(s, { role: 'host' });
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id',
      summary: 'One session I may see (404 when hidden)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        await ctx.flags.require('LIVE', auth.userId);
        return (await getSessionView(ctx, auth.userId, params.id)).view;
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/live/:id',
      summary: 'Host: edit title, description, schedule or language',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: patchBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        sessionView(await patchSession(ctx, auth, params.id, body, req), { role: 'host' }),
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/live/:id/settings',
      summary: 'Host/co-host: chat on/off, slow mode, blocked terms',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: settingsBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        sessionView(await updateSettings(ctx, auth, params.id, body, req), { team: true }),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/start',
      summary:
        'Host: go live. Interactive sessions start at once; video sessions need an ingest provider (501 ingest_unavailable otherwise)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, reply, params }) => {
        const r = await startSession(ctx, auth, params.id, req);
        void reply.header('cache-control', 'no-store');
        return { session: sessionView(r.session, { role: 'host' }), ingest: r.ingest };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/end',
      summary: 'Host or co-host: end the session',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: endBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        sessionView(await endSession(ctx, auth, params.id, body.reason ?? null, req), {
          team: true,
        }),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/cancel',
      summary: 'Host: cancel a scheduled session',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) =>
        sessionView(await cancelSession(ctx, auth, params.id, req), { team: true }),
    });

    // ------------------------------------------------------------------ team
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/team',
      summary: 'Host and appointed co-hosts/moderators',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        await ctx.flags.require('LIVE', auth.userId);
        await loadAccess(ctx.db, auth.userId, params.id);
        return { items: await listTeam(ctx.db, params.id) };
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/live/:id/team/:userId',
      summary: 'Host: appoint a co-host or moderator',
      tags: ['live'],
      auth: 'user',
      params: userParams,
      body: teamBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await setTeamMember(ctx, auth, params.id, params.userId, body.role, req);
        return { items: await listTeam(ctx.db, params.id) };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/team/:userId',
      summary: 'Host: remove a co-host or moderator',
      tags: ['live'],
      auth: 'user',
      params: userParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await removeTeamMember(ctx, auth, params.id, params.userId, req);
      },
    });

    // ------------------------------------------------------------------ audience
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/join',
      summary:
        'Join the room: presence, recent chat, open poll, pinned product and how to open the WebSocket',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        const a = await joinSession(ctx, auth, params.id);
        const [messages, polls, products] = await Promise.all([
          recentMessages(ctx, auth.userId, params.id),
          listPolls(ctx, auth.userId, params.id),
          listProducts(ctx, auth.userId, params.id),
        ]);
        return {
          session: sessionView(a.session, { role: a.role, entitled: a.entitled }),
          messages,
          openPolls: polls.items.filter((p) => p.status === 'open'),
          pinnedProduct: products.pinned,
          realtime: {
            ticketEndpoint: '/v1/ws/ticket',
            url: `/v1/live/${params.id}/ws`,
            ticketTtlSec: TICKET_TTL_SEC,
          },
        };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/leave',
      summary: 'Leave the room',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await leaveSession(ctx, auth, params.id);
      },
    });

    // ------------------------------------------------------------------ chat, reactions
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/messages',
      summary: 'Chat history (newest first; blocked people and removed messages excluded)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      query: messagesQuery,
      rateLimit: R,
      handler: async ({ auth, params, query }) => listMessages(ctx, auth.userId, params.id, query),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/messages',
      summary: 'Say something in the room (slow mode, mutes, blocked terms and moderation apply)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: messageBody,
      rateLimit: CHAT,
      handler: async ({ auth, req, reply, params, body }) => {
        const m = await postMessage(ctx, auth, params.id, body.body, req);
        void reply.code(201);
        return m;
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/messages/:mid',
      summary:
        'Remove a message (your own, or as host/co-host/moderator for someone below your rank)',
      tags: ['live'],
      auth: 'user',
      params: z.object({ id: z.uuid(), mid: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await hideMessage(ctx, auth, params.id, params.mid, req);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/reactions',
      summary: 'React (aggregated; no per-person feed)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: reactionBody,
      rateLimit: { limit: 120, windowSec: 60, by: 'user' },
      handler: async ({ auth, params, body }) => react(ctx, auth, params.id, body),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/reactions',
      summary: 'Reaction totals',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => ({
        totals: await reactionTotals(ctx, auth.userId, params.id),
      }),
    });

    // ------------------------------------------------------------------ polls
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/polls',
      summary: 'Polls with results and my votes',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => listPolls(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/polls',
      summary: 'Host/co-host: open a poll (one at a time)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: pollBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        const p = await createPoll(ctx, auth, params.id, body, req);
        void reply.code(201);
        return p;
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/polls/:pid/vote',
      summary: 'Vote once in an open poll',
      tags: ['live'],
      auth: 'user',
      params: z.object({ id: z.uuid(), pid: z.uuid() }),
      body: voteBody,
      rateLimit: W,
      handler: async ({ auth, params, body }) =>
        votePoll(ctx, auth, params.id, params.pid, body.optionIds),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/polls/:pid/close',
      summary: 'Host/co-host: close a poll',
      tags: ['live'],
      auth: 'user',
      params: z.object({ id: z.uuid(), pid: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, params }) => closePoll(ctx, auth, params.id, params.pid, req),
    });

    // ------------------------------------------------------------------ Q&A
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/questions',
      summary: 'Questions ordered by upvotes',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      query: questionsQuery,
      rateLimit: R,
      handler: async ({ auth, params, query }) => listQuestions(ctx, auth.userId, params.id, query),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/questions',
      summary: 'Ask a question (3 open at a time)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: questionBody,
      rateLimit: CHAT,
      handler: async ({ auth, reply, params, body }) => {
        const q = await askQuestion(ctx, auth, params.id, body.body);
        void reply.code(201);
        return q;
      },
    });
    const qParams = z.object({ id: z.uuid(), qid: z.uuid() });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/live/:id/questions/:qid/upvote',
      summary: 'Upvote a question (idempotent)',
      tags: ['live'],
      auth: 'user',
      params: qParams,
      rateLimit: W,
      handler: async ({ auth, params }) => upvoteQuestion(ctx, auth, params.id, params.qid, true),
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/questions/:qid/upvote',
      summary: 'Remove my upvote',
      tags: ['live'],
      auth: 'user',
      params: qParams,
      rateLimit: W,
      handler: async ({ auth, params }) => upvoteQuestion(ctx, auth, params.id, params.qid, false),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/questions/:qid/answer',
      summary: 'Host/co-host/moderator: answer a question',
      tags: ['live'],
      auth: 'user',
      params: qParams,
      body: answerBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        answerQuestion(ctx, auth, params.id, params.qid, body.answer, req),
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/questions/:qid',
      summary: 'Remove a question (yours, or as team for someone below your rank)',
      tags: ['live'],
      auth: 'user',
      params: qParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await dismissQuestion(ctx, auth, params.id, params.qid, req);
      },
    });

    // ------------------------------------------------------------------ moderation
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/moderation',
      summary: 'Team: muted and banned people',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => listModerated(ctx, auth, params.id),
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/live/:id/participants/:userId/mute',
      summary: 'Team: mute someone (1 min to 24 h)',
      tags: ['live'],
      auth: 'user',
      params: userParams,
      body: muteBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        muteParticipant(ctx, auth, params.id, params.userId, body.minutes, req),
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/participants/:userId/mute',
      summary: 'Team: unmute',
      tags: ['live'],
      auth: 'user',
      params: userParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await unmuteParticipant(ctx, auth, params.id, params.userId, req);
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/live/:id/participants/:userId/ban',
      summary: 'Team: remove someone from this session (with a reason)',
      tags: ['live'],
      auth: 'user',
      params: userParams,
      body: banBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await banParticipant(ctx, auth, params.id, params.userId, body.reason, req);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/participants/:userId/ban',
      summary: 'Team: lift a ban',
      tags: ['live'],
      auth: 'user',
      params: userParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await unbanParticipant(ctx, auth, params.id, params.userId, req);
      },
    });

    // ------------------------------------------------------------------ commerce
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/commerce',
      summary:
        'Gifts, subscriptions, ticket and pinned product for this session (pointers to the payment flows)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => commerceView(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/products',
      summary: 'Products shown in this session (the pinned one first)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => listProducts(ctx, auth.userId, params.id),
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/live/:id/products/:productId',
      summary: "Host/co-host: add one of the host's products to the session",
      tags: ['live'],
      auth: 'user',
      params: productParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await addProduct(ctx, auth, params.id, params.productId, req);
        return listProducts(ctx, auth.userId, params.id);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/products/:productId',
      summary: 'Host/co-host: remove a product',
      tags: ['live'],
      auth: 'user',
      params: productParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await removeProduct(ctx, auth, params.id, params.productId, req);
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/live/:id/products/:productId/pin',
      summary: 'Host/co-host: pin a product (replaces the current pin)',
      tags: ['live'],
      auth: 'user',
      params: productParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await pinProduct(ctx, auth, params.id, params.productId, true, req);
        return listProducts(ctx, auth.userId, params.id);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/live/:id/products/:productId/pin',
      summary: 'Host/co-host: unpin',
      tags: ['live'],
      auth: 'user',
      params: productParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await pinProduct(ctx, auth, params.id, params.productId, false, req);
        return listProducts(ctx, auth.userId, params.id);
      },
    });

    // ------------------------------------------------------------------ markers, clips, recording, translation
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/markers',
      summary: 'Team: drop a marker at the current moment',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: markerBody,
      rateLimit: W,
      handler: async ({ auth, reply, params, body }) => {
        const m = await addMarker(ctx, auth, params.id, body);
        void reply.code(201);
        return m;
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/markers',
      summary: 'Team: markers',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => listMarkers(ctx, auth, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/clips',
      summary: 'Team: mark a time range as a clip (draft)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: clipBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        const c = await createClip(ctx, auth, params.id, body, req);
        void reply.code(201);
        return c;
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/live/:id/clips',
      summary: 'Team: clips',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => listClips(ctx, auth, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/recording',
      summary: 'Host: attach my own uploaded recording (video/audio) to the ended session',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: recordingBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await attachRecording(ctx, auth, params.id, body.mediaId, req);
        return { attached: true };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/clips/:cid/studio',
      summary:
        'Host: open a clip as a Studio project (409 no_recording until a recording is attached; nothing is published)',
      tags: ['live'],
      auth: 'user',
      params: z.object({ id: z.uuid(), cid: z.uuid() }),
      rateLimit: W,
      handler: async ({ auth, req, reply, params }) => {
        const r = await clipToStudio(ctx, auth, params.id, params.cid, req);
        void reply.code(201);
        return r;
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/live/:id/translate',
      summary: 'Translate a chat message or text (501 without a translation provider)',
      tags: ['live'],
      auth: 'user',
      params: idParams,
      body: translateBody,
      rateLimit: W,
      handler: async ({ auth, params, body }) => translate(ctx, auth.userId, params.id, body),
    });

    // ------------------------------------------------------------------ staff
    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/live/:id',
      summary: 'Staff: any session, whatever its visibility',
      tags: ['live', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      rateLimit: R,
      handler: async ({ params }) => staffView(ctx, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/live/:id/end',
      summary: 'Staff: end a session (reason required, audited)',
      tags: ['live', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({ reason: z.string().trim().min(3).max(200) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        sessionView(
          await endLive(ctx, params.id, { userId: auth.userId, kind: 'staff' }, body.reason, req),
          { team: true },
        ),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/live/maintenance',
      summary: 'Staff: run the live maintenance job once (ends stale sessions, cancels no-shows)',
      tags: ['live', 'staff'],
      auth: { staff: ['admin', 'superadmin'] },
      rateLimit: W,
      handler: async () => runLiveMaintenance(ctx),
    });
  },
};
