import { youtubeWatchUrl } from '@yapilapi/shared';

/**
 * YouTube videos in watch together. Only the 11-character id is taken from what people paste
 * (packages/shared/src/watch.ts, youtubeIdFrom); the title and picture come from YouTube's public
 * oEmbed endpoint (no key), asked at a fixed address on YouTube's own host, never at an address
 * someone gave. Videos play in YouTube's own player (the privacy-enhanced youtube-nocookie.com
 * embed) on each device; nothing else from YouTube is stored.
 */

export type YouTubeInfo =
  | { ok: true; title: string | null; thumbnailUrl: string | null }
  /** 'not_embeddable': the owner doesn't let it play outside YouTube. 'unavailable': gone, private or never was. */
  | { ok: false; reason: 'not_embeddable' | 'unavailable' };

/** Looks a video up; null when YouTube couldn't be asked (the video is added without a title). */
export type YouTubeLookup = (videoId: string) => Promise<YouTubeInfo | null>;

const THUMB = /^https:\/\/i[0-9]?\.ytimg\.com\/[\w\-./]+$/;

export const oembedLookup: YouTubeLookup = async (videoId) => {
  let res: Response;
  try {
    res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeWatchUrl(videoId))}`, {
      signal: AbortSignal.timeout(4000),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'not_embeddable' };
  if (res.status === 400 || res.status === 404) return { ok: false, reason: 'unavailable' };
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { title?: unknown; thumbnail_url?: unknown } | null;
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 300) || null : null;
  const thumb = typeof body?.thumbnail_url === 'string' && THUMB.test(body.thumbnail_url) ? body.thumbnail_url : null;
  return { ok: true, title, thumbnailUrl: thumb };
};

let lookup: YouTubeLookup = oembedLookup;

/** The lookup in use (tests swap in their own, so nothing goes out to YouTube). */
export const youtubeLookup: YouTubeLookup = (videoId) => lookup(videoId);

/** For tests: answer lookups with `fn` (or YouTube's oEmbed again, without one). */
export function setYouTubeLookup(fn: YouTubeLookup | null): void {
  lookup = fn ?? oembedLookup;
}
