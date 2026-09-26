import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/public';

/**
 * Shared links (posts, reels, profiles, events, communities), their share
 * images and media stay crawlable so link previews work (some preview bots
 * respect robots.txt). Signed-in areas and the API proxy aren't.
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
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
