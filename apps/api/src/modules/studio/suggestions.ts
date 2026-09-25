import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { hasConsent } from '../privacy/index.js';
import { analyseSilence } from './analysis.js';
import { reviewCues } from './captions.js';
import { cutMany, edlHash, sourceToOutput, validateEdl, type Edl } from './edl.js';
import {
  getTrack,
  listTracks,
  loadProject,
  loadSource,
  staleOpenPublication,
  type ProjectRow,
} from './projects.js';
import { resolveAssist } from './runtime.js';
import { highlightCandidates, silenceCuts, thumbnailMoments } from './silence.js';

export const KINDS = [
  'title',
  'description',
  'thumbnail',
  'silence_cuts',
  'highlights',
  'captions_review',
] as const;
export type Kind = (typeof KINDS)[number];
export const generateBody = z.object({
  kinds: z.array(z.enum(KINDS)).min(1).max(KINDS.length),
  lang: z.string().trim().min(2).max(12).optional(),
});
export const acceptBody = z.object({
  index: z.number().int().min(0).max(20).optional(),
  text: z.string().trim().min(1).max(10_000).optional(),
});

export interface SuggestionRow {
  id: string;
  project_id: string;
  kind: Kind;
  source: 'heuristic' | 'ffmpeg' | 'ai_module';
  provider: string | null;
  payload: Record<string, unknown>;
  status: 'suggested' | 'accepted' | 'dismissed';
  created_at: Date;
  decided_at: Date | null;
}
const COLS = 'id, project_id, kind, source, provider, payload, status, created_at, decided_at';
export const suggestionView = (s: SuggestionRow) => ({
  id: s.id,
  kind: s.kind,
  source: s.source,
  provider: s.provider,
  status: s.status,
  payload: s.payload,
  createdAt: s.created_at.toISOString(),
  decidedAt: s.decided_at?.toISOString() ?? null,
  // Said plainly to clients: these are proposals. Nothing was changed, and nothing is ever published because of them.
  appliedAutomatically: false,
});

