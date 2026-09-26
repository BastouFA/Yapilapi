/**
 * Server-side reads of public previews (what anyone can see of a shared link
 * without an account). Used by generateMetadata, generated share images and
 * server pages. Never import this from a client component.
 */
import { headers } from 'next/headers';
import { cache } from 'react';
import { createClient } from '@yapilapi/api-client';
import type { PublicCommunityPreview, PublicEventPreview, PublicPostPreview, PublicProfilePreview } from '@yapilapi/shared';

/** Where the server reaches the API (the same origin next.config rewrites /api to). */
export const API_ORIGIN = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[A-Za-z0-9_.]{1,40}$/;
const SLUG = /^[A-Za-z0-9-]{1,40}$/;

/** The site's public origin: SITE_URL or WEB_ORIGIN when set, otherwise the host of this request. */
export async function siteOrigin(): Promise<string> {
  const configured = process.env.SITE_URL || process.env.WEB_ORIGIN?.split(',')[0];
  if (configured) return configured.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto.split(',')[0]}://${host.split(',')[0]}`;
}

/** Make a media URL absolute (the API may return /media/… paths, which the web app proxies). */
export function absolute(url: string | null | undefined, origin: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Pass on who is asking, so the API applies its per-visitor rate limit and
 * regional rules to the visitor rather than to this server.
 */
async function forwarded(): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = {};
  const ip = h.get('x-forwarded-for') ?? h.get('x-real-ip');
  if (ip) out['x-forwarded-for'] = ip;
  const country = process.env.TRUSTED_COUNTRY_HEADER?.toLowerCase();
  const value = country ? h.get(country) : null;
  if (country && value) out[country] = value;
  return out;
}

async function client() {
  const extra = await forwarded();
  return createClient({
    baseUrl: API_ORIGIN,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        // Each visitor's country can change the answer, and the API sets its own cache headers for CDNs.
        cache: 'no-store',
        headers: { ...(init?.headers as Record<string, string> | undefined), ...extra },
        signal: AbortSignal.timeout(4000),
      }),
  });
}

/** Resolve to null for anything that isn't public (or if the API can't be reached). */
async function orNull<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch {
    return null;
  }
}

export const getPublicPost = cache(async (id: string): Promise<PublicPostPreview | null> => {
  if (!UUID.test(id)) return null;
  return orNull(async () => (await (await client()).public.post(id)).post);
});

export const getPublicProfile = cache(async (username: string): Promise<PublicProfilePreview | null> => {
  const u = decodeURIComponent(username);
  if (!USERNAME.test(u)) return null;
  return orNull(async () => (await (await client()).public.user(u)).profile);
});

export const getPublicEvent = cache(async (id: string): Promise<PublicEventPreview | null> => {
  if (!UUID.test(id)) return null;
  return orNull(async () => (await (await client()).public.event(id)).event);
});

export const getPublicCommunity = cache(async (slug: string): Promise<PublicCommunityPreview | null> => {
  const s = decodeURIComponent(slug);
  if (!SLUG.test(s)) return null;
  return orNull(async () => (await (await client()).public.community(s)).community);
});
