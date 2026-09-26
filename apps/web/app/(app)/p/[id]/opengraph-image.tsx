import { OG_CONTENT_TYPE, OG_SIZE } from '@/lib/og';
import { postShareImage } from '@/lib/share-images';

export const alt = 'A post on YAPILAPI';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  return postShareImage((await params).id);
}