async function store(
  db: Queryable,
  projectId: string,
  kind: Kind,
  source: SuggestionRow['source'],
  provider: string | null,
  payload: Record<string, unknown>,
): Promise<SuggestionRow> {
  await db.query(
    `UPDATE studio_suggestions SET status = 'dismissed', decided_at = now() WHERE project_id = $1 AND kind = $2 AND status = 'suggested'`,
    [projectId, kind],
  ); // one open proposal per kind
  return (
    await db.query<SuggestionRow>(
      `INSERT INTO studio_suggestions (project_id, kind, source, provider, payload) VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
      [projectId, kind, source, provider, JSON.stringify(payload)],
    )
  ).rows[0]!;
}

export interface Skipped {
  kind: Kind;
  reason: string;
  message: string;
}

/**
 * Create proposals. Each kind is independent: a kind that cannot be produced here (no ffmpeg, no AI provider, no captions yet) is reported in
 * `skipped` with the reason instead of failing the others. Nothing is applied to the project: applying is `acceptSuggestion`, by the creator.
 */
export async function generateSuggestions(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  b: z.infer<typeof generateBody>,
  req?: FastifyRequest,
): Promise<{ created: SuggestionRow[]; skipped: Skipped[] }> {
  const p = await loadProject(ctx.db, projectId, auth.userId);
  const src = await loadSource(ctx.db, p);
  const created: SuggestionRow[] = [];
  const skipped: Skipped[] = [];
  const kinds = [...new Set(b.kinds)];
  const skip = (kind: Kind, reason: string, message: string) =>
    skipped.push({ kind, reason, message });

  let silences: Awaited<ReturnType<typeof analyseSilence>> | null = null;
  const silence = async () => (silences ??= await analyseSilence(ctx, src));
  const guarded = async (kind: Kind, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (
        (err instanceof AppError &&
          ['unavailable', 'feature_disabled', 'forbidden'].includes(err.code)) ||
        (err instanceof AppError && err.status === 501)
      )
        skip(
          kind,
          String((err.details as { reason?: string } | undefined)?.reason ?? err.code),
          err.message,
        );
      else throw err;
    }
  };

  const tracks = await listTracks(ctx.db, projectId);
  const transcript = (lang?: string): string => {
    const t =
      tracks.find((x) => x.lang === (lang ?? p.edl.captions?.lang.toLowerCase())) ?? tracks[0];
    return t
      ? t.cues
          .map((c) => c.text)
          .join(' ')
          .slice(0, 1200)
      : '';
  };

  for (const kind of kinds) {
    if (kind === 'silence_cuts')
      await guarded(kind, async () => {
        const cuts = silenceCuts(await silence());
        created.push(
          await store(ctx.db, projectId, kind, 'ffmpeg', null, {
            cuts,
            totalCutMs: cuts.reduce((n, r) => n + (r.endMs - r.startMs), 0),
            thresholdDb: -35,
            minSilenceMs: 800,
            note: 'Based on audio level only. Listen before you apply it.',
          }),
        );
      });
    if (kind === 'highlights')
      await guarded(kind, async () => {
        const clips = highlightCandidates(await silence(), src.duration_ms);
        created.push(
          await store(ctx.db, projectId, kind, 'ffmpeg', null, {
            clips,
            note: 'Longest stretches without silence: a rough guide to where something happens, not a judgement of quality.',
          }),
        );
      });
    if (kind === 'thumbnail')
      await guarded(kind, async () => {
        if (src.kind !== 'video') {
          skip(kind, 'not_video', 'Thumbnails only apply to video');
          return;
        }
        created.push(
          await store(ctx.db, projectId, kind, 'ffmpeg', null, {
            momentsMs: thumbnailMoments(await silence(), src.duration_ms),
            note: 'Moments (source time) that are not silent. Pick the frame you like.',
          }),
        );
      });
    if (kind === 'captions_review')
      await guarded(kind, async () => {
        const t = b.lang
          ? await getTrack(ctx.db, projectId, b.lang.toLowerCase())
          : (tracks.find((x) => x.lang === p.edl.captions?.lang.toLowerCase()) ?? tracks[0]);
        if (!t) {
          skip(kind, 'no_captions', 'Add a caption track first');
          return;
        }
        created.push(
          await store(ctx.db, projectId, kind, 'heuristic', null, {
            lang: t.lang,
            findings: reviewCues(t.cues),
          }),
        );
      });
    if (kind === 'title' || kind === 'description')
      await guarded(kind, async () => {
        if (!(await hasConsent(ctx, auth.userId, 'ai_processing')))
          throw new AppError(
            'forbidden',
            'Turn on AI assistance in your privacy settings to get AI suggestions',
            { reason: 'consent_required', purpose: 'ai_processing' },
          );
        const assist = resolveAssist(ctx);
        const context =
          `${p.title}${p.description ? `. ${p.description}` : ''}${transcript(b.lang) ? `. What is said: ${transcript(b.lang)}` : ''}`.slice(
            0,
            1400,
          );
        if (kind === 'title') {
          const r = await assist.suggestTitles({
            ctx,
            auth,
            req,
            topic: context.length >= 3 ? context : p.title.padEnd(3, '.'),
            count: 5,
          });
          created.push(
            await store(ctx.db, projectId, kind, 'ai_module', r.provider, {
              titles: r.titles,
              draftId: r.draftId,
              note: 'AI-written. Choose one, or ignore them.',
            }),
          );
        } else {
          const r = await assist.draftDescription({
            ctx,
            auth,
            req,
            notes: context.length >= 3 ? context : p.title.padEnd(3, '.'),
          });
          created.push(
            await store(ctx.db, projectId, kind, 'ai_module', r.provider, {
              text: r.text,
              draftId: r.draftId,
              note: 'AI-written. Edit it before you use it.',
            }),
          );
        }
      });
  }
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'studio.suggestions_created',
      targetType: 'studio_project',
      targetId: projectId,
      metadata: {
        created: created.map((c) => c.kind),
        skipped: skipped.map((s) => `${s.kind}:${s.reason}`),
      },
    },
    req,
  );
  return { created, skipped };
}

export async function listSuggestions(db: Queryable, projectId: string): Promise<SuggestionRow[]> {
  return (
    await db.query<SuggestionRow>(
      `SELECT ${COLS} FROM studio_suggestions WHERE project_id = $1 ORDER BY created_at DESC, id LIMIT 50`,
      [projectId],
    )
  ).rows;
}

async function loadSuggestion(
  db: Queryable,
  projectId: string,
  id: string,
  lock = false,
): Promise<SuggestionRow> {
  const s = (
    await db.query<SuggestionRow>(
      `SELECT ${COLS} FROM studio_suggestions WHERE id = $1 AND project_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [id, projectId],
    )
  ).rows[0];
  if (!s) throw notFound('Suggestion');
  return s;
}

export async function dismissSuggestion(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  id: string,
  req?: FastifyRequest,
): Promise<SuggestionRow> {
  await loadProject(ctx.db, projectId, auth.userId);
  const s = await loadSuggestion(ctx.db, projectId, id);
  if (s.status !== 'suggested')
    throw conflict(`This suggestion is already ${s.status}`, { reason: 'suggestion_decided' });
  const r = await ctx.db.query<SuggestionRow>(
    `UPDATE studio_suggestions SET status = 'dismissed', decided_at = now() WHERE id = $1 AND status = 'suggested' RETURNING ${COLS}`,
    [id],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'studio.suggestion_dismissed',
      targetType: 'studio_suggestion',
      targetId: id,
      metadata: { kind: s.kind },
    },
    req,
  );
  return r.rows[0] ?? s;
}

