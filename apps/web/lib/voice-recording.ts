/**
 * How the web records a voice (Yaps, voice replies and intros, voice messages, Hold to Yap): one
 * channel, with the browser's echo cancelling, noise suppression and level control, at a rate
 * that keeps a voice clear. The server cleans up and re-encodes what it keeps (lib/voice.ts).
 */

/** The microphone as a voice recording asks for it. */
export const VOICE_AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/** Bits a second the browser records a voice at. */
const VOICE_BITS_PER_SECOND = 96_000;

/** A recorder for a voice: Opus in WebM where the browser has it, else MP4 or whatever it records. */
export function voiceRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITS_PER_SECOND });
}
