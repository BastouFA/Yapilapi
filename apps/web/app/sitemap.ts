import type { MetadataRoute } from 'next';
import { LEGAL_DOCS, type PublicSitemap } from '@yapilapi/shared';
import { API_ORIGIN, siteOrigin } from '@/lib/public';

/** Rebuilt at most once an hour; the API caches its answer for as long. */
export const revalidate = 3600;

/**
 * The public pages, then what the API says search engines may index
 * (GET /v1/public/sitemap): public profiles, posts, tags, communities and
 * events from public adult accounts, following the public preview rules and
 * a little stricter (no subscriber-only, withheld or sensitive posts). If the
 * API can't be reached, the static pages are still listed.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const pages: MetadataRoute.Sitemap = [
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/signup`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${origin}/login`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/legal`, changeFrequency: 'monthly', priority: 0.3 },
    ...LEGAL_DOCS.map((d) => ({ url: `${origin}/legal/${d.slug}`, changeFrequency: 'monthly' as const, priority: 0.3 })),
  ];
  let data: PublicSitemap | null = null;
  try {
    const res = await fetch(`${API_ORIGIN}/v1/public/sitemap`, { next: { revalidate }, signal: AbortSignal.timeout(8000) });
    if (res.ok) data = (await res.json()) as PublicSitemap;
  } catch {
    data = null;
  }
  if (!data) return pages;
  const at = (s: string) => new Date(s);
  return [
    ...pages,
    ...data.profiles.map((p) => ({
      url: `${origin}/u/${encodeURIComponent(p.username)}`,
      lastModified: at(p.modified),
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
    ...data.communities.map((c) => ({
      url: `${origin}/c/${encodeURIComponent(c.slug)}`,
      lastModified: at(c.modified),
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
    ...data.events.map((e) => ({ url: `${origin}/events/${e.id}`, lastModified: at(e.modified), changeFrequency: 'weekly' as const, priority: 0.5 })),
    ...data.tags.map((t) => ({
      url: `${origin}/t/${encodeURIComponent(t.tag)}`,
      lastModified: at(t.modified),
      changeFrequency: 'daily' as const,
      priority: 0.4,
    })),
    ...data.posts.map((p) => ({ url: `${origin}/p/${p.id}`, lastModified: at(p.modified), changeFrequency: 'monthly' as const, priority: 0.4 })),
  ];
}
