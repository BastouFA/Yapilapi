/**
 * How the web records a voice (Yaps, voice replies and intros, voice messages, Hold to Yap): one
 * channel, with the browser's echo cancelling, noise suppression and level control, at a rate
 * that keeps a voice clear. The server cleans up and re-encodes what it keeps (lib/voice.ts).
 */

/** The microphone as a voice recording asks for it. */
export const VOICE_AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/** Bits a second the browser records a voice at. */
const VOICE_BITS_PER_SECOND = 96_000;

/**
 * Safari and every browser on an iPhone or iPad. They record MP4 (AAC) well; their WebM recorder
 * is newer and can hand back a file with nothing in it, so they record MP4.
 */
function webKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Safari\//.test(ua) && !/Chrom(e|ium)|Android|Edg\//.test(ua));
}

/** A recorder for a voice: MP4 on Safari and iPhones, else Opus in WebM, else whatever the browser records. */
export function voiceRecorder(stream: MediaStream): MediaRecorder {
  const order = webKit()
    ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = order.find((m) => MediaRecorder.isTypeSupported(m));
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITS_PER_SECOND });
}

/**
 * Starts recording. Other browsers hand over the sound every quarter second; Safari keeps it until
 * the end, so it writes one whole file instead of pieces whose length can come out as nothing.
 */
export function startVoiceRecorder(r: MediaRecorder) {
  if (webKit()) r.start();
  else r.start(250);
}

// ── Where the sound goes (Safari 17 and later) ──────────────────────────
// After the microphone has been used, an iPhone can keep sending sound to the earpiece, so a voice
// message seems not to play; with the ring switch on silent it may not play at all. Safari's
// navigator.audioSession says what the page is doing: recording, or playing out loud.

type SessionType = 'auto' | 'playback' | 'play-and-record';
const openMics = new Set<MediaStream>();

function setSession(type: SessionType) {
  try {
    const s = (navigator as Navigator & { audioSession?: { type: SessionType } }).audioSession;
    if (s && s.type !== type) s.type = type;
  } catch {
    // Not there, or not allowed right now: the browser's own routing stays.
  }
}

/** Opens the microphone for a voice recording. Close it with closeVoiceMic. */
export async function openVoiceMic(): Promise<MediaStream> {
  setSession('play-and-record');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_AUDIO });
    openMics.add(stream);
    return stream;
  } catch (e) {
    if (!openMics.size) setSession('auto');
    throw e;
  }
}

/** Stops a recording's microphone (safe to call more than once). */
export function closeVoiceMic(stream: MediaStream | null | undefined) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  openMics.delete(stream);
  if (!openMics.size) setSession('auto');
}

/**
 * Call just before a voice plays: on an iPhone it then comes out of the loudspeaker, also with
 * the ring switch on silent, like a voice message in other chat apps. Not while recording.
 */
export function playVoiceAloud() {
  if (!openMics.size) setSession('playback');
}
