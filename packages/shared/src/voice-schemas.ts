import { z } from 'zod';
import { VOICE_PURPOSES } from './voice.ts';

/** POST /v1/voice?purpose=…: what the recording is for (it decides how long it may be). */
export const voiceUploadQuerySchema = z.object({ purpose: z.enum(VOICE_PURPOSES).default('yap') });

/** PUT /v1/posts/:id/voice: record a posted Yap again with a new clip (uploaded with purpose 'yap'). */
export const redoVoiceSchema = z.object({ voiceId: z.string().uuid() });
