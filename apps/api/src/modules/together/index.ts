import { z } from 'zod';
import { route } from '../../lib/route.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { resolveUser } from '../../lib/users.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { registerExportSection } from '../privacy/index.js';
import {
  EXPERIENCE_VISIBILITIES,
  addContribution,
  getContribution,
  createExperience,
  deleteExperience,
  exportAsMemory,
  getExperienceView,
  inviteMember,
  leaveExperience,
  listMembers,
  listMine,
  listProfileExperiences,
  loadTimeline,
  releaseUserFromExperiences,
  removeContribution,
  removeMember,
  respondToInvite,
  setCover,
  setExperienceStatus,
  setMemberRole,
  setProfileOptIn,
  suggestInvites,
  updateExperience,
} from './service.js';

export { experienceVisibleSql, contributionVisibleSql, joinedMemberSql } from './access.js';
export { exportAsMemory, releaseUserFromExperiences } from './service.js';

const idParams = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const contribParams = z.object({ id: z.uuid(), contributionId: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const iso = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  eventId: z.uuid().optional(),
  placeId: z.uuid().optional(),
  startsAt: iso.optional(),
  endsAt: iso.optional(),
  visibility: z.enum(EXPERIENCE_VISIBILITIES).default('private'),
});
const patchBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  eventId: z.uuid().nullable().optional(),
  placeId: z.uuid().nullable().optional(),
  startsAt: iso.nullable().optional(),
  endsAt: iso.nullable().optional(),
  visibility: z.enum(EXPERIENCE_VISIBILITIES).optional(),
});
const contributionBody = z.object({
  mediaId: z.uuid().optional(),
  realCaptureId: z.uuid().optional(),
  body: z.string().max(2000).default(''),
  takenAt: iso.optional(),
});

