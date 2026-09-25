import { z } from 'zod';
import { invalid } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { registerExportSection } from '../privacy/index.js';
import { toSrt, toVtt, validateCues } from './captions.js';
import { validateEdl } from './edl.js';
import {
  createBody,
  createProject,
  cuesFromInput,
  deleteProject,
  deleteTrack,
  getTrack,
  langParam,
  listProjects,
  listTracks,
  loadProject,
  patchBody,
  patchProject,
  projectView,
  putTrack,
  setEdl,
  trackBody,
  trackView,
  validateBody,
} from './projects.js';
import {
  cancelPublication,
  getPublication,
  publicationView,
  publishBody,
  publishProject,
} from './publish.js';
import { jobView, listRenders, renderProject } from './render.js';
import { capabilities, resolveSpeech } from './runtime.js';
import { transcribeProject } from './speech.js';
import {
  acceptBody,
  acceptSuggestion,
  dismissSuggestion,
  generateBody,
  generateSuggestions,
  listSuggestions,
  suggestionView,
} from './suggestions.js';

export { publishDueStudioPosts } from './publish.js';
export { overrideStudioRuntime, getStudioRuntime, type AssistProvider } from './runtime.js';
export { renderProject } from './render.js';

const idParams = z.object({ id: z.uuid() });
const langParams = z.object({ id: z.uuid(), lang: langParam });
const W = { limit: 120, windowSec: 600, by: 'user' } as const;
const WRITE = { limit: 60, windowSec: 600, by: 'user' } as const;

