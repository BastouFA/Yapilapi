import type { Config } from '../config.ts';

/**
 * Speech-to-text for automatic captions. There is no built-in or fake
 * transcriber: when no provider is configured, automatic captions are simply
 * unavailable and the API says so.
 */
export interface TranscriptionProvider {
  name: string;
  /** Returns a WebVTT document for the audio. */
  transcribe(input: { audio: Buffer; filename: string; mime: string; language?: string }): Promise<string>;
}

/** Most hosted speech-to-text APIs cap a single request at 25 MB of audio. */
export const MAX_TRANSCRIBE_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Any service that implements the OpenAI-compatible
 * POST {base}/audio/transcriptions endpoint with response_format=vtt
 * (OpenAI, Groq, self-hosted Whisper servers).
 */
export function openAiCompatibleTranscriber(opts: { baseUrl: string; apiKey: string; model: string }): TranscriptionProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    name: 'openai-compatible',
    async transcribe({ audio, filename, mime, language }) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
      form.append('model', opts.model);
      form.append('response_format', 'vtt');
      if (language) form.append('language', language.split('-')[0]!);
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Transcription service returned ${res.status}: ${text.slice(0, 200)}`);
      return text;
    },
  };
}

/** The configured provider, or null when automatic captions aren't set up. */
export function transcriberFromConfig(config: Config): TranscriptionProvider | null {
  if (config.TRANSCRIBE_PROVIDER === 'openai-compatible' && config.TRANSCRIBE_API_URL)
    return openAiCompatibleTranscriber({ baseUrl: config.TRANSCRIBE_API_URL, apiKey: config.TRANSCRIBE_API_KEY, model: config.TRANSCRIBE_MODEL });
  return null;
}