const AI_NAME: Partial<Record<Kind, string>> = {
  title: 'studio_title',
  description: 'studio_description',
};

/**
 * The creator applies a proposal. This is the ONLY way a suggestion changes a project, and it changes the DRAFT project only (never a post):
 * silence cuts and highlight clips edit the EDL (re-validated), a thumbnail moment sets the EDL thumbnail, a title/description fills the project
 * fields. AI-sourced suggestions are recorded in `ai_assisted`, which later becomes the post's AI provenance.
 */
export async function acceptSuggestion(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  id: string,
  b: z.infer<typeof acceptBody>,
  req?: FastifyRequest,
): Promise<ProjectRow> {
  return withTransaction(ctx.db, async (tx) => {
    const p = await loadProject(tx, projectId, auth.userId, true);
    const s = await loadSuggestion(tx, projectId, id, true);
    if (s.status !== 'suggested')
      throw conflict(`This suggestion is already ${s.status}`, { reason: 'suggestion_decided' });
    const src = await loadSource(tx, p);
    let edl: Edl = p.edl;
    let title = p.title;
    let description = p.description;
    const pay = s.payload as Record<string, unknown>;
    switch (s.kind) {
      case 'silence_cuts': {
        const cuts = (pay.cuts as Array<{ startMs: number; endMs: number }>) ?? [];
        if (!cuts.length)
          throw new AppError('unprocessable', 'This suggestion has nothing to cut', {
            reason: 'nothing_to_apply',
          });
        edl = cutMany(p.edl, src, cuts);
        break;
      }
      case 'highlights': {
        const clips = (pay.clips as Array<{ startMs: number; endMs: number }>) ?? [];
        const clip = clips[b.index ?? 0];
        if (!clip) throw invalid('Choose one of the suggested clips (index)');
        edl = { ...p.edl, segments: [{ startMs: clip.startMs, endMs: clip.endMs }] };
        break;
      }
      case 'thumbnail': {
        const moments = (pay.momentsMs as number[]) ?? [];
        const at = moments[b.index ?? 0];
        if (at === undefined) throw invalid('Choose one of the suggested moments (index)');
        const out = sourceToOutput(p.edl, src, at);
        if (out === null)
          throw new AppError('unprocessable', 'That moment is cut out of your edit', {
            reason: 'moment_cut',
          });
        edl = { ...p.edl, thumbnail: { atMs: out } };
        break;
      }
      case 'title': {
        const titles = (pay.titles as string[]) ?? [];
        const t = b.text ?? titles[b.index ?? 0];
        if (!t)
          throw invalid('Choose one of the suggested titles (index) or send the text you want');
        title = t.slice(0, 160);
        break;
      }
      case 'description': {
        const t = b.text ?? (pay.text as string | undefined);
        if (!t) throw invalid('There is no text to use');
        description = t.slice(0, 10_000);
        break;
      }
      case 'captions_review':
        throw new AppError(
          'unprocessable',
          'A caption review has nothing to apply: fix the cues yourself, then dismiss it',
          { reason: 'not_applicable' },
        );
    }
    if (edl !== p.edl) {
      if (!edl.segments.length && s.kind !== 'thumbnail')
        throw new AppError('unprocessable', 'That would leave nothing of the video', {
          reason: 'empty_result',
        });
      const v = validateEdl(edl, { durationMs: src.duration_ms, kind: src.kind });
      if (!v.ok)
        throw new AppError('unprocessable', 'That suggestion no longer fits your edit', {
          reason: 'edl_invalid',
          issues: v.issues,
        });
      edl = v.edl;
    }
    const aiName = AI_NAME[s.kind];
    const changed = edl !== p.edl && edlHash(edl) !== edlHash(p.edl);
    const { rows } = await tx.query<ProjectRow>(
      `UPDATE studio_projects SET edl = $2, edl_version = edl_version + CASE WHEN $3 THEN 1 ELSE 0 END, title = $4, description = $5,
              status = CASE WHEN $3 AND status IN ('ready','failed','published') THEN 'draft' ELSE status END,
              ai_assisted = CASE WHEN $6::text IS NOT NULL AND NOT ($6::text = ANY(ai_assisted)) THEN array_append(ai_assisted, $6::text) ELSE ai_assisted END
        WHERE id = $1 RETURNING id, owner_id, title, description, media_id, status, edl, edl_version, output_media_id, rendered_edl_hash, render_error, ai_assisted, published_post_id, created_at, updated_at`,
      [projectId, JSON.stringify(edl), changed, title, description, aiName ?? null],
    );
    await tx.query(
      `UPDATE studio_suggestions SET status = 'accepted', decided_at = now() WHERE id = $1`,
      [id],
    );
    if (changed || title !== p.title || description !== p.description)
      await staleOpenPublication(tx, projectId);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.suggestion_accepted',
        targetType: 'studio_suggestion',
        targetId: id,
        metadata: { kind: s.kind, source: s.source, projectId },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
}
