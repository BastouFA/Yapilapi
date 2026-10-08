/**
 * Yaps: voice posts of up to 60 seconds, voice replies and voice intros (docs/product/yaps.md).
 * Pure helpers and types, safe for the phone (no zod here; the schemas are in voice-schemas.ts).
 *
 * A Yap is a post with format 'yap' and kind 'audio' whose one media item is a voice clip. A clip
 * is recorded, sent to POST /v1/voice (the server measures it, stores it small and draws its
 * waveform), then attached once: to a Yap, to a comment (a voice reply) or to your profile (a
 * voice intro). Every clip gets a transcript when speech-to-text is set up.
 */

/** What a clip is for: a Yap, a voice reply under a post, or a profile's voice intro. */
export const VOICE_PURPOSES = ['yap', 'comment', 'intro'] as const;
export type VoicePurpose = (typeof VOICE_PURPOSES)[number];

/** A Yap or a voice reply: up to a minute. */
export const VOICE_MAX_MS = 60_000;
/** A voice intro on a profile: up to 15 seconds. */
export const VOICE_INTRO_MAX_MS = 15_000;
/** Shorter than a second is a slip of the finger, not a Yap. */
export const VOICE_MIN_MS = 1_000;
/** Recorders round a little: a clip this much over its limit still counts as within it. */
export const VOICE_SLACK_MS = 500;
/** The most a recording may weigh as sent by the app (the server stores it much smaller). */
export const VOICE_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** How many loudness bars a clip's waveform has. */
export const VOICE_PEAKS = 48;
/** Yaps one person may post in an hour. */
export const YAPS_PER_HOUR = 30;
/** Voice clips one person may record (upload) in an hour, for Yaps, replies and intros together. */
export const VOICE_CLIPS_PER_HOUR = 60;
/** The words that go with a Yap, under the player. */
export const YAP_TEXT_MAX = 280;
/** Playback speeds the player steps through. */
export const VOICE_RATES = [1, 1.5, 2] as const;
export type VoiceRate = (typeof VOICE_RATES)[number];
/** A listen this far through counts as finished. */
export const VOICE_COMPLETE_AT = 0.9;

/** The longest a clip may be for its purpose. */
export function voiceLimitMs(purpose: VoicePurpose): number {
  return purpose === 'intro' ? VOICE_INTRO_MAX_MS : VOICE_MAX_MS;
}

/**
 * A transcript's state:
 * - pending: being transcribed (a Yap waits for it before it's suggested to people who don't follow its author);
 * - ready: the words are there;
 * - unavailable: speech-to-text isn't set up ("Transcript not available");
 * - failed: it couldn't be made, or no words were heard.
 */
export const TRANSCRIPT_STATUSES = ['pending', 'ready', 'unavailable', 'failed'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/** One timed line of a transcript, in seconds from the start. */
export interface VoiceSegment {
  start: number;
  end: number;
  text: string;
}

export interface ClipTranscript {
  status: TranscriptStatus;
  /** The words (status 'ready' only). */
  text: string | null;
  /** The language they're in (ISO 639-1), when known. */
  lang: string | null;
  /** Timed lines, when the provider gave them. */
  segments: VoiceSegment[];
}

/** A recorded clip as the apps get it: on a Yap (Post.voice), a voice reply (Comment.voice) or an intro (Profile.voiceIntro). */
export interface VoiceClip {
  /** The media id; also what POST /v1/translations takes with kind 'voice'. */
  id: string;
  url: string;
  durationMs: number;
  /** Loudness bars from 0 to 100, evenly spaced over the clip (VOICE_PEAKS of them). */
  peaks: number[];
  transcript: ClipTranscript;
}

/** "0:07", "1:00". */
export function voiceClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The next speed after this one (1×, 1.5×, 2×, then 1× again). */
export function nextVoiceRate(rate: number): VoiceRate {
  const i = VOICE_RATES.findIndex((r) => r === rate);
  return VOICE_RATES[(i + 1) % VOICE_RATES.length]!;
}

/** A waveform redrawn with another number of bars (each the loudest of what it covers). */
export function resamplePeaks(peaks: readonly number[], bars: number): number[] {
  if (bars <= 0) return [];
  if (!peaks.length) return Array.from({ length: bars }, () => 0);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * peaks.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
    let max = 0;
    for (let j = from; j < to && j < peaks.length; j++) max = Math.max(max, peaks[j]!);
    out.push(max);
  }
  return out;
}

/**
 * Loudness bars (0 to 100) from raw samples between -1 and 1: the root mean square of each slice,
 * scaled so the loudest bar is 100 and quiet ones still show a little. The server draws stored
 * clips this way; the recorders use it for the live waveform.
 */
export function peaksFromSamples(samples: ArrayLike<number>, bars = VOICE_PEAKS): number[] {
  if (!samples.length) return Array.from({ length: bars }, () => 0);
  const rms: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * samples.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / bars));
    let sum = 0;
    for (let j = from; j < to && j < samples.length; j++) sum += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const loudest = Math.max(...rms);
  if (loudest <= 0.0005) return rms.map(() => 0);
  return rms.map((v) => Math.round(Math.min(100, Math.max(v > 0.0005 ? 4 : 0, (v / loudest) * 100))));
}

/** The transcript line being spoken at `seconds`, or -1. */
export function activeSegment(segments: readonly VoiceSegment[], seconds: number): number {
  for (let i = 0; i < segments.length; i++) if (seconds >= segments[i]!.start && seconds < segments[i]!.end) return i;
  return -1;
}

/** The time at a fraction of a clip, for scrubbing along the waveform (clamped to the clip). */
export function seekMs(fraction: number, durationMs: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * durationMs);
}

/** Whether a listen of `playedMs` (furthest point reached) counts as finishing the clip. */
export function listenFinished(playedMs: number, durationMs: number): boolean {
  return durationMs > 0 && playedMs >= durationMs * VOICE_COMPLETE_AT;
}
