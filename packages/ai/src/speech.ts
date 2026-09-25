/**
 * Speech and media-AI provider INTERFACES.
 *
 * Voice transcription/translation needs a real speech provider (there is no honest offline implementation), so this repo
 * defines the contract only: the API returns 501 `feature_disabled` until a provider is registered, and never fabricates
 * transcripts. Media-processing AI (transcription for editing, silence removal, clip detection) belongs to the Creator Studio
 * engineer: `MediaAiProvider` is the agreed seam and nothing in the AI platform implements it.
 */
export interface SpeechInput {
  /** The user's own media id; the provider fetches bytes through the media module's authorised access, not from the client. */
  mediaId: string;
  userId: string;
  /** BCP-47 hint; omitted = detect. */
  language?: string;
}

export interface Transcript {
  language: string;
  text: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  provider: string;
}

export interface SpeechProvider {
  readonly name: string;
  transcribe(input: SpeechInput): Promise<Transcript>;
  /** Transcribe then translate; the original transcript is always returned too. */
  translate(input: SpeechInput & { targetLanguage: string }): Promise<{
    original: Transcript;
    translation: { language: string; text: string };
    provider: string;
  }>;
}

export interface ClipCandidate {
  startMs: number;
  endMs: number;
  score: number;
  reason: string;
}
export interface SilenceRange {
  startMs: number;
  endMs: number;
}

/** Creator Studio seam (interface only). */
export interface MediaAiProvider {
  readonly name: string;
  transcribeForEditing(input: SpeechInput): Promise<Transcript>;
  detectSilence(input: {
    mediaId: string;
    userId: string;
    thresholdDb?: number;
  }): Promise<SilenceRange[]>;
  detectClips(input: {
    mediaId: string;
    userId: string;
    maxClips?: number;
  }): Promise<ClipCandidate[]>;
}
