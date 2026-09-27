import type { MediaItem } from './types.ts';

/**
 * Data saver: 'off', 'on', or 'auto' (on by itself when the connection is slow
 * or metered, or when the browser asks to save data). Saved on the account so it
 * follows the person; each device may override it locally.
 */
export const DATA_SAVER_MODES = ['off', 'on', 'auto'] as const;
export type DataSaverMode = (typeof DATA_SAVER_MODES)[number];
// No zod here: the mobile app imports this file directly. The request schema is dataSaverSchema in schemas.ts.

/** What a device knows about its connection. Every field is optional: unknown means "not slow". */
export interface ConnectionHints {
  /** The browser or OS asks to save data (Save-Data, navigator.connection.saveData). */
  saveData?: boolean;
  /** navigator.connection.effectiveType: 'slow-2g' | '2g' | '3g' | '4g'. */
  effectiveType?: string | null;
  /** On a mobile network rather than Wi-Fi (native apps, when the platform says so). */
  cellular?: boolean;
}

/** Whether Data saver is on, from the chosen mode and what the device knows about its connection. */
export function dataSaverActive(mode: DataSaverMode, hints: ConnectionHints = {}): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !!hints.saveData || !!hints.cellular || ['slow-2g', '2g', '3g'].includes(hints.effectiveType ?? '');
}

/**
 * The address of a photo to show. With Data saver the small size comes first
 * (thumb, or medium when there is no thumb); `full` is the "Load full photo"
 * choice. Without Data saver: medium in grids, large on its own.
 */
export function imageSrc(m: Pick<MediaItem, 'url' | 'variants'>, opts: { saver?: boolean; full?: boolean; grid?: boolean } = {}): string {
  const v = m.variants ?? {};
  if (opts.saver && !opts.full) return v.thumb ?? v.medium ?? m.url;
  if (opts.grid) return v.medium ?? v.large ?? m.url;
  return v.large ?? v.medium ?? m.url;
}

/** The picture shown before a video plays: the small poster on Data saver. */
export function videoPoster(m: Pick<MediaItem, 'posterUrl' | 'variants'>, saver?: boolean): string | undefined {
  return (saver ? (m.variants?.thumb ?? m.posterUrl) : m.posterUrl) ?? undefined;
}

/** The 360p stream of a video: stored as a variant, or the first rung of its HLS ladder for videos processed before that. */
export function hls360(m: Pick<MediaItem, 'hlsUrl' | 'variants'>): string | null {
  if (m.variants?.hls_360) return m.variants.hls_360;
  return m.hlsUrl && /\/index\.m3u8$/.test(m.hlsUrl) ? m.hlsUrl.replace(/index\.m3u8$/, 'v0.m3u8') : null;
}

/** A plain video file to play: the lowest MP4 on Data saver, the web MP4 otherwise. */
export function videoSrc(m: Pick<MediaItem, 'url' | 'variants'>, saver?: boolean): string {
  const v = m.variants ?? {};
  return (saver ? (v.mp4_360 ?? v.mp4) : v.mp4) ?? m.url;
}

/**
 * The smallest size of an avatar. Avatars are uploaded photos whose processed
 * sizes sit next to them (name_thumb.webp); addresses from elsewhere are kept.
 * Show the original if the small one fails to load.
 */
export function smallAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^(.*\/media\/[\w/.-]+?)(?:_(?:medium|large))?\.(?:jpe?g|png|webp|gif|avif)$/i.exec(url);
  return m ? `${m[1]}_thumb.webp` : url;
}

/** A byte count for people: "820 KB", "4.2 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n < 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Photos are resized before upload on Data saver: longest side, and the JPEG/WebP quality. */
export const DATA_SAVER_UPLOAD = { maxSide: 1600, quality: 0.8 } as const;

/** The size a photo is resized to on Data saver (never enlarged). */
export function fitWithin(width: number, height: number, maxSide: number = DATA_SAVER_UPLOAD.maxSide): { width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
