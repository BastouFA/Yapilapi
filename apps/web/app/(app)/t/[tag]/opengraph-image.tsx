import { normalizeTag } from '@yapilapi/shared';
import { card, OG_CONTENT_TYPE, OG_SIZE, siteCard } from '@/lib/og';

export const alt = 'A hashtag on YAPILAPI';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** The tag's name only: nothing from the posts, so the card is the same for everyone. */
export default async function Image({ params }: { params: Promise<{ tag: string }> }) {
  const tag = normalizeTag(decodeURIComponent((await params).tag));
  if (tag.length < 2 || tag.length > 40) return siteCard();
  return card({ eyebrow: 'Hashtag', title: `#${tag}`, body: `Posts, reels and stories tagged #${tag}.` });
}