export const studioModule: ApiModule = {
  name: 'studio',
  register(app, ctx: AppContext) {
    registerExportSection({
      key: 'creator_studio',
      description:
        'Studio projects (edit recipes, caption tracks, suggestions you saw) and publication confirmations',
      collect: async (_c, db, u) => ({
        projects: (
          await db.query(
            'SELECT id, title, description, media_id, status, edl, ai_assisted, published_post_id, created_at FROM studio_projects WHERE owner_id = $1 AND deleted_at IS NULL',
            [u],
          )
        ).rows,
        captionTracks: (
          await db.query(
            'SELECT t.project_id, t.lang, t.label, t.kind, t.source, t.cues FROM studio_caption_tracks t JOIN studio_projects p ON p.id = t.project_id WHERE p.owner_id = $1',
            [u],
          )
        ).rows,
        publications: (
          await db.query(
            'SELECT id, project_id, mode, publish_at, status, post_id, confirmed_at FROM studio_publications WHERE confirmed_by = $1',
            [u],
          )
        ).rows,
      }),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/status',
      summary:
        'What this server can do for the studio: video tools, speech provider, AI suggestions (honest, never assumed)',
      tags: ['studio'],
      auth: 'user',
      rateLimit: W,
      handler: async () => {
        const c = await capabilities(ctx);
        return {
          render: {
            available: c.available && c.libx264 && c.aac,
            burnInCaptions: c.available && c.subtitles,
          },
          analysis: { available: c.available },
          speech: { available: Boolean(await resolveSpeech(ctx)) },
          aiSuggestions: { available: ctx.config.AI_ENABLED },
        };
      },
    });

    // ------------------------------------------------------------------ pure validators (no project needed)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/edl/validate',
      summary: 'Validate an edit recipe against a source duration (no data is stored)',
      tags: ['studio'],
      auth: 'user',
      body: z.object({
        edl: z.unknown(),
        durationMs: z.number().int().min(1).max(86_400_000),
        kind: z.enum(['video', 'audio']).default('video'),
      }),
      rateLimit: W,
      handler: async ({ body }) => {
        const v = validateEdl(body.edl, { durationMs: body.durationMs, kind: body.kind });
        return v.ok ? { valid: true, issues: [] } : { valid: false, issues: v.issues };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/captions/validate',
      summary: 'Validate WebVTT, SRT or cues (no data is stored): returns what is wrong and where',
      tags: ['studio'],
      auth: 'user',
      body: validateBody,
      rateLimit: W,
      handler: async ({ body }) => {
        try {
          const r = cuesFromInput(body);
          return { valid: true, cues: r.cues.length, issues: validateCues(r.cues) };
        } catch (e) {
          const d = (e as { details?: { issues?: unknown[] } }).details;
          if (
            e instanceof Error &&
            'code' in e &&
            (e as { code: string }).code === 'validation_failed'
          )
            return { valid: false, cues: 0, error: e.message, issues: d?.issues ?? [] };
          throw e;
        }
      },
    });

    // ------------------------------------------------------------------ projects
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects',
      summary:
        'Create a project from one of my videos or audio files (the file itself is never modified)',
      tags: ['studio'],
      auth: 'user',
      body: createBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, body }) => {
        const p = await createProject(ctx, auth, body, req);
        void reply.code(201);
        return projectView(p);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects',
      summary: 'My projects',
      tags: ['studio'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => ({
        items: (await listProjects(ctx.db, auth.userId)).map((p) => projectView(p)),
      }),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects/:id',
      summary: 'One project with its caption tracks, open suggestions and publication',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        const p = await loadProject(ctx.db, params.id, auth.userId);
        const [tracks, suggestions, pub] = await Promise.all([
          listTracks(ctx.db, p.id),
          listSuggestions(ctx.db, p.id),
          getPublication(ctx.db, p.id),
        ]);
        return projectView(p, {
          captionTracks: tracks.map(trackView),
          suggestions: suggestions.map(suggestionView),
          publication: pub ? publicationView(pub) : null,
        });
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/studio/projects/:id',
      summary: 'Rename a project or edit its description',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      body: patchBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) =>
        projectView(await patchProject(ctx, auth, params.id, body, req)),
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/studio/projects/:id',
      summary: 'Delete a project (the media and any published post stay)',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: WRITE,
      handler: async ({ auth, req, params }) => {
        await deleteProject(ctx, auth, params.id, req);
      },
    });

    // ------------------------------------------------------------------ EDL
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/studio/projects/:id/edl',
      summary:
        'Replace the edit recipe (trim/cut segments, aspect crop, thumbnail, captions). Validated against the media; send expectedVersion to detect concurrent edits',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      body: z.object({ edl: z.unknown(), expectedVersion: z.number().int().min(1).optional() }),
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        if (body.edl === undefined) throw invalid('edl is required');
        return projectView(await setEdl(ctx, auth, params.id, body.edl, body.expectedVersion, req));
      },
    });

    // ------------------------------------------------------------------ captions
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects/:id/captions',
      summary: 'Caption tracks of a project',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await loadProject(ctx.db, params.id, auth.userId);
        return { items: (await listTracks(ctx.db, params.id)).map(trackView) };
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/studio/projects/:id/captions/:lang',
      summary:
        'Create or replace a caption track from cues, WebVTT or SRT (manual typing and file import both end up as validated cues)',
      tags: ['studio'],
      auth: 'user',
      params: langParams,
      body: trackBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) =>
        trackView(await putTrack(ctx, auth, params.id, params.lang, body, undefined, req)),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects/:id/captions/:lang',
      summary: 'Export a caption track as JSON cues, WebVTT (?format=vtt) or SRT (?format=srt)',
      tags: ['studio'],
      auth: 'user',
      params: langParams,
      query: z.object({ format: z.enum(['json', 'vtt', 'srt']).default('json') }),
      rateLimit: W,
      handler: async ({ auth, reply, params, query }) => {
        await loadProject(ctx.db, params.id, auth.userId);
        const t = await getTrack(ctx.db, params.id, params.lang);
        if (query.format === 'vtt') {
          void reply.type('text/vtt; charset=utf-8');
          return toVtt(t.cues);
        }
        if (query.format === 'srt') {
          void reply.type('application/x-subrip; charset=utf-8');
          return toSrt(t.cues);
        }
        return { ...trackView(t), cuesList: t.cues };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/studio/projects/:id/captions/:lang',
      summary: 'Delete a caption track',
      tags: ['studio'],
      auth: 'user',
      params: langParams,
      rateLimit: WRITE,
      handler: async ({ auth, req, params }) => {
        await deleteTrack(ctx, auth, params.id, params.lang, req);
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects/:id/transcribe',
      summary:
        'Transcribe the project media with the configured speech provider into a caption track. 501 feature_disabled when no provider is configured (type or import captions instead)',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      body: z.object({ language: z.string().trim().min(2).max(12).optional() }),
      rateLimit: { limit: 10, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const t = await transcribeProject(ctx, auth, params.id, body.language, req);
        void reply.code(201);
        return trackView(t);
      },
    });

    // ------------------------------------------------------------------ render
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects/:id/render',
      summary:
        'Render the edit with ffmpeg into a NEW media file (503 processing_unavailable without ffmpeg). Idempotent for an unchanged recipe',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 10, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, reply, params }) => {
        const r = await renderProject(ctx, auth, params.id, req);
        void reply.code(r.reused ? 200 : 201);
        return {
          job: jobView(r.job),
          project: projectView(r.project),
          outputMediaId: r.project.output_media_id,
          reused: r.reused,
        };
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects/:id/renders',
      summary: 'Render history of a project',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => ({
        items: (await listRenders(ctx, auth, params.id)).map(jobView),
      }),
    });

    // ------------------------------------------------------------------ suggestions (proposals only)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects/:id/suggestions',
      summary:
        'Ask for suggestions: silence cuts, highlight clips, thumbnail moments (ffmpeg heuristics), caption review, and AI titles/descriptions. Proposals only: nothing is applied or published',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      body: generateBody,
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const r = await generateSuggestions(ctx, auth, params.id, body, req);
        void reply.code(201);
        return { items: r.created.map(suggestionView), skipped: r.skipped };
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects/:id/suggestions',
      summary: 'Suggestions of a project',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await loadProject(ctx.db, params.id, auth.userId);
        return { items: (await listSuggestions(ctx.db, params.id)).map(suggestionView) };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects/:id/suggestions/:sid/accept',
      summary:
        'Apply one suggestion to the DRAFT project (edit recipe, title or description). Never publishes',
      tags: ['studio'],
      auth: 'user',
      params: z.object({ id: z.uuid(), sid: z.uuid() }),
      body: acceptBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) =>
        projectView(await acceptSuggestion(ctx, auth, params.id, params.sid, body, req)),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects/:id/suggestions/:sid/dismiss',
      summary: 'Dismiss a suggestion',
      tags: ['studio'],
      auth: 'user',
      params: z.object({ id: z.uuid(), sid: z.uuid() }),
      rateLimit: WRITE,
      handler: async ({ auth, req, params }) =>
        suggestionView(await dismissSuggestion(ctx, auth, params.id, params.sid, req)),
    });

    // ------------------------------------------------------------------ publish (explicit only)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/studio/projects/:id/publish',
      summary:
        'Publish the project as a post. Requires confirm:true. mode "now" posts immediately; mode "scheduled" stores exactly what you confirmed and publishes it later only if nothing changed',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      body: publishBody,
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        const r = await publishProject(ctx, auth, params.id, body, req);
        void reply.code(r.postId ? 201 : 202);
        return { publication: publicationView(r.publication), postId: r.postId };
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/studio/projects/:id/publication',
      summary: 'The latest publication confirmation of a project',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await loadProject(ctx.db, params.id, auth.userId);
        const p = await getPublication(ctx.db, params.id);
        return { publication: p ? publicationView(p) : null };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/studio/projects/:id/publication',
      summary: 'Cancel a scheduled publication before it runs',
      tags: ['studio'],
      auth: 'user',
      params: idParams,
      rateLimit: WRITE,
      handler: async ({ auth, req, params }) =>
        publicationView(await cancelPublication(ctx, auth, params.id, req)),
    });
  },
};
