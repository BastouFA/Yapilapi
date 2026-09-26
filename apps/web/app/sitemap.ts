import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/public';

/** The public, static pages. People and their content are never listed here. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  return [
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/signup`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${origin}/login`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
