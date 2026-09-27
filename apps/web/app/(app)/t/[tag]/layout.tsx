import type { Metadata } from 'next';
import { normalizeTag } from '@yapilapi/shared';
import { siteOrigin } from '@/lib/public';
import { SITE_NAME } from '@/lib/metadata';

type Props = { params: Promise<{ tag: string }>; children: React.ReactNode };

/** A tag page is public: its title, canonical link and share card (opengraph-image) say which tag. */
export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const tag = normalizeTag(decodeURIComponent((await params).tag));
  const origin = await siteOrigin();
  const title = `#${tag}`;
  const description = `Posts, reels and stories tagged #${tag} on ${SITE_NAME}.`;
  const path = `/t/${encodeURIComponent(tag)}`;
  return {
    metadataBase: new URL(origin),
    title,
    description,
    alternates: { canonical: path },
    openGraph: { siteName: SITE_NAME, type: 'website', url: path, title: `${title} on ${SITE_NAME}`, description },
    twitter: { card: 'summary_large_image', title: `${title} on ${SITE_NAME}`, description },
  };
}

export default function TagLayout({ children }: Props) {
  return children;
}
