import { ASPECT_RATIO, effectiveSegments, type Aspect, type Edl } from './edl.js';

/**
 * Turns an EDL into ffmpeg arguments (pure and unit tested; no process is started here). One `filter_complex` graph:
 * trim/atrim per kept segment -> concat -> optional aspect crop -> optional burned-in subtitles -> even-sized output.
 * The source file is only ever an INPUT; ffmpeg writes a new file.
 */
export interface SourceProbe {
  durationMs: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface CropRect {
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Largest centre-weighted window of the target aspect inside the source, with even dimensions (H.264 needs them). */
export function cropRect(srcW: number, srcH: number, aspect: Aspect, cropX = 0.5): CropRect {
  const r = ASPECT_RATIO[aspect];
  let w: number;
  let h: number;
  if (srcW / srcH > r) {
    h = srcH;
    w = Math.floor((srcH * r) / 2) * 2;
  } else {
    w = srcW;
    h = Math.floor(srcW / r / 2) * 2;
  }
  w = Math.max(2, Math.min(w, Math.floor(srcW / 2) * 2));
  h = Math.max(2, Math.min(h, Math.floor(srcH / 2) * 2));
  const x = Math.floor(((srcW - w) * Math.min(1, Math.max(0, cropX))) / 2) * 2;
  const y = Math.floor((srcH - h) / 2 / 2) * 2;
  return { w, h, x, y };
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

export interface RenderPlanInput {
  edl: Edl;
  source: SourceProbe;
  /** Absolute path of the SRT file to burn in (already re-timed to the output timeline); only used when the EDL asks for burn-in. */
  subtitlesPath?: string | undefined;
  inputPath: string;
  outputPath: string;
  /** Demuxer chosen from OUR sniffing (never from the file name), so a crafted container cannot pick another format. */
  demuxer?: string | undefined;
}

/** Escape a filesystem path for use inside an ffmpeg filter argument. */
export const filterPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/[:',[\];]/g, (c) => `\\${c}`);

export function buildRenderArgs(i: RenderPlanInput): { args: string[]; graph: string } {
  const segs = effectiveSegments(i.edl, i.source);
  const parts: string[] = [];
  const video = i.source.hasVideo;
  const audio = i.source.hasAudio;
  segs.forEach((s, n) => {
    if (video)
      parts.push(
        `[0:v:0]trim=start=${sec(s.startMs)}:end=${sec(s.endMs)},setpts=PTS-STARTPTS[v${n}]`,
      );
    if (audio)
      parts.push(
        `[0:a:0]atrim=start=${sec(s.startMs)}:end=${sec(s.endMs)},asetpts=PTS-STARTPTS[a${n}]`,
      );
  });
  const inputs = segs.map((_, n) => `${video ? `[v${n}]` : ''}${audio ? `[a${n}]` : ''}`).join('');
  parts.push(
    `${inputs}concat=n=${segs.length}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}${video ? '[vc]' : ''}${audio ? '[ac]' : ''}`,
  );
  if (video) {
    const chain: string[] = [];
    if (i.edl.aspect && i.source.width && i.source.height) {
      const c = cropRect(i.source.width, i.source.height, i.edl.aspect, i.edl.cropX);
      chain.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
    }
    if (i.edl.captions?.burnIn && i.subtitlesPath)
      chain.push(`subtitles=${filterPath(i.subtitlesPath)}`);
    // Never upscale; cap at 1080 lines; keep even dimensions.
    chain.push("scale=-2:'min(1080,ih)'");
    parts.push(`[vc]${chain.join(',')}[vout]`);
  }
  const graph = parts.join(';');
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    ...(i.demuxer ? ['-f', i.demuxer] : []),
    '-i',
    i.inputPath,
    '-filter_complex',
    graph,
  ];
  if (video)
    args.push(
      '-map',
      '[vout]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
    );
  if (audio) args.push('-map', '[ac]', '-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', '-sn', '-dn', i.outputPath);
  return { args, graph };
}

/** Args for one JPEG frame of a finished render (thumbnail). `atMs` is on the OUTPUT timeline. */
export const thumbnailArgs = (inputPath: string, atMs: number, outputPath: string): string[] => [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-protocol_whitelist',
  'file',
  '-ss',
  sec(atMs),
  '-i',
  inputPath,
  '-frames:v',
  '1',
  '-vf',
  "scale='min(1280,iw)':-2",
  '-q:v',
  '3',
  outputPath,
];

/** Args to measure silence. Output goes to stderr and is parsed by silence.ts. */
export const silenceDetectArgs = (
  inputPath: string,
  demuxer: string | undefined,
  noiseDb = -35,
  minSilenceSec = 0.6,
): string[] => [
  '-nostdin',
  '-hide_banner',
  '-nostats',
  '-protocol_whitelist',
  'file',
  ...(demuxer ? ['-f', demuxer] : []),
  '-i',
  inputPath,
  '-vn',
  '-af',
  `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
  '-f',
  'null',
  '-',
];
