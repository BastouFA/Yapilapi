/**
 * Page metadata (title, description, Open Graph, X cards) for shared links.
 * Built from public previews only, so a link to something that isn't public
 * gets the plain site card and says nothing about what's behind it.
 */
import type { Metadata } from 'next';
import {
  formatEventWhen,
  formatMoney,
  type MarketCondition,
  type PublicCommunityPreview,
  type PublicDropPreview,
  type PublicEventPreview,
  type PublicListingPreview,
  type PublicPostPreview,
  type PublicProfilePreview,
  voiceClock,
} from '@yapilapi/shared';
import { absolute, siteOrigin } from './public';
import { compact, plural } from './og';

export const SITE_NAME = 'YAPILAPI';
export const SITE_DESCRIPTION = 'Speak. The world understands. YAPILAPI is the social network you speak: hold to talk, and be heard in 24 languages.';
const SHORT_TITLE = 60;

function short(text: string, max = SHORT_TITLE): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** For links to things that aren't public (or don't exist): the site card, and not indexed. */
export async function privateMetadata(title: string): Promise<Metadata> {
  const origin = await siteOrigin();
  return {
    metadataBase: new URL(origin),
    title,
    description: SITE_DESCRIPTION,
    robots: { index: false, follow: false },
    openGraph: {
      siteName: SITE_NAME,
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
      type: 'website',
      images: [{ url: '/opengraph-image', width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', title: SITE_NAME, description: SITE_DESCRIPTION, images: ['/opengraph-image'] },
  };
}

function postWhat(p: PublicPostPreview): string {
  if (p.locked) return p.format === 'reel' ? 'A reel for subscribers' : p.format === 'yap' ? 'A Yap for subscribers' : 'A post for subscribers';
  if (p.format === 'reel') return 'A reel';
  if (p.format === 'yap') return 'A Yap';
  if (p.kind === 'photo' || p.kind === 'carousel') return 'A photo';
  if (p.kind === 'video') return 'A video';
  if (p.kind === 'poll') return 'A poll';
  return 'A post';
}

/**
 * A post or reel. `path` is the canonical link (/p/:id, or /reels?start=:id for reels opened in Reels).
 * /p/:id has its own generated share image (its opengraph-image file, which takes precedence), so
 * images are only set here when `withImages` is on: Reels points at the same card at /og/post/:id.
 * The card shows the photo or the video's poster frame beside the text, which crops well in every app.
 */
export async function postMetadata(p: PublicPostPreview, path: string, withImages = false): Promise<Metadata> {
  const origin = await siteOrigin();
  const name = p.author.displayName;
  const title = `${name} on ${SITE_NAME}`;
  // A Yap says how long it is and its first words: "A Yap by Ada (@ada), 0:42: “Good morning…”".
  const yap = p.format === 'yap' && p.voice && !p.locked ? p.voice : null;
  const description = yap
    ? `${postWhat(p)} by ${name} (@${p.author.username}), ${voiceClock(yap.durationMs)}${yap.words ? `: “${yap.words}”` : p.excerpt ? `: ${p.excerpt}` : '.'}`
    : p.excerpt || `${postWhat(p)} by ${name} (@${p.author.username}).`;
  const video = absolute(p.video?.url, origin);
  const images = withImages ? [{ url: `/og/post/${p.id}`, width: 1200, height: 630, alt: `${postWhat(p)} by ${name}` }] : undefined;
  return {
    metadataBase: new URL(origin),
    title: { absolute: p.excerpt || yap?.words ? `${title}: “${short(p.excerpt || yap!.words)}”` : title },
    description,
    alternates: { canonical: path },
    openGraph: {
      siteName: SITE_NAME,
      type: p.format === 'reel' || video ? 'video.other' : 'article',
      url: path,
      title,
      description,
      publishedTime: p.createdAt,
      authors: [`${origin}/u/${p.author.username}`],
      ...(images ? { images } : {}),
      ...(video
        ? {
            videos: [
              {
                url: video,
                secureUrl: video.startsWith('https:') ? video : undefined,
                type: 'video/mp4',
                width: p.video?.width ?? undefined,
                height: p.video?.height ?? undefined,
              },
            ],
          }
        : {}),
    },
    twitter: { card: 'summary_large_image', title, description, ...(images ? { images: images.map((i) => i.url) } : {}) },
  };
}

export async function profileMetadata(u: PublicProfilePreview): Promise<Metadata> {
  const origin = await siteOrigin();
  const title = `${u.displayName} (@${u.username})`;
  const counts = `${plural(u.counts.followers, 'follower', 'followers')} · ${plural(u.counts.posts, 'post', 'posts')}`;
  const description = u.bio ? `${u.bio} · ${counts}` : `See what ${u.displayName} shares on ${SITE_NAME}. ${counts}.`;
  const path = `/u/${u.username}`;
  return {
    metadataBase: new URL(origin),
    title: { absolute: `${title} on ${SITE_NAME}` },
    description,
    alternates: { canonical: path },
    openGraph: { siteName: SITE_NAME, type: 'profile', url: path, title, description, username: u.username },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export function eventWhen(e: PublicEventPreview): string {
  return formatEventWhen(e.startsAt, 'en', e.timezone);
}

export function eventWhere(e: PublicEventPreview): string {
  return e.online ? 'Online' : (e.place?.name ?? e.locationText ?? 'Location to be announced');
}

export async function eventMetadata(e: PublicEventPreview): Promise<Metadata> {
  const origin = await siteOrigin();
  const description = [`${eventWhen(e)} · ${eventWhere(e)}`, e.excerpt, `Hosted by ${e.host.displayName}.`].filter(Boolean).join(' · ');
  const path = `/events/${e.id}`;
  return {
    metadataBase: new URL(origin),
    title: e.title,
    description,
    alternates: { canonical: path },
    openGraph: { siteName: SITE_NAME, type: 'website', url: path, title: e.title, description },
    twitter: { card: 'summary_large_image', title: e.title, description },
  };
}

export async function communityMetadata(c: PublicCommunityPreview): Promise<Metadata> {
  const origin = await siteOrigin();
  const members = `${compact(c.memberCount)} ${c.memberCount === 1 ? 'member' : 'members'}`;
  const description = c.excerpt ? `${c.excerpt} · ${members}` : `A community on ${SITE_NAME} · ${members}`;
  const path = `/c/${c.slug}`;
  return {
    metadataBase: new URL(origin),
    title: c.name,
    description,
    alternates: { canonical: path },
    openGraph: { siteName: SITE_NAME, type: 'website', url: path, title: c.name, description },
    twitter: { card: 'summary_large_image', title: c.name, description },
  };
}

/** A drop's time for link previews: the full date and time in UTC, since a preview can't know the reader's time zone. */
export function dropWhen(d: PublicDropPreview): string {
  const when = formatEventWhen(d.startsAt, 'en', 'UTC');
  if (d.status === 'scheduled') return `Opens ${when}`;
  if (d.status === 'open') return 'Open now';
  return d.status === 'cancelled' ? 'Cancelled' : 'Ended';
}

export async function dropMetadata(d: PublicDropPreview): Promise<Metadata> {
  const origin = await siteOrigin();
  const title = `${d.title} · a drop by ${d.seller.displayName}`;
  const description = [dropWhen(d), d.excerpt, plural(d.itemCount, 'product', 'products')].filter(Boolean).join(' · ');
  const path = `/drops/${d.id}`;
  return {
    metadataBase: new URL(origin),
    title: { absolute: `${title} on ${SITE_NAME}` },
    description,
    alternates: { canonical: path },
    openGraph: { siteName: SITE_NAME, type: 'website', url: path, title, description },
    twitter: { card: 'summary_large_image', title, description },
  };
}

const CONDITION_WORDS: Record<MarketCondition, string> = { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair' };

/** A listing's price for link previews: the amount, or Free. */
export function listingPrice(l: PublicListingPreview): string {
  if (l.priceCents === null) return 'Free';
  try {
    return formatMoney(l.priceCents, l.currency, 'en');
  } catch {
    return `${(l.priceCents / 100).toFixed(2)} ${l.currency}`;
  }
}

/** A Market listing: its price, condition and area (never a place), with its first photo when it has one. */
export async function listingMetadata(l: PublicListingPreview): Promise<Metadata> {
  const origin = await siteOrigin();
  const title = `${l.title} · ${listingPrice(l)}`;
  const status = l.status === 'reserved' ? 'Reserved' : l.status === 'sold' ? 'Sold' : null;
  const description = [status, CONDITION_WORDS[l.condition], l.area, l.excerpt, l.seller ? `Sold by ${l.seller.displayName}` : 'On Market']
    .filter(Boolean)
    .join(' · ');
  const path = `/market/${l.id}`;
  const image = absolute(l.imageUrl, origin);
  const images = image ? [{ url: image, alt: l.title }] : [{ url: '/opengraph-image', width: 1200, height: 630 }];
  return {
    metadataBase: new URL(origin),
    title: { absolute: `${title} on ${SITE_NAME}` },
    description,
    alternates: { canonical: path },
    openGraph: { siteName: SITE_NAME, type: 'website', url: path, title, description, images },
    twitter: { card: 'summary_large_image', title, description, images: images.map((i) => i.url) },
  };
}
