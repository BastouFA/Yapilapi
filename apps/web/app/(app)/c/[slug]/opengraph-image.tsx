import { OG_CONTENT_TYPE, OG_SIZE } from '@/lib/og';
import { communityShareImage } from '@/lib/share-images';

export const alt = 'A community on YAPILAPI';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  return communityShareImage((await params).slug);
}
