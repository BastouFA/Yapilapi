import { z } from 'zod';
import { VOICE_PURPOSES } from './voice.ts';

/** POST /v1/voice?purpose=…: what the recording is for (it decides how long it may be). */
export const voiceUploadQuerySchema = z.object({ purpose: z.enum(VOICE_PURPOSES).default('yap') });
