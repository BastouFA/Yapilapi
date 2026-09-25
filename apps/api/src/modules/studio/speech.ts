import type { FastifyRequest } from 'fastify';
import { AppError } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { notImplementedHere } from '../../lib/status-error.js';
import { hasConsent } from '../privacy/index.js';
import { loadProject, loadSource, putTrack, type TrackRow } from './projects.js';
import { resolveSpeech } from './runtime.js';

/**
 * Speech-to-text for a project's own media through the deployment's `SpeechProvider` (the seam defined by the AI platform). Without a
 * provider the answer is 501 feature_disabled: there is no honest offline transcriber, so nothing is ever fabricated. The manual path
 * (typing/importing cues via PUT /captions/:lang) always works. The resulting track is an ordinary, editable caption track (source 'speech').
 */
export async function transcribeProject(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  language: string | undefined,
  req?: FastifyRequest,
): Promise<TrackRow> {
  const p = await loadProject(ctx.db, projectId, auth.userId); // ownership first: someone else's project is a 404, whatever the server can do
  const provider = await resolveSpeech(ctx);
  if (!provider)
    throw notImplementedHere(
      'Automatic transcription needs a speech provider and none is configured on this server. You can type or import captions instead.',
      { reason: 'speech_unavailable' },
    );
  if (!(await hasConsent(ctx, auth.userId, 'ai_processing')))
    throw new AppError(
      'forbidden',
      'Turn on AI assistance in your privacy settings to transcribe with a provider',
      { reason: 'consent_required', purpose: 'ai_processing' },
    );
  const src = await loadSource(ctx.db, p);
  const t = await provider.transcribe({
    mediaId: src.id,
    userId: auth.userId,
    ...(language ? { language } : {}),
  });
  const cues = t.segments
    .filter((s) => s.text.trim())
    .map((s) => ({
      startMs: Math.round(s.startMs),
      endMs: Math.round(s.endMs),
      text: s.text.trim().slice(0, 500),
    }));
  if (!cues.length)
    throw new AppError('unprocessable', 'The provider found no speech to transcribe', {
      reason: 'no_speech',
    });
  const lang = (t.language || language || 'und').toLowerCase().slice(0, 12);
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(lang))
    throw new AppError('unprocessable', 'The provider returned an unusable language tag', {
      reason: 'bad_language',
    });
  const track = await putTrack(
    ctx,
    auth,
    projectId,
    lang,
    { kind: 'captions', cues, label: '' },
    'speech',
    req,
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'studio.transcribed',
      targetType: 'studio_project',
      targetId: projectId,
      metadata: { provider: provider.name, lang, cues: cues.length },
    },
    req,
  );
  return track;
}
