import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/public';

/**
 * Shared links (posts, reels, profiles, events, communities, tags), their share
 * images and media stay crawlable so link previews work (some preview bots
 * respect robots.txt), and so do the legal pages. Signed-in areas, search
 * results, invite links and the API proxy aren't. What is listed for search
 * engines is in the sitemap (app/sitemap.ts).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/home',
        '/inbox',
        '/notifications',
        '/settings',
        '/studio',
        '/create',
        '/admin',
        '/assistant',
        '/onboarding',
        '/oauth/',
        '/memories',
        '/together',
        '/reset-password',
        '/verify-email',
        '/forgot-password',
        '/checkout',
        '/join/',
        '/search',
        '/drafts',
        '/saved',
        '/archive',
        '/camera',
        '/invite',
        '/find-friends',
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
