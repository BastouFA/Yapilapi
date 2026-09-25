/**
 * Content sniffing by magic bytes. The client-supplied MIME type and file extension are NEVER trusted:
 * the stored type, the served Content-Type and the media kind all come from what the bytes actually are.
 * Pure functions, no I/O (unit tested).
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export interface Sniffed {
  kind: MediaKind;
  mime: string;
  ext: string;
}

/** Bytes needed to sniff every supported format. */
export const SNIFF_BYTES = 4096;

/** Hard per-kind size ceilings (bytes). Larger files must use the chunked / direct upload flow. */
export const MAX_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024,
};
/** Largest body accepted by the single-request multipart endpoint (it is buffered in memory). */
export const SIMPLE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

const ascii = (b: Uint8Array, start: number, len: number): string => {
  let s = '';
  for (let i = start; i < Math.min(b.length, start + len); i++) s += String.fromCharCode(b[i]!);
  return s;
};
const startsWith = (b: Uint8Array, sig: number[], offset = 0): boolean =>
  sig.every((v, i) => b[offset + i] === v);

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'dash',
  'msdh',
  'msix',
  'm4v ',
  'f4v ',
  'cmfc',
]);
const M4A_BRANDS = new Set(['m4a ', 'm4b ', 'f4a ']);

/** ISO-BMFF: `[size][ftyp][major brand][minor version][compatible brands...]`. */
function sniffIsoBmff(b: Uint8Array): Sniffed | null {
  if (ascii(b, 4, 4) !== 'ftyp') return null;
  const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  if (size < 16 || size > 4096) return null;
  const major = ascii(b, 8, 4).toLowerCase();
  const brands = [major];
  for (let o = 16; o + 4 <= Math.min(size, b.length); o += 4)
    brands.push(ascii(b, o, 4).toLowerCase());
  if (brands.some((x) => x === 'avif' || x === 'avis'))
    return { kind: 'image', mime: 'image/avif', ext: 'avif' };
  if (M4A_BRANDS.has(major)) return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
  if (major === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
  if (MP4_BRANDS.has(major)) return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  // Unknown major brand (e.g. HEIC, 3gp): only accept when a known compatible brand is present.
  if (brands.some((x) => MP4_BRANDS.has(x)))
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  return null;
}

/** Returns what the bytes are, or null when the type is not on the allowlist. */
export function sniffMedia(b: Uint8Array): Sniffed | null {
  if (b.length < 12) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  const head6 = ascii(b, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a')
    return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(b, 0, 4) === 'RIFF') {
    const form = ascii(b, 8, 4);
    if (form === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
    if (form === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
    return null;
  }
  const iso = sniffIsoBmff(b);
  if (iso) return iso;
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML: WebM is a Matroska profile; plain .mkv (doctype "matroska") is not allowlisted.
    return ascii(b, 0, Math.min(b.length, 64)).includes('webm')
      ? { kind: 'video', mime: 'video/webm', ext: 'webm' }
      : null;
  }
  if (ascii(b, 0, 4) === 'OggS') {
    // Ogg video (Theora) is not allowlisted; Vorbis/Opus/FLAC audio is.
    return ascii(b, 0, Math.min(b.length, 128)).includes('theora')
      ? null
      : { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
  }
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    const version = (b[1]! >> 3) & 3; // 01 = reserved
    const layer = (b[1]! >> 1) & 3; // 00 = reserved (ADTS AAC lands here)
    if (version !== 1 && layer !== 0 && ((b[2]! >> 4) & 0xf) !== 0xf)
      return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  }
  if (ascii(b, 0, 5) === '%PDF-') return { kind: 'file', mime: 'application/pdf', ext: 'pdf' };
  return null;
}

/** MIME types by stored extension, used when serving variants/captions. */
export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  vtt: 'text/vtt; charset=utf-8',
};

/** Kind implied by an allowlisted MIME label. Used only to REJECT contradictions, never to accept a file. */
export const KIND_BY_MIME: Record<string, MediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/x-m4a': 'audio',
  'application/pdf': 'file',
};