export const togetherModule: ApiModule = {
  name: 'together',
  register(app, ctx: AppContext) {
    const gate = (userId: string) => ctx.flags.require('REAL_TOGETHER', userId);
    const W = { limit: 120, windowSec: 3600, by: 'user' } as const;
    const R = { limit: 600, windowSec: 600, by: 'user' } as const;
    const actorOf = (a: { userId: string; ageBand: 'teen' | 'adult' }) => ({
      userId: a.userId,
      ageBand: a.ageBand,
    });

    registerExportSection({
      key: 'together',
      description: 'Shared experiences you belong to and the perspectives you contributed',
      collect: async (_c, db, u) => ({
        experiences: (
          await db.query(
            `SELECT e.id, e.title, e.description, e.status, e.visibility, m.role, m.status AS membership, m.joined_at, m.show_on_profile
             FROM shared_experience_members m JOIN shared_experiences e ON e.id = m.experience_id AND e.deleted_at IS NULL WHERE m.user_id = $1 ORDER BY e.created_at DESC LIMIT 5000`,
            [u],
          )
        ).rows,
        contributions: (
          await db.query(
            `SELECT c.id, c.experience_id, c.body, c.media_id, c.real_capture_id, c.taken_at, c.created_at FROM shared_experience_contributions c WHERE c.contributor_id = $1 AND c.deleted_at IS NULL ORDER BY c.taken_at DESC LIMIT 20000`,
            [u],
          )
        ).rows,
      }),
    });
    registerDeletionHook(async (c, tx, userId) => releaseUserFromExperiences(c, tx, userId));

    route(app, ctx, {
      method: 'POST',
      url: '/v1/together',
      summary:
        'Create a shared experience (you are the owner; nothing is visible until you invite people or open the audience)',
      tags: ['together'],
      auth: 'user',
      body: createBody,
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const id = await createExperience(ctx, actorOf(auth), body, req);
        void reply.code(201);
        return getExperienceView(ctx, auth.userId, id);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/together',
      summary: 'My shared experiences (or my pending invitations with ?membership=invited)',
      tags: ['together'],
      auth: 'user',
      rateLimit: R,
      query: pageQuery.extend({
        membership: z.enum(['joined', 'invited']).default('joined'),
        includeArchived: z
          .enum(['true', 'false'])
          .default('false')
          .transform((v) => v === 'true'),
      }),
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        return listMine(ctx, auth.userId, query);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/together/:id',
      summary:
        'A shared experience (404 unless you are a member/invitee or it is friends/public and you qualify)',
      tags: ['together'],
      auth: 'optional',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('REAL_TOGETHER');
        return getExperienceView(ctx, auth?.userId ?? null, params.id);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/together/:id',
      summary: 'Edit title, description, links, time window or audience (owner)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      body: patchBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await updateExperience(ctx, actorOf(auth), params.id, body, req);
        return getExperienceView(ctx, auth.userId, params.id);
      },
    });

    for (const [path, to] of [
      ['close', 'closed'],
      ['reopen', 'open'],
      ['archive', 'archived'],
    ] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/together/:id/${path}`,
        summary: `${path[0]!.toUpperCase()}${path.slice(1)} the experience (owner)`,
        tags: ['together'],
        auth: 'user',
        params: idParams,
        rateLimit: W,
        handler: async ({ auth, req, params }) => {
          await gate(auth.userId);
          await setExperienceStatus(ctx, actorOf(auth), params.id, to, req);
          return getExperienceView(ctx, auth.userId, params.id);
        },
      });
    }

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/together/:id',
      summary: 'Delete the experience and every perspective in it (owner)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await deleteExperience(ctx, actorOf(auth), params.id, req);
      },
    });

    // ------------------------------------------------------------------ members
    route(app, ctx, {
      method: 'GET',
      url: '/v1/together/:id/members',
      summary: 'Members (owner also sees pending invitations)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return listMembers(ctx, auth.userId, params.id);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/together/:id/members',
      summary: 'Invite a friend as contributor or viewer (owner)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      body: z.object({
        userId: z.uuid(),
        role: z.enum(['contributor', 'viewer']).default('contributor'),
      }),
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        void reply.code(201);
        return inviteMember(ctx, actorOf(auth), params.id, body, req);
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/together/:id/members/:userId',
      summary: "Change a member's role (owner)",
      tags: ['together'],
      auth: 'user',
      params: memberParams,
      body: z.object({ role: z.enum(['contributor', 'viewer']) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await setMemberRole(ctx, actorOf(auth), params.id, params.userId, body.role, req);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/together/:id/members/:userId',
      summary: 'Remove a member and withdraw their contributions (owner)',
      tags: ['together'],
      auth: 'user',
      params: memberParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await removeMember(ctx, actorOf(auth), params.id, params.userId, req);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/together/:id/accept',
      summary: 'Accept my invitation',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return respondToInvite(ctx, actorOf(auth), params.id, true);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/together/:id/decline',
      summary: 'Decline my invitation',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return respondToInvite(ctx, actorOf(auth), params.id, false);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/together/:id/leave',
      summary: 'Leave (your contributions are withdrawn unless keepContributions is true)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      body: z.object({ keepContributions: z.boolean().default(false) }),
      rateLimit: W,
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        await leaveExperience(ctx, actorOf(auth), params.id, body.keepContributions);
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/together/:id/profile',
      summary: 'Show or hide this experience on MY profile (off by default; only I can turn it on)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      body: z.object({ show: z.boolean() }),
      rateLimit: W,
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        await setProfileOptIn(ctx, actorOf(auth), params.id, body.show);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/together/:id/suggested-invites',
      summary:
        'Friends who attended the linked event (owner; only people the events module lets you see)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return suggestInvites(ctx, actorOf(auth), params.id);
      },
    });

    // ------------------------------------------------------------------ contributions
    route(app, ctx, {
      method: 'POST',
      url: '/v1/together/:id/contributions',
      summary: 'Add my perspective: media, one of my Reals, or text',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      body: contributionBody,
      rateLimit: W,
      handler: async ({ auth, reply, params, body }) => {
        await gate(auth.userId);
        const cid = await addContribution(ctx, actorOf(auth), params.id, body);
        void reply.code(201);
        // Own contributions are always visible to their author, even while held for review.
        return getContribution(ctx, auth.userId, params.id, cid);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/together/:id/timeline',
      summary: 'All perspectives merged chronologically, each with attribution',
      tags: ['together'],
      auth: 'optional',
      params: idParams,
      query: pageQuery.extend({
        order: z.enum(['asc', 'desc']).default('asc'),
        contributorId: z.uuid().optional(),
      }),
      rateLimit: R,
      handler: async ({ auth, params, query }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('REAL_TOGETHER');
        return loadTimeline(ctx, auth?.userId ?? null, params.id, query);
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/together/:id/contributions/:contributionId',
      summary: 'Remove a contribution (its contributor, or the owner)',
      tags: ['together'],
      auth: 'user',
      params: contribParams,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await removeContribution(ctx, actorOf(auth), params.id, params.contributionId, req);
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/together/:id/cover',
      summary: 'Owner pins the cover; other contributors vote for one (contributionId null clears)',
      tags: ['together'],
      auth: 'user',
      params: idParams,
      body: z.object({ contributionId: z.uuid().nullable() }),
      rateLimit: W,
      handler: async ({ auth, params, body }) => {
        await gate(auth.userId);
        return { cover: await setCover(ctx, actorOf(auth), params.id, body.contributionId) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/together/:id/memory',
      summary:
        'Keep my own copy as a private memory (your contributions + a link to the experience)',
      tags: ['together', 'memory'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, reply, params }) => {
        await gate(auth.userId);
        await ctx.flags.require('MEMORY', auth.userId);
        const memoryId = await exportAsMemory(ctx, actorOf(auth), params.id, req);
        void reply.code(201);
        return { memoryId };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username/experiences',
      summary: 'Experiences a person chose to show on their profile (only those you may see)',
      tags: ['together', 'profiles'],
      auth: 'optional',
      params: z.object({ username: z.string().min(1).max(40) }),
      query: pageQuery,
      rateLimit: R,
      handler: async ({ auth, params, query }) => {
        if (auth) await gate(auth.userId);
        else await ctx.flags.require('REAL_TOGETHER');
        const target = await resolveUser(ctx, auth?.userId ?? null, params.username);
        return listProfileExperiences(ctx, auth?.userId ?? null, target.id, query);
      },
    });
  },
};
